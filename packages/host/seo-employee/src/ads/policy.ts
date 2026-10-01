/**
 * The money rules of the ads employee, as pure functions so the code that
 * spends can be tested without Google. Every limit is the owner's setting;
 * a limit of zero means nothing may spend.
 */

import type { AdsCampaign, AdsCampaignSpec, AdsProposal } from '../store.ts'

/** The owner's limits, in the Ads account's currency (whole units, not micros). */
export interface AdsLimits {
  /** Most the employee's live campaigns may cost in a month, summed. 0 stops all spend. */
  monthlyCeiling: number
  /** Largest daily budget one campaign may have. */
  maxDailyBudget: number
  /** Largest cost one click may be bid. */
  maxCpc: number
  /** Whether enabling needs at least one enabled conversion action in the account. */
  requireConversionTracking: boolean
}

/** Average days in a month, as Google uses to turn a daily budget into a monthly charge. */
export const DAYS_PER_MONTH = 30.4

/** Micros per currency unit. */
export const MICROS = 1_000_000

/**
 * The monthly cost the employee's live campaigns could reach, at their daily budgets.
 * @param campaigns - the employee's campaigns.
 * @param extraDailyMicros - a daily budget about to be added or raised by.
 * @returns the projected monthly cost, in currency units.
 */
export function projectedMonthly(campaigns: readonly AdsCampaign[], extraDailyMicros = 0): number {
  const live = campaigns.filter(c => c.enabledAt !== undefined && c.paused === undefined)
  return ((live.reduce((sum, c) => sum + c.dailyBudgetMicros, 0) + extraDailyMicros) / MICROS) * DAYS_PER_MONTH
}

/**
 * Why a proposed campaign breaks the owner's limits, or nothing.
 * @param spec - the campaign.
 * @param limits - the owner's limits.
 * @returns each problem, plainly.
 */
export function campaignLimitProblems(spec: AdsCampaignSpec, limits: AdsLimits): string[] {
  const problems: string[] = []
  if (limits.monthlyCeiling <= 0) problems.push('The monthly spend ceiling is 0: the owner has not allowed any spend.')
  if (spec.dailyBudgetMicros / MICROS > limits.maxDailyBudget) {
    problems.push(`The daily budget ${String(spec.dailyBudgetMicros / MICROS)} is over the per-campaign limit of ${String(limits.maxDailyBudget)}.`)
  }
  if (spec.cpcCeilingMicros / MICROS > limits.maxCpc) {
    problems.push(`The click bid ceiling ${String(spec.cpcCeilingMicros / MICROS)} is over the limit of ${String(limits.maxCpc)}.`)
  }
  if (spec.keywords.length === 0) problems.push('A campaign needs keywords.')
  return problems
}

/**
 * Whether carrying out a proposal now would break the ceiling or the account's state.
 * @param proposal - the proposal.
 * @param campaigns - the employee's campaigns as they stand.
 * @param limits - the owner's limits.
 * @param account - the account's status and whether it tracks conversions.
 * @returns why it cannot go ahead, or nothing.
 */
export function approvalBlock(
  proposal: AdsProposal, campaigns: readonly AdsCampaign[], limits: AdsLimits,
  account: { status: string; conversionActions: number },
): string | undefined {
  if (account.status !== 'ENABLED') return `The Google Ads account is ${account.status.toLowerCase()}; nothing can run until it is active.`
  if (limits.requireConversionTracking && account.conversionActions === 0) {
    return 'The Ads account tracks no conversions (sign-ups, free-clip requests), so spend cannot be judged. Set up conversion tracking first, '
      + 'or turn off "Require conversion tracking" on the Ads employee page.'
  }
  let extra = 0
  if (proposal.kind === 'campaign') {
    if (proposal.campaign === undefined) return 'The proposal has no campaign.'
    const problems = campaignLimitProblems(proposal.campaign, limits)
    if (problems.length > 0) return problems.join(' ')
    extra = proposal.campaign.dailyBudgetMicros
  } else {
    const campaign = campaigns.find(c => c.resource === proposal.campaignResource)
    if (campaign === undefined) return 'The campaign is not one the ads employee runs.'
    if (proposal.kind === 'budget') {
      const next = proposal.newDailyBudgetMicros ?? 0
      if (next <= 0) return 'The new budget must be above 0.'
      if (next / MICROS > limits.maxDailyBudget) return `The new daily budget is over the per-campaign limit of ${String(limits.maxDailyBudget)}.`
      const live = campaign.enabledAt !== undefined && campaign.paused === undefined
      extra = live ? next - campaign.dailyBudgetMicros : 0
    } else {
      extra = campaign.dailyBudgetMicros
    }
  }
  if (limits.monthlyCeiling <= 0) return 'The monthly spend ceiling is 0: the owner has not allowed any spend.'
  const projected = projectedMonthly(campaigns, extra)
  if (projected > limits.monthlyCeiling) {
    return `With this, live campaigns could cost about ${projected.toFixed(0)} a month, over the ceiling of ${String(limits.monthlyCeiling)}.`
  }
  return undefined
}

/** One campaign's spend and results over a window. */
export interface CampaignResult {
  resource: string
  costMicros: number
  conversions: number
}

/**
 * Campaigns the watcher must pause: those that spent past the owner's cost per
 * conversion with nothing to show, or worse than it with some.
 * @param results - recent results of the employee's live campaigns.
 * @param maxCostPerConversion - the owner's limit in currency units; 0 turns the check off.
 * @returns each campaign to pause, with why.
 */
export function campaignsToPause(results: readonly CampaignResult[], maxCostPerConversion: number): { resource: string; reason: string }[] {
  if (maxCostPerConversion <= 0) return []
  return results.flatMap((r) => {
    const cost = r.costMicros / MICROS
    if (r.conversions === 0 && cost >= maxCostPerConversion) {
      return [{ resource: r.resource, reason: `spent ${cost.toFixed(0)} with no conversions (limit ${String(maxCostPerConversion)} per conversion)` }]
    }
    if (r.conversions > 0 && cost / r.conversions > maxCostPerConversion * 1.5) {
      return [{ resource: r.resource, reason: `cost ${(cost / r.conversions).toFixed(0)} per conversion, over 1.5 times the limit of ${String(maxCostPerConversion)}` }]
    }
    return []
  })
}
