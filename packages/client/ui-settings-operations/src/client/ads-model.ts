/**
 * The ads employee's part of `/seo/status` as the browser reads it, and the
 * pure helpers the proposals page renders with. The shapes are spelled here
 * rather than imported: a client package must not depend on a Host package.
 * Money arrives as micros of the Google Ads account's currency.
 */

/** Micros in one unit of the Ads account's currency. */
export const ADS_MICROS = 1_000_000

/** A search campaign as the ads employee proposes it. */
export interface AdsCampaignSpec {
  name: string
  dailyBudgetMicros: number
  cpcCeilingMicros: number
  /** Google Ads geo target ids; empty means worldwide. */
  geoIds: string[]
  languageId: string | undefined
  keywords: { text: string; match: 'EXACT' | 'PHRASE' }[]
  negatives: string[]
  ad: { finalUrl: string; headlines: string[]; descriptions: string[]; path1: string; path2: string }
}

/** Which change a proposal asks for. */
export type AdsProposalKind = 'campaign' | 'budget' | 'resume'
/** Where a proposal stands. */
export type AdsProposalStatus = 'proposed' | 'approved' | 'rejected' | 'failed'

/** One change that would spend money, waiting for the owner or decided. */
export interface AdsProposal {
  id: string
  siteId: string
  kind: AdsProposalKind
  status: AdsProposalStatus
  /** Why the employee proposes it, with the numbers it saw. */
  reason: string
  campaign: AdsCampaignSpec | undefined
  /** A budget change or resume: the campaign resource it acts on. */
  campaignResource: string | undefined
  newDailyBudgetMicros: number | undefined
  createdAt: string
  decidedAt: string | undefined
  /** What happened when it was carried out, or why it failed. */
  outcome: string | undefined
}

/** A campaign the ads employee created. */
export interface AdsCampaign {
  resource: string
  siteId: string
  customerId: string
  name: string
  dailyBudgetMicros: number
  createdAt: string
  /** Set once the campaign was turned on. */
  enabledAt: string | undefined
  /** Set when the employee or the watcher paused it, with why. */
  paused: { reason: string; at: string } | undefined
}

/** The `ads` part of `/seo/status`. */
export interface AdsStatus {
  /** Set while everything is paused; only the owner clears it. */
  paused: { reason: string; at: string } | null
  lastShiftDate: string | null
  /** Newest first. */
  proposals: AdsProposal[]
  campaigns: AdsCampaign[]
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const str = (value: unknown): string => typeof value === 'string' ? value : ''
const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const optional = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const optionalNum = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const pause = (value: unknown): { reason: string; at: string } | undefined =>
  value === null || value === undefined ? undefined : { reason: str(record(value)['reason']), at: str(record(value)['at']) }

/**
 * Read a proposed campaign.
 * @param raw - the campaign spec as the Host sent it.
 * @returns the spec with missing parts filled.
 */
function parseCampaignSpec(raw: unknown): AdsCampaignSpec {
  const spec = record(raw)
  const ad = record(spec['ad'])
  return {
    name: str(spec['name']),
    dailyBudgetMicros: num(spec['dailyBudgetMicros']),
    cpcCeilingMicros: num(spec['cpcCeilingMicros']),
    geoIds: list(spec['geoIds']).map(str).filter(id => id !== ''),
    languageId: optional(spec['languageId']),
    keywords: list(spec['keywords']).map((value) => {
      const keyword = record(value)
      return { text: str(keyword['text']), match: keyword['match'] === 'PHRASE' ? 'PHRASE' as const : 'EXACT' as const }
    }).filter(keyword => keyword.text !== ''),
    negatives: list(spec['negatives']).map(str).filter(text => text !== ''),
    ad: {
      finalUrl: str(ad['finalUrl']),
      headlines: list(ad['headlines']).map(str).filter(text => text !== ''),
      descriptions: list(ad['descriptions']).map(str).filter(text => text !== ''),
      path1: str(ad['path1']),
      path2: str(ad['path2']),
    },
  }
}

/**
 * Read the `ads` part of a `/seo/status` answer, filling what an older Host leaves out.
 * @param raw - the `ads` value.
 * @returns the ads employee's state.
 */
export function parseAdsStatus(raw: unknown): AdsStatus {
  const ads = record(raw)
  return {
    paused: pause(ads['paused']) ?? null,
    lastShiftDate: typeof ads['lastShiftDate'] === 'string' ? ads['lastShiftDate'] : null,
    proposals: list(ads['proposals']).map((value): AdsProposal => {
      const p = record(value)
      const kind = p['kind']
      const status = p['status']
      return {
        id: str(p['id']),
        siteId: str(p['siteId']),
        kind: kind === 'budget' || kind === 'resume' ? kind : 'campaign',
        status: status === 'approved' || status === 'rejected' || status === 'failed' ? status : 'proposed',
        reason: str(p['reason']),
        campaign: p['campaign'] === undefined || p['campaign'] === null ? undefined : parseCampaignSpec(p['campaign']),
        campaignResource: optional(p['campaignResource']),
        newDailyBudgetMicros: optionalNum(p['newDailyBudgetMicros']),
        createdAt: str(p['createdAt']),
        decidedAt: optional(p['decidedAt']),
        outcome: optional(p['outcome']),
      }
    }).filter(p => p.id !== ''),
    campaigns: list(ads['campaigns']).map((value): AdsCampaign => {
      const c = record(value)
      return {
        resource: str(c['resource']),
        siteId: str(c['siteId']),
        customerId: str(c['customerId']),
        name: str(c['name']),
        dailyBudgetMicros: num(c['dailyBudgetMicros']),
        createdAt: str(c['createdAt']),
        enabledAt: optional(c['enabledAt']),
        paused: pause(c['paused']),
      }
    }).filter(c => c.resource !== ''),
  }
}

/**
 * An amount in micros as whole units of the account's currency, grouped for reading.
 * @param micros - the amount in micros.
 * @returns the amount, with up to two decimals when it is not whole.
 */
export function formatAdsMoney(micros: number): string {
  return (micros / ADS_MICROS).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/**
 * The most an approval lets the account spend a day.
 * @param proposal - the proposal.
 * @param campaigns - the campaigns the employee runs, for a resume.
 * @returns the daily budget in micros, or undefined when it is not known.
 */
export function proposalDailyMicros(proposal: AdsProposal, campaigns: readonly AdsCampaign[]): number | undefined {
  switch (proposal.kind) {
    case 'campaign': return proposal.campaign?.dailyBudgetMicros
    case 'budget': return proposal.newDailyBudgetMicros
    case 'resume': return campaigns.find(c => c.resource === proposal.campaignResource)?.dailyBudgetMicros
  }
}
