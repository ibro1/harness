/**
 * The TikTok Shop employee card's staged form over the `tiktok-shop-employee`
 * settings namespace, plus the Host's status (`/tts/status`): today's videos,
 * the pause switch, which keys are in force, and the recent videos with their
 * review links. The SocialCrawl and Groq keys are `role('secret')` fields,
 * written blind.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScoutModelCatalogState } from './scout-model-catalog.ts'

/** Namespace of the TikTok Shop employee plugin; a client package must not import a Host package. */
export const TTS_NS = 'tiktok-shop-employee'

/** String fields, in the order the card shows them. */
export const TTS_STRING_FIELDS = ['shiftTime', 'timeZone', 'notifyTo', 'provider', 'model', 'fallbackProvider', 'fallbackModel', 'region', 'directSearchUrl', 'directProductUrl', 'voiceProvider', 'voice', 'groqVoice', 'voiceStyle'] as const
/** Whole-number fields. */
export const TTS_NUMBER_FIELDS = ['videosPerDay', 'fallbackCooldownMinutes'] as const
/** One-per-line list fields. */
export const TTS_LIST_FIELDS = ['themes', 'blockedWords'] as const
/** Write-only keys. */
export const TTS_SECRET_FIELDS = ['socialCrawlApiKey', 'directProxy', 'groqApiKey'] as const
/** Provider and model pairs set through a model picker. */
export const TTS_MODEL_PAIRS = [
  { key: 'shiftModel', provider: 'provider', model: 'model' },
  { key: 'fallbackModelPick', provider: 'fallbackProvider', model: 'fallbackModel' },
] as const

type StringField = typeof TTS_STRING_FIELDS[number]
type NumberField = typeof TTS_NUMBER_FIELDS[number]
type ListField = typeof TTS_LIST_FIELDS[number]
type SecretField = typeof TTS_SECRET_FIELDS[number]

/** The fields this card edits. */
export type TtsSettings = Partial<Record<StringField | NumberField | ListField | SecretField | 'enabled', unknown>>

/** One recent video, as `/tts/status` lists it. */
export interface TtsVideoRow {
  id: string
  status: 'rendering' | 'failed' | 'ready' | 'posted' | 'skipped'
  format: string
  hook: string
  product: string
  createdAt: string
  error?: string
  results?: { views?: number; sales?: number }
  review: string
}

/** `/tts/status`. */
export interface TtsStatus {
  date: string
  today: number
  cap: number
  paused: { reason: string } | null
  lastShiftDate: string | null
  dataKey: boolean
  /** Where the SocialCrawl key comes from; absent on older Hosts. */
  dataKeySource?: 'settings' | 'environment' | 'none'
  /** Whether a proxy is set, so TikTok is read directly first. */
  proxy?: boolean
  groqKey: boolean
  /** How many Gemini and Groq keys the deployment gives the voice. */
  voiceKeys?: { gemini: number; groq: number }
  products: number
  videos: TtsVideoRow[]
}

/** The status block's state. */
export interface TtsLiveState {
  status: TtsStatus | undefined
  failed: boolean
  /** Set briefly after "Run a shift now". */
  started: boolean
}

/** What the card renders. */
export interface TtsCardState extends SettingsFormShell {
  enabled: SettingsFieldState
  strings: Record<StringField, SettingsFieldState>
  numbers: Record<NumberField, SettingsFieldState>
  lists: Record<ListField, SettingsFieldState>
  secrets: Record<SecretField, SettingsFieldState>
}

/** The face the card's slot entry injects. */
export interface TtsCardFace extends SettingsFormActions {
  retryModels: () => void
  refreshStatus: () => void
  /** Start a shift now instead of waiting for the shift time. */
  runNow: () => void
  pause: () => void
  resume: () => void
  hooks: {
    /** Bound as useTtsCard. */
    ttsCard: SnapshotStore<TtsCardState>
    /** Bound as useTtsModels. */
    ttsModels: SnapshotStore<ScoutModelCatalogState>
    /** Bound as useTtsLive. */
    ttsLive: SnapshotStore<TtsLiveState>
  }
}

function enabledField(): SettingsFieldSpec {
  return {
    field: 'enabled',
    format: value => value === true ? 'true' : 'false',
    parse: text => text === 'true' ? { kind: 'set', value: true } : text === 'false' ? { kind: 'set', value: false } : undefined,
  }
}

function listField(field: ListField): SettingsFieldSpec {
  return {
    field,
    format: value => Array.isArray(value) ? value.filter(v => typeof v === 'string').join('\n') : '',
    parse: (text) => {
      const items = text.split('\n').map(line => line.trim()).filter(line => line !== '')
      return items.length === 0 ? { kind: 'clear' } : { kind: 'set', value: items }
    },
  }
}

/** Bridges the settings scope onto the card, and reads the Host's status. */
export class TtsCardController {
  private readonly form: SettingsFormModel<TtsSettings>
  private readonly store: SnapshotStore<TtsCardState>
  private readonly live = createSnapshotStore<TtsLiveState>({ status: undefined, failed: false, started: false })

  /**
   * @param scope - the bound settings scope.
   * @param request - same-origin HTTP, injectable for tests.
   */
  constructor(
    scope: SettingsFormScope<TtsSettings>,
    private readonly request: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {
    this.form = new SettingsFormModel(scope, [
      enabledField(),
      ...TTS_STRING_FIELDS.map(field => settingsTextField(field)),
      ...TTS_NUMBER_FIELDS.map(field => settingsNumberField(field)),
      ...TTS_LIST_FIELDS.map(field => listField(field)),
    ], TTS_SECRET_FIELDS.map(field => ({
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
      strings: fields(TTS_STRING_FIELDS),
      numbers: fields(TTS_NUMBER_FIELDS),
      lists: fields(TTS_LIST_FIELDS),
      secrets: fields(TTS_SECRET_FIELDS),
    }))
  }

  /** Read `/tts/status`. */
  refreshStatus(): void {
    void (async () => {
      try {
        const response = await this.request('/tts/status', { cache: 'no-store', credentials: 'same-origin' })
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        const status = await response.json() as TtsStatus
        this.live.update((draft) => { draft.status = status; draft.failed = false })
      } catch {
        // The plugin is not loaded or the sign-in expired: the card says the status is unknown.
        this.live.update((draft) => { draft.failed = true })
      }
    })()
  }

  private act(action: 'pause' | 'resume' | 'run-now'): void {
    void (async () => {
      await this.request('/tts/action', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      }).catch(() => undefined)
      if (action === 'run-now') this.live.update((draft) => { draft.started = true })
      this.refreshStatus()
    })()
  }

  /** Stop following the settings scope; the page is gone. */
  dispose(): void { this.form.dispose() }

  /**
   * Build the face the card's slot registration injects, reading the status as the page opens.
   * @param models - the model catalog the pickers offer.
   * @param retryModels - reloads that catalog.
   * @returns the card's snapshots and actions.
   */
  inject(models: SnapshotStore<ScoutModelCatalogState>, retryModels: () => void): TtsCardFace {
    this.refreshStatus()
    const actions = this.form.actions()
    return {
      hooks: { ttsCard: this.store, ttsModels: models, ttsLive: this.live },
      ...actions,
      save: () => { actions.save(); setTimeout(() => { this.refreshStatus() }, 1500) },
      retryModels,
      refreshStatus: () => { this.refreshStatus() },
      runNow: () => { this.act('run-now') },
      pause: () => { this.act('pause') },
      resume: () => { this.act('resume') },
    }
  }
}
