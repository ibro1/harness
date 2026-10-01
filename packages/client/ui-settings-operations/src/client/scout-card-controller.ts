/** The Klipara Scout card's staged form over the `klipara-scout` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ScoutModelCatalogState } from './scout-model-catalog.ts'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Namespace of the Klipara Scout plugin, spelled here rather than imported: a
 * client package must not depend on a Host package.
 */
export const SCOUT_NS = 'klipara-scout'

/** Text fields, in the order the card shows them. */
export const SCOUT_TEXT_FIELDS = [
  'shiftTime', 'timeZone', 'kliparaApiKey', 'notifyTo', 'outreachBrowser', 'provider', 'model', 'fallbackProvider', 'fallbackModel', 'podcastCountry', 'sampleBaseUrl', 'sampleHeadline', 'sampleNote',
] as const
/** Whole-number fields, in the order the card shows them. */
export const SCOUT_NUMBER_FIELDS = ['samplesPerDay', 'pitchesPerDay', 'replyCheckMinutes', 'fallbackCooldownMinutes', 'podcastActiveDays', 'sampleTtlDays', 'minSubscribers', 'maxSubscribers', 'maxShorts'] as const

/** On/off fields, in the order the card shows them. */
export const SCOUT_SWITCH_FIELDS = ['enabled', 'fallbackPitches'] as const

/** Provider and model pairs the card sets through a model picker rather than as text. */
export const SCOUT_MODEL_PAIRS = [
  { key: 'shiftModel', provider: 'provider', model: 'model' },
  { key: 'fallbackModelPick', provider: 'fallbackProvider', model: 'fallbackModel' },
] as const
/** The API key, shown masked. */
export const SCOUT_KEY_FIELD = 'kliparaApiKey'
/** The free-clip hand-off secret: `role('secret')`, so it never rides a response and is written blind. */
export const SCOUT_FREE_CLIP_SECRET_FIELD = 'freeClipSecret'

/** The Host route that says whether a hand-off secret is in force, and where Klipara posts. */
const FREE_CLIP_STATUS_PATH = '/scout/inbound/status'

/** The hand-off as the Host reports it; never the secret. */
export interface FreeClipHandOff {
  source: 'environment' | 'settings' | 'none'
  /** Route path on this site. */
  path: string
  /** Absolute address to paste into Klipara, when the Host knows its public origin. */
  url: string | null
}

/** The hand-off status the card renders. */
export interface FreeClipHandOffState {
  status: FreeClipHandOff | undefined
  failed: boolean
}

type ScoutTextField = typeof SCOUT_TEXT_FIELDS[number]
type ScoutSwitchField = typeof SCOUT_SWITCH_FIELDS[number]
type ScoutNumberField = typeof SCOUT_NUMBER_FIELDS[number]

/** The Klipara Scout fields this card edits. */
export type ScoutSettings = Partial<Record<ScoutTextField | ScoutNumberField | ScoutSwitchField | 'topics' | typeof SCOUT_FREE_CLIP_SECRET_FIELD, unknown>>

/** What the Klipara Scout card renders. */
export interface ScoutCardState extends SettingsFormShell {
  switches: Record<ScoutSwitchField, SettingsFieldState>
  topics: SettingsFieldState
  text: Record<ScoutTextField, SettingsFieldState>
  numbers: Record<ScoutNumberField, SettingsFieldState>
  freeClipSecret: SettingsFieldState
}

/** The registration-side face the card's slot entry injects. */
export interface ScoutCardFace extends SettingsFormActions {
  /** Open the separate Klipara Scout leads page. */
  openLeads: () => void
  /** Load the model catalog again after a failure. */
  retryModels: () => void
  /** Remove the saved hand-off secret; Klipara's requests are refused until another is saved. */
  removeFreeClipSecret: () => void
  hooks: {
    /** Card snapshot bound by the renderer as useScoutCard. */
    scoutCard: SnapshotStore<ScoutCardState>
    /** Model catalog bound by the renderer as useScoutModels. */
    scoutModels: SnapshotStore<ScoutModelCatalogState>
    /** Hand-off status bound by the renderer as useScoutHandOff. */
    scoutHandOff: SnapshotStore<FreeClipHandOffState>
  }
}

/**
 * An on/off switch, staged as the text `true` or `false`.
 * @param field - the setting.
 * @returns the field spec.
 */
