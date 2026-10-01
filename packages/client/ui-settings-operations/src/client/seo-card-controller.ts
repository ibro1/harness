/**
 * The SEO employee card's staged form over the `seo-employee` settings
 * namespace, plus the Google connection status the Host reports. The OAuth
 * client secret and the Ads developer token are `role('secret')` fields: they
 * never ride a response, so the card writes them blind and learns only from
 * `/seo/status` whether they are in force.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScoutModelCatalogState } from './scout-model-catalog.ts'
import { fetchSeoStatus, postSeoAction, SEO_OAUTH_START_PATH, type SeoGoogleStatus, type SeoRequest } from './seo-sites-model.ts'

/**
 * Namespace of the SEO employee plugin, spelled here rather than imported: a
 * client package must not depend on a Host package.
 */
export const SEO_NS = 'seo-employee'

/** String fields, in the order the card shows them. */
export const SEO_STRING_FIELDS = [
  'shiftTime', 'timeZone', 'notifyTo', 'provider', 'model', 'fallbackProvider', 'fallbackModel', 'editorProvider', 'editorModel',
  'googleClientId', 'adsLoginCustomerId', 'adsCustomerId', 'adsApiVersion',
] as const
/** Whole-number fields, in the order the card shows them. */
export const SEO_NUMBER_FIELDS = ['fallbackCooldownMinutes', 'researchCacheDays', 'answerWaitHours'] as const
/** Write-only credentials. */
export const SEO_SECRET_FIELDS = ['googleClientSecret', 'adsDeveloperToken'] as const

/** Provider and model pairs the card sets through a model picker. */
export const SEO_MODEL_PAIRS = [
  { key: 'shiftModel', provider: 'provider', model: 'model' },
  { key: 'fallbackModelPick', provider: 'fallbackProvider', model: 'fallbackModel' },
  { key: 'editorModelPick', provider: 'editorProvider', model: 'editorModel' },
] as const

type SeoStringField = typeof SEO_STRING_FIELDS[number]
type SeoNumberField = typeof SEO_NUMBER_FIELDS[number]
type SeoSecretField = typeof SEO_SECRET_FIELDS[number]

/** The SEO employee fields this card edits. */
export type SeoSettings = Partial<Record<SeoStringField | SeoNumberField | SeoSecretField | 'enabled', unknown>>

/** The Google connection as the card renders it. */
export interface SeoGoogleState {
  status: (SeoGoogleStatus & { redirectUri: string }) | undefined
  failed: boolean
  /** The last disconnect's error, if it failed. */
  actionError: string | undefined
}

/** What the SEO employee card renders. */
export interface SeoCardState extends SettingsFormShell {
  enabled: SettingsFieldState
  strings: Record<SeoStringField, SettingsFieldState>
  numbers: Record<SeoNumberField, SettingsFieldState>
  secrets: Record<SeoSecretField, SettingsFieldState>
}

/** The registration-side face the card's slot entry injects. */
export interface SeoCardFace extends SettingsFormActions {
  /** Open the separate SEO sites page. */
  openSites: () => void
  /** Load the model catalog again after a failure. */
  retryModels: () => void
  /** Open Google's consent screen in a new window. */
  connectGoogle: () => void
  /** Forget the Google connection. */
  disconnectGoogle: () => void
  /** Read the Google status again. */
  refreshStatus: () => void
  hooks: {
    /** Card snapshot bound by the renderer as useSeoCard. */
    seoCard: SnapshotStore<SeoCardState>
    /** Model catalog bound by the renderer as useSeoModels. */
    seoModels: SnapshotStore<ScoutModelCatalogState>
    /** Google status bound by the renderer as useSeoGoogle. */
    seoGoogle: SnapshotStore<SeoGoogleState>
  }
}

/**
 * The on/off switch, staged as the text `true` or `false`.
 * @returns the field spec.
 */
