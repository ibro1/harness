/**
 * The ads employee's tools. It may read results, propose campaigns and budget
 * changes, add negative keywords and pause a campaign: everything that saves
 * money it does itself, and everything that spends waits for the owner. No
 * tool here enables a campaign or raises a budget; only the owner's approval
 * does, through {@link carryOut}, which re-checks the limits at that moment.
 */

import { randomBytes } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ToolDefinition, ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { AdsAuth } from '../google/ads.ts'
import { articleStyleProblems } from '../quality/style.ts'
import type { AdsCampaign, AdsCampaignSpec, AdsProposal, SeoState, SeoStore } from '../store.ts'
import type { Site } from '../types.ts'
import {
  addNegativeKeywords, campaignReport, createSearchCampaign, getAccount, listConversionActions, searchTermReport,
  setCampaignStatus, setDailyBudget,
} from './api.ts'
import { approvalBlock, campaignLimitProblems, MICROS, projectedMonthly, type AdsLimits } from './policy.ts'

/** Everything the ads tools read or call, injectable for tests. */
export interface AdsDeps {
  store: SeoStore
  fetch: typeof fetch
  now: () => Date
  apiVersion: () => string
  limits: () => AdsLimits
  /** Keyword Planner's credentials and account for a site double as the account campaigns run in. */
  adsAuth: (site: Site, signal: AbortSignal) => Promise<(AdsAuth & { customerId: string }) | undefined>
  notify: (text: string) => Promise<string>
  /** The owner's page for deciding proposals. */
  proposalsLink: () => string
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string', required: true, description: 'What happened, as text.' } },
} as const satisfies ValueSchemaSpec

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter(v => v !== '') : []
}

function money(micros: number, currency: string): string {
  return `${(micros / MICROS).toLocaleString('en', { maximumFractionDigits: 2 })} ${currency}`
}

function findSite(state: SeoState, id: string): Site {
  const site = state.sites.find(s => s.id === id)
  if (site === undefined) throw new Error(`No site with id "${id}"; ads_status lists the sites.`)
  return site
}

function findCampaign(state: SeoState, ref: string): AdsCampaign {
  const campaign = (state.adsCampaigns ?? []).find(c => c.resource === ref || c.name === ref || c.resource.endsWith(`/${ref}`))
  if (campaign === undefined) throw new Error(`"${ref}" is not a campaign the ads employee runs; ads_status lists them.`)
  return campaign
}

/** Ad text must read like a person too: the article style tells apply to every headline and description. */
function adTextProblems(spec: AdsCampaignSpec, site: Site): string[] {
  const problems: string[] = []
  for (const text of [...spec.ad.headlines, ...spec.ad.descriptions]) {
    for (const p of articleStyleProblems(text)) problems.push(`"${text}": ${p.fix}`)
  }
  const avoid = site.profile.voice.split(/\n/u).flatMap(line => /^avoid:/iu.test(line.trim())
    ? line.replace(/^avoid:/iu, '').split(',').map(p => p.trim().toLowerCase()).filter(Boolean)
    : [])
  for (const text of [...spec.ad.headlines, ...spec.ad.descriptions]) {
    for (const phrase of avoid) if (text.toLowerCase().includes(phrase)) problems.push(`"${text}" uses "${phrase}", which the site's voice avoids.`)
  }
  if (new URL(spec.ad.finalUrl).origin !== new URL(site.baseUrl).origin) problems.push(`The ad must land on ${site.name} (${site.baseUrl}).`)
  return problems
}

/**
 * Carry out an approved proposal: re-check the account and the limits at this
 * moment, then create and enable the campaign, change the budget, or resume.
 * Called only from the owner's approval route.
 * @param deps - Google, the store and the limits.
 * @param proposalId - the proposal.
 * @param signal - cancels the calls.
 * @returns what happened.
 */
