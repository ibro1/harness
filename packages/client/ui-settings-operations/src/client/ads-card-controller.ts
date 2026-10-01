/**
 * The ads employee card's staged form over the ads fields of the
 * `seo-employee` settings namespace, plus the Ads account the Host reports.
 * The SEO employee card edits the same namespace's other fields; each card
 * stages and writes only its own.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { fetchSeoStatus, type SeoGoogleStatus, type SeoRequest } from './seo-sites-model.ts'

/** On/off fields, with the value the Host's schema defaults to. */
export const ADS_SWITCH_FIELDS = [
  { field: 'adsEnabled', fallback: false },
  { field: 'adsRequireConversionTracking', fallback: true },
] as const
/** Spending limits: whole numbers in the Ads account's currency, in the order the card shows them. */
export const ADS_NUMBER_FIELDS = ['adsMonthlyCeiling', 'adsMaxDailyBudget', 'adsMaxCpc', 'adsMaxCostPerConversion'] as const

type AdsSwitchField = typeof ADS_SWITCH_FIELDS[number]['field']
type AdsNumberField = typeof ADS_NUMBER_FIELDS[number]

/** The ads employee fields this card edits. */
export type AdsSettings = Partial<Record<AdsSwitchField | AdsNumberField | 'adsShiftTime', unknown>>

/** The Ads account line as the card renders it. */
export interface AdsAccountState {
  account: SeoGoogleStatus['adsAccount'] | undefined
  failed: boolean
}

/** What the ads employee card renders. */
export interface AdsCardState extends SettingsFormShell {
  switches: Record<AdsSwitchField, SettingsFieldState>
  shiftTime: SettingsFieldState
  numbers: Record<AdsNumberField, SettingsFieldState>
}

/** The registration-side face the card's slot entry injects. */
export interface AdsCardFace extends SettingsFormActions {
  /** Open the separate Ads proposals page. */
  openProposals: () => void
  /** Read the Ads account again. */
  refreshStatus: () => void
  hooks: {
    /** Card snapshot bound by the renderer as useAdsCard. */
    adsCard: SnapshotStore<AdsCardState>
    /** Ads account bound by the renderer as useAdsAccount. */
    adsAccount: SnapshotStore<AdsAccountState>
  }
}

/**
 * A switch, staged as the text `true` or `false`.
 * @param field - field name inside the namespace section.
 * @param fallback - what an older Host that carries no value means.
 * @returns the field spec.
 */
function switchField(field: string, fallback: boolean): SettingsFieldSpec {
  return {
    field,
    format: value => (typeof value === 'boolean' ? value : fallback) ? 'true' : 'false',
    parse: text => text === 'true' ? { kind: 'set', value: true } : text === 'false' ? { kind: 'set', value: false } : undefined,
  }
}

/**
 * A whole number of currency units. An empty draft clears the field; a
 * fraction or a negative blocks the save, since the Host would refuse it.
 * @param field - field name inside the namespace section.
 * @returns the field spec.
 */
function wholeNumberField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      return /^\d+$/u.test(trimmed) ? { kind: 'set', value: Number(trimmed) } : undefined
    },
  }
}

/** Bridges the ads fields of the `seo-employee` scope onto the card's staged form and the Ads account line. */
export class AdsCardController {
  private readonly form: SettingsFormModel<AdsSettings>
  private readonly store: SnapshotStore<AdsCardState>
  private readonly account = createSnapshotStore<AdsAccountState>({ account: undefined, failed: false })

  /**
   * @param scope - the bound settings scope for the `seo-employee` namespace.
   * @param request - same-origin HTTP, injectable for tests.
   */
  constructor(
    scope: SettingsFormScope<AdsSettings>,
    private readonly request: SeoRequest = (url, init) => fetch(url, init),
  ) {
    this.form = new SettingsFormModel(scope, [
      ...ADS_SWITCH_FIELDS.map(({ field, fallback }) => switchField(field, fallback)),
      settingsTextField('adsShiftTime'),
      ...ADS_NUMBER_FIELDS.map(field => wholeNumberField(field)),
    ])
    const fields = <F extends string>(names: readonly F[]): Record<F, SettingsFieldState> =>
      Object.fromEntries(names.map(field => [field, this.form.field(field)])) as Record<F, SettingsFieldState>
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      switches: fields(ADS_SWITCH_FIELDS.map(spec => spec.field)),
      shiftTime: this.form.field('adsShiftTime'),
      numbers: fields(ADS_NUMBER_FIELDS),
    }))
  }

  /** Read the Ads account from `/seo/status`. */
  refreshStatus(): void {
    void (async () => {
      try {
        const status = await fetchSeoStatus(this.request)
        this.account.update((draft) => { draft.account = status.google.adsAccount; draft.failed = false })
      } catch {
        // The plugin is not loaded or the session expired: the card says the account is unknown.
        this.account.update((draft) => { draft.failed = true })
      }
    })()
  }

  /** Stop following the settings scope; the page is gone. */
  dispose(): void { this.form.dispose() }

  /**
   * Build the face the card's slot registration injects, reading the Ads account as the page opens.
   * @param openProposals - opens the proposals page.
   * @returns the card's snapshots and actions.
   */
  inject(openProposals: () => void): AdsCardFace {
    this.refreshStatus()
    return {
      hooks: { adsCard: this.store, adsAccount: this.account },
      ...this.form.actions(),
      openProposals,
      refreshStatus: () => { this.refreshStatus() },
    }
  }
}