function enabledField(): SettingsFieldSpec {
  return {
    field: 'enabled',
    format: value => value === true ? 'true' : 'false',
    parse: text => text === 'true' ? { kind: 'set', value: true } : text === 'false' ? { kind: 'set', value: false } : undefined,
  }
}

/** Bridges the `seo-employee` scope onto the card's staged form and the Google status. */
export class SeoCardController {
  private readonly form: SettingsFormModel<SeoSettings>
  private readonly store: SnapshotStore<SeoCardState>
  private readonly google = createSnapshotStore<SeoGoogleState>({ status: undefined, failed: false, actionError: undefined })

  /**
   * @param scope - the bound settings scope for the `seo-employee` namespace.
   * @param request - same-origin HTTP, injectable for tests.
   * @param openWindow - opens a URL in a new window, injectable for tests.
   */
  constructor(
    scope: SettingsFormScope<SeoSettings>,
    private readonly request: SeoRequest = (url, init) => fetch(url, init),
    private readonly openWindow: (url: string) => void = (url) => { window.open(url, 'seo-google-connect', 'popup,width=560,height=720') },
  ) {
    this.form = new SettingsFormModel(scope, [
      enabledField(),
      ...SEO_STRING_FIELDS.map(field => settingsTextField(field)),
      ...SEO_NUMBER_FIELDS.map(field => settingsNumberField(field)),
    ], SEO_SECRET_FIELDS.map(field => ({
      field,
      write: async (text: string) => {
        const accepted = await scope.mutate([{ op: 'set', path: [field], value: text.trim() }])
        this.refreshStatus()
        return accepted
      },
    })))
    const fields = <F extends string>(names: readonly F[]): Record<F, SettingsFieldState> =>
      Object.fromEntries(names.map(field => [field, this.form.field(field)])) as Record<F, SettingsFieldState>
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      strings: fields(SEO_STRING_FIELDS),
      numbers: fields(SEO_NUMBER_FIELDS),
      secrets: fields(SEO_SECRET_FIELDS),
    }))
  }

  /** Read the Google connection from `/seo/status`. */
  refreshStatus(): void {
    void (async () => {
      try {
        const status = await fetchSeoStatus(this.request)
        this.google.update((draft) => { draft.status = { ...status.google, redirectUri: status.redirectUri }; draft.failed = false })
      } catch {
        // The plugin is not loaded or the session expired: the card says the status is unknown.
        this.google.update((draft) => { draft.failed = true })
      }
    })()
  }

  /** Forget the Google connection, then read the status again. */
  disconnectGoogle(): void {
    void (async () => {
      const result = await postSeoAction(this.request, { action: 'disconnect-google' })
      this.google.update((draft) => { draft.actionError = result.ok ? undefined : result.error })
      this.refreshStatus()
    })()
  }

  /** Stop following the settings scope; the page is gone. */
  dispose(): void { this.form.dispose() }

  /**
   * Build the face the card's slot registration injects, reading the status as the page opens.
   * @param openSites - opens the sites page.
   * @param models - the model catalog the pickers offer.
   * @param retryModels - reloads that catalog.
   * @returns the card's snapshots and actions.
   */
  inject(openSites: () => void, models: SnapshotStore<ScoutModelCatalogState>, retryModels: () => void): SeoCardFace {
    this.refreshStatus()
    const actions = this.form.actions()
    return {
      hooks: { seoCard: this.store, seoModels: models, seoGoogle: this.google },
      ...actions,
      // The Host reads the new values as the commit lands; read the status once it has.
      save: () => { actions.save(); setTimeout(() => { this.refreshStatus() }, 1500) },
      openSites,
      retryModels,
      connectGoogle: () => { this.openWindow(SEO_OAUTH_START_PATH) },
      disconnectGoogle: () => { this.disconnectGoogle() },
      refreshStatus: () => { this.refreshStatus() },
    }
  }
}