function switchField(field: ScoutSwitchField): SettingsFieldSpec {
  return {
    field,
    format: value => value === true ? 'true' : 'false',
    parse: text => text === 'true' ? { kind: 'set', value: true } : text === 'false' ? { kind: 'set', value: false } : undefined,
  }
}

/**
 * The search topics, one per line.
 * @returns the field spec.
 */
function topicsField(): SettingsFieldSpec {
  return {
    field: 'topics',
    format: value => Array.isArray(value) ? value.filter(v => typeof v === 'string').join('\n') : '',
    parse: (text) => {
      const topics = text.split('\n').map(line => line.trim()).filter(line => line !== '')
      return topics.length === 0 ? { kind: 'clear' } : { kind: 'set', value: topics }
    },
  }
}

/** Bridges the `klipara-scout` scope onto the card's staged form. */
export class ScoutCardController {
  private readonly form: SettingsFormModel<ScoutSettings>
  private readonly store: SnapshotStore<ScoutCardState>
  private readonly handOff = createSnapshotStore<FreeClipHandOffState>({ status: undefined, failed: false })

  /**
   * @param scope - the bound settings scope for the `klipara-scout` namespace.
   * @param request - same-origin HTTP, injectable for tests.
   */
  constructor(
    private readonly scope: SettingsFormScope<ScoutSettings>,
    private readonly request: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {
    this.form = new SettingsFormModel(scope, [
      ...SCOUT_SWITCH_FIELDS.map(field => switchField(field)),
      topicsField(),
      ...SCOUT_TEXT_FIELDS.map(field => settingsTextField(field)),
      ...SCOUT_NUMBER_FIELDS.map(field => settingsNumberField(field)),
    ], [{
      field: SCOUT_FREE_CLIP_SECRET_FIELD,
      write: async (text) => {
        const accepted = await scope.mutate([{ op: 'set', path: [SCOUT_FREE_CLIP_SECRET_FIELD], value: text.trim() }])
        this.refreshHandOff()
        return accepted
      },
    }])
    this.store = this.form.bind(() => this.projection())
  }

  /** Read whether a hand-off secret is in force. */
  refreshHandOff(): void {
    void (async () => {
      try {
        const response = await this.request(FREE_CLIP_STATUS_PATH, { cache: 'no-store', credentials: 'same-origin' })
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        const status = await response.json() as FreeClipHandOff
        this.handOff.update((draft) => { draft.status = status; draft.failed = false })
      } catch {
        // An older Host without the hand-off, or an expired session: the card says the status is unknown.
        this.handOff.update((draft) => { draft.failed = true })
      }
    })()
  }

  /** Remove the saved hand-off secret. */
  removeFreeClipSecret(): void {
    void (async () => {
      await this.scope.mutate([{ op: 'unset', path: [SCOUT_FREE_CLIP_SECRET_FIELD] }])
      this.refreshHandOff()
    })()
  }

  private projection(): ScoutCardState {
    return {
      ...this.form.shell(),
      switches: Object.fromEntries(SCOUT_SWITCH_FIELDS.map(field => [field, this.form.field(field)])) as
        Record<ScoutSwitchField, SettingsFieldState>,
      topics: this.form.field('topics'),
      text: Object.fromEntries(SCOUT_TEXT_FIELDS.map(field => [field, this.form.field(field)])) as
        Record<ScoutTextField, SettingsFieldState>,
      numbers: Object.fromEntries(SCOUT_NUMBER_FIELDS.map(field => [field, this.form.field(field)])) as
        Record<ScoutNumberField, SettingsFieldState>,
      freeClipSecret: this.form.field(SCOUT_FREE_CLIP_SECRET_FIELD),
    }
  }

  /** Stop following the settings scope; the page is gone. */
  dispose(): void { this.form.dispose() }

  /**
   * Build the face the card's slot registration injects.
   * @param openLeads - opens the leads page.
   * @param models - the model catalog the pickers offer.
   * @param retryModels - reloads that catalog.
   * @returns the card's snapshot, its form actions, the catalog, the hand-off status and the leads link.
   */
  inject(openLeads: () => void, models: SnapshotStore<ScoutModelCatalogState>, retryModels: () => void): ScoutCardFace {
    this.refreshHandOff()
    return {
      hooks: { scoutCard: this.store, scoutModels: models, scoutHandOff: this.handOff },
      ...this.form.actions(),
      openLeads,
      retryModels,
      removeFreeClipSecret: () => { this.removeFreeClipSecret() },
    }
  }
}