export async function carryOut(deps: AdsDeps, proposalId: string, signal: AbortSignal): Promise<string> {
  const state = await deps.store.read()
  const proposal = (state.adsProposals ?? []).find(p => p.id === proposalId)
  if (proposal === undefined) throw new Error('No such proposal.')
  if (proposal.status !== 'proposed') return `Already ${proposal.status}.`
  const site = findSite(state, proposal.siteId)
  const auth = await deps.adsAuth(site, signal)
  if (auth === undefined) throw new Error(`${site.name} has no Google Ads account to run in.`)
  const v = deps.apiVersion()
  const account = await getAccount(deps.fetch, auth, auth.customerId, signal, v)
  const conversions = (await listConversionActions(deps.fetch, auth, auth.customerId, signal, v)).filter(c => c.status === 'ENABLED').length
  const campaigns = state.adsCampaigns ?? []
  const blocked = approvalBlock(proposal, campaigns, deps.limits(), { status: account.status, conversionActions: conversions })
  const decide = async (status: AdsProposal['status'], outcome: string, change?: (s: SeoState) => void): Promise<string> => {
    await deps.store.update((s) => {
      const p = (s.adsProposals ?? []).find(x => x.id === proposalId)
      if (p !== undefined) { p.status = status; p.outcome = outcome; p.decidedAt = deps.now().toISOString() }
      change?.(s)
    })
    return outcome
  }
  if (blocked !== undefined) return decide('failed', `Not carried out: ${blocked}`)
  try {
    if (proposal.kind === 'campaign' && proposal.campaign !== undefined) {
      const spec = proposal.campaign
      const made = await createSearchCampaign(deps.fetch, auth, auth.customerId, spec, signal, v)
      await setCampaignStatus(deps.fetch, auth, auth.customerId, made.campaign, 'ENABLED', signal, v)
      const at = deps.now().toISOString()
      return await decide('approved', `Campaign "${spec.name}" is live at ${money(spec.dailyBudgetMicros, account.currencyCode)} a day.`, (s) => {
        s.adsCampaigns = [...s.adsCampaigns ?? [], {
          resource: made.campaign, budget: made.budget, adGroup: made.adGroup, siteId: site.id, customerId: auth.customerId,
          name: spec.name,
          dailyBudgetMicros: spec.dailyBudgetMicros, createdAt: at, enabledAt: at,
        }]
      })
    }
    const campaign = findCampaign(state, proposal.campaignResource ?? '')
    if (proposal.kind === 'budget') {
      const next = proposal.newDailyBudgetMicros ?? campaign.dailyBudgetMicros
      await setDailyBudget(deps.fetch, auth, auth.customerId, campaign.budget, next, signal, v)
      return await decide('approved', `"${campaign.name}" now has ${money(next, account.currencyCode)} a day.`, (s) => {
        const c = (s.adsCampaigns ?? []).find(x => x.resource === campaign.resource)
        if (c !== undefined) c.dailyBudgetMicros = next
      })
    }
    await setCampaignStatus(deps.fetch, auth, auth.customerId, campaign.resource, 'ENABLED', signal, v)
    return await decide('approved', `"${campaign.name}" is running again.`, (s) => {
      const c = (s.adsCampaigns ?? []).find(x => x.resource === campaign.resource)
      if (c !== undefined) { delete c.paused; c.enabledAt ??= deps.now().toISOString() }
    })
  } catch (error) {
    return decide('failed', `Google refused: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Build the ads employee's tools.
 * @param deps - the store, Google and the owner's limits.
 * @returns the tool definitions.
 */
export function buildAdsTools(deps: AdsDeps): ToolDefinition[] {
  const { store } = deps
  const iso = (): string => deps.now().toISOString()
  const siteParameter = { type: 'string', required: true, description: 'The site id, as ads_status lists it.' } as const
  const tool = (spec: {
    name: string
    description: string
    parameters: ParameterSchemaSpec
    run: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<string>
  }): ToolDefinition => defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: async (args, exec) => ({ text: await spec.run(args as Record<string, unknown>, exec) }),
    presentCall: () => ({ card: 'generic', title: spec.name.replace(/_/gu, ' '), kind: 'other', rawInput: '' }),
  })
  const refuseWhilePaused = (state: SeoState): void => {
    if (state.adsPaused) throw new Error(`The ads employee is paused (${state.adsPaused.reason}). Only the owner resumes it.`)
  }
  const authFor = async (site: Site, signal: AbortSignal): Promise<AdsAuth & { customerId: string }> => {
    const auth = await deps.adsAuth(site, signal)
    if (auth === undefined) throw new Error(`${site.name} reaches no active Google Ads account.`)
    return auth
  }

  return [
    tool({
      name: 'ads_status',
      description: 'Show the owner\'s spending limits, the Google Ads account (status, currency, whether conversions are tracked), the campaigns you run with the last 7 and 30 days of cost, clicks and conversions, and proposals waiting for the owner. Call it first.',
      parameters: {},
      run: async (_args, exec) => {
        const state = await store.read()
        const limits = deps.limits()
        const campaigns = state.adsCampaigns ?? []
        const lines = [
          state.adsPaused ? `PAUSED since ${state.adsPaused.at}: ${state.adsPaused.reason}. End the shift.` : 'Running.',
          `Owner's limits: monthly ceiling ${String(limits.monthlyCeiling)}, per-campaign daily budget ${String(limits.maxDailyBudget)}, click bid ceiling ${String(limits.maxCpc)}, conversion tracking ${limits.requireConversionTracking ? 'required' : 'not required'}.`,
          `Live campaigns could cost about ${projectedMonthly(campaigns).toFixed(0)} a month at their budgets.`,
        ]
        for (const site of state.sites.filter(s => s.enabled)) {
          const auth = await deps.adsAuth(site, exec.signal)
          lines.push('', `## ${site.name} (id ${site.id})`)
          if (auth === undefined) { lines.push('No active Google Ads account: nothing can run for this site.'); continue }
          const v = deps.apiVersion()
          const account = await getAccount(deps.fetch, auth, auth.customerId, exec.signal, v)
          const conversions = await listConversionActions(deps.fetch, auth, auth.customerId, exec.signal, v)
          lines.push(`Account ${auth.customerId} ${account.name}: ${account.status.toLowerCase()}, currency ${account.currencyCode}.`)
          lines.push(conversions.length === 0
            ? 'Conversions: none tracked. Spend cannot be judged; say so in every proposal.'
            : `Conversions tracked: ${conversions.map(c => `${c.name} (${c.status.toLowerCase()})`).join(', ')}.`)
          const mine = new Set(campaigns.filter(c => c.siteId === site.id).map(c => c.resource))
          for (const days of [7, 30]) {
            const report = await campaignReport(deps.fetch, auth, auth.customerId, days, exec.signal, v)
            const rows = report.filter(r => mine.has(r.resourceName))
            if (rows.length === 0) continue
            lines.push(`Last ${String(days)} days:`, ...rows.map(r =>
              `- ${r.name} [${r.status.toLowerCase()}] ${money(r.dailyBudgetMicros, account.currencyCode)}/day: cost ${money(r.costMicros, account.currencyCode)}, ${String(r.clicks)} clicks, ${String(r.impressions)} impressions, ${String(r.conversions)} conversions`))
          }
        }
        const waiting = (state.adsProposals ?? []).filter(p => p.status === 'proposed')
        if (waiting.length > 0) lines.push('', `Waiting for the owner: ${waiting.map(p => `${p.id} (${p.kind})`).join(', ')}.`)
        return lines.join('\n')
      },
    }),
    tool({
      name: 'ads_search_terms',
      description: 'The searches that triggered one of your campaigns over the last days, with cost, clicks and conversions. Use it to find terms to add as negatives.',
      parameters: {
        site_id: siteParameter,
        campaign: { type: 'string', required: true, description: 'The campaign name or resource, as ads_status shows it.' },
        days: { type: 'integer', description: '1 to 90; defaults to 14.' },
      },
      run: async (args, exec) => {
        const state = await store.read()
        const site = findSite(state, str(args['site_id']))
        const campaign = findCampaign(state, str(args['campaign']))
        const auth = await authFor(site, exec.signal)
        const days = Math.min(Math.max(typeof args['days'] === 'number' ? args['days'] : 14, 1), 90)
        const rows = await searchTermReport(deps.fetch, auth, auth.customerId, campaign.resource, days, exec.signal, deps.apiVersion())
        if (rows.length === 0) return `No search terms for "${campaign.name}" in ${String(days)} days.`
        return rows.toSorted((a, b) => b.costMicros - a.costMicros).slice(0, 60)
          .map(r => `- "${r.term}": cost ${(r.costMicros / MICROS).toFixed(2)}, ${String(r.clicks)} clicks, ${String(r.conversions)} conversions`).join('\n')
      },
    }),
    tool({
      name: 'ads_propose_campaign',
      description: 'Propose a Google Search campaign for the owner to approve: keywords (exact or phrase match), negatives, one responsive search ad (3 to 15 headlines of at most 30 characters, 2 to 4 descriptions of at most 90), a daily budget and a click bid ceiling within the owner\'s limits. Ad text follows the site\'s product facts and voice; nothing is created or spent until the owner approves it.',
      parameters: {
        site_id: siteParameter,
        name: { type: 'string', required: true, description: 'Campaign name, for example "Sermon clips NG".' },
        daily_budget: { type: 'number', required: true, description: 'Daily budget in the account currency (whole units).' },
        max_cpc: { type: 'number', required: true, description: 'Most one click may cost, in the account currency.' },
        market: { type: 'string', description: 'A market label of the site. Defaults to its first market.' },
        keywords: {
          type: 'array', required: true,
          items: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true }, match: { type: 'string', enum: ['EXACT', 'PHRASE'], required: true } } },
        },
        negatives: { type: 'array', items: { type: 'string' }, description: 'Searches to exclude, for example free, download, jobs.' },
        final_url: { type: 'string', required: true, description: 'The page on the site the ad sends people to.' },
        headlines: { type: 'array', items: { type: 'string' }, required: true },
        descriptions: { type: 'array', items: { type: 'string' }, required: true },
        reason: { type: 'string', required: true, description: 'Why this campaign, with the numbers you saw (Search Console, Keyword Planner bids and volumes).' },
      },
      run: async (args) => {
        const state = await store.read()
        refuseWhilePaused(state)
        const site = findSite(state, str(args['site_id']))
        const label = str(args['market'])
        const market = label === '' ? site.markets[0] : site.markets.find(m => m.label.toLowerCase() === label.toLowerCase())
        if (market === undefined) throw new Error(`${site.name} has no market "${label}".`)
        const keywords = Array.isArray(args['keywords'])
          ? args['keywords'].flatMap((k: unknown) => {
            if (typeof k !== 'object' || k === null) return []
            const row = k as Record<string, unknown>
            return [{ text: str(row['text']).toLowerCase(), match: row['match'] === 'EXACT' ? 'EXACT' as const : 'PHRASE' as const }]
          }).filter(k => k.text !== '')
          : []
        const spec: AdsCampaignSpec = {
          name: str(args['name']),
          dailyBudgetMicros: Math.round((typeof args['daily_budget'] === 'number' ? args['daily_budget'] : 0) * MICROS),
          cpcCeilingMicros: Math.round((typeof args['max_cpc'] === 'number' ? args['max_cpc'] : 0) * MICROS),
          geoIds: market.geoId === '' ? [] : [market.geoId],
          ...market.languageId === '' ? {} : { languageId: market.languageId },
          keywords,
          negatives: strings(args['negatives']).map(n => n.toLowerCase()),
          ad: { finalUrl: str(args['final_url']), headlines: strings(args['headlines']), descriptions: strings(args['descriptions']) },
        }
        if (spec.geoIds.length === 0) throw new Error('A campaign needs a country market; worldwide ads are not allowed.')
        if (spec.name === '') throw new Error('Give the campaign a name.')
        const problems = [...campaignLimitProblems(spec, deps.limits()), ...adTextProblems(spec, site)]
        if ((state.adsCampaigns ?? []).some(c => c.name === spec.name)) problems.push(`A campaign named "${spec.name}" exists.`)
        if (problems.length > 0) throw new Error(`The proposal is refused. Fix every one of these:\n${problems.map(p => `- ${p}`).join('\n')}`)
        const proposal: AdsProposal = {
          id: `p_${randomBytes(4).toString('hex')}`, siteId: site.id, kind: 'campaign', status: 'proposed', reason: str(args['reason']), campaign: spec, createdAt: iso(),
        }
        await store.update((s) => { s.adsProposals = [...s.adsProposals ?? [], proposal] })
        const told = await deps.notify([
          `Ads employee proposes a campaign for ${site.name}: "${spec.name}", ${String(spec.dailyBudgetMicros / MICROS)} a day, ${String(spec.keywords.length)} keywords.`,
          proposal.reason.slice(0, 300),
          `Nothing runs until you approve it: ${deps.proposalsLink()}`,
        ].join('\n'))
        return `Proposal ${proposal.id} saved and sent to the owner (${told}). It runs only after the owner approves.`
      },
    }),
    tool({
      name: 'ads_propose_budget',
      description: 'Propose a new daily budget for one of your campaigns, with the reason and numbers. A cut is safe but still goes to the owner; nothing changes until approved. To stop spend at once, use ads_pause_campaign instead.',
      parameters: {
        campaign: { type: 'string', required: true },
        daily_budget: { type: 'number', required: true, description: 'New daily budget in the account currency.' },
        reason: { type: 'string', required: true },
      },
      run: async (args) => {
        const state = await store.read()
        refuseWhilePaused(state)
        const campaign = findCampaign(state, str(args['campaign']))
        const next = Math.round((typeof args['daily_budget'] === 'number' ? args['daily_budget'] : 0) * MICROS)
        if (next <= 0) throw new Error('The budget must be above 0; to stop spend, pause the campaign.')
        if (next / MICROS > deps.limits().maxDailyBudget) throw new Error(`That is over the per-campaign limit of ${String(deps.limits().maxDailyBudget)}.`)
        const proposal: AdsProposal = {
          id: `p_${randomBytes(4).toString('hex')}`, siteId: campaign.siteId, kind: 'budget', status: 'proposed', reason: str(args['reason']),
          campaignResource: campaign.resource, newDailyBudgetMicros: next, createdAt: iso(),
        }
        await store.update((s) => { s.adsProposals = [...s.adsProposals ?? [], proposal] })
        const told = await deps.notify(`Ads employee proposes ${String(next / MICROS)} a day for "${campaign.name}" (now ${String(campaign.dailyBudgetMicros / MICROS)}). ${proposal.reason.slice(0, 200)}\nApprove or reject: ${deps.proposalsLink()}`)
        return `Proposal ${proposal.id} sent to the owner (${told}).`
      },
    }),
    tool({
      name: 'ads_propose_resume',
      description: 'Propose resuming a paused campaign, with why it should run again. The owner decides.',
      parameters: { campaign: { type: 'string', required: true }, reason: { type: 'string', required: true } },
      run: async (args) => {
        const state = await store.read()
        refuseWhilePaused(state)
        const campaign = findCampaign(state, str(args['campaign']))
        if (campaign.paused === undefined) throw new Error(`"${campaign.name}" is not paused.`)
        const proposal: AdsProposal = {
          id: `p_${randomBytes(4).toString('hex')}`, siteId: campaign.siteId, kind: 'resume', status: 'proposed', reason: str(args['reason']),
          campaignResource: campaign.resource, createdAt: iso(),
        }
        await store.update((s) => { s.adsProposals = [...s.adsProposals ?? [], proposal] })
        const told = await deps.notify(`Ads employee proposes resuming "${campaign.name}". ${proposal.reason.slice(0, 200)}\nApprove or reject: ${deps.proposalsLink()}`)
        return `Proposal ${proposal.id} sent to the owner (${told}).`
      },
    }),
    tool({
      name: 'ads_add_negatives',
      description: 'Add negative keywords (phrase match) to one of your campaigns, to stop paying for searches that do not fit. Takes effect at once; it only ever reduces spend.',
      parameters: { campaign: { type: 'string', required: true }, terms: { type: 'array', items: { type: 'string' }, required: true } },
      run: async (args, exec) => {
        const state = await store.read()
        const campaign = findCampaign(state, str(args['campaign']))
        const site = findSite(state, campaign.siteId)
        const terms = [...new Set(strings(args['terms']).map(t => t.toLowerCase()))].slice(0, 50)
        if (terms.length === 0) throw new Error('Give at least one term.')
        const auth = await authFor(site, exec.signal)
        await addNegativeKeywords(deps.fetch, auth, campaign.customerId, campaign.resource, terms, exec.signal, deps.apiVersion())
        return `Added ${String(terms.length)} negatives to "${campaign.name}": ${terms.join(', ')}.`
      },
    }),
    tool({
      name: 'ads_pause_campaign',
      description: 'Pause one of your campaigns at once and tell the owner why. Use it whenever a campaign wastes money, sends the wrong people, or anything looks wrong.',
      parameters: { campaign: { type: 'string', required: true }, reason: { type: 'string', required: true } },
      run: async (args, exec) => {
        const state = await store.read()
        const campaign = findCampaign(state, str(args['campaign']))
        const site = findSite(state, campaign.siteId)
        const reason = str(args['reason']) || 'no reason given'
        const auth = await authFor(site, exec.signal)
        await setCampaignStatus(deps.fetch, auth, campaign.customerId, campaign.resource, 'PAUSED', exec.signal, deps.apiVersion())
        await store.update((s) => {
          const c = (s.adsCampaigns ?? []).find(x => x.resource === campaign.resource)
          if (c !== undefined) c.paused = { reason, at: iso() }
        })
        const told = await deps.notify(`Ads employee paused "${campaign.name}": ${reason}`)
        return `Paused "${campaign.name}". Owner: ${told}.`
      },
    }),
  ]
}
