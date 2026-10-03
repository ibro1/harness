/**
 * The YouTube niche scout card's staged form over the `youtube-niche-scout`
 * settings namespace, plus the Host's status (`/yns/status`): the schedule,
 * the API key's source, today's quota, the current run and the latest report
 * with its link. The YouTube key is a `role('secret')` field, written blind.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScoutModelCatalogState } from './scout-model-catalog.ts'

/** Namespace of the YouTube niche scout plugin; a client package must not import a Host package. */
export const YNS_NS = 'youtube-niche-scout'

/** String fields. */
export const YNS_STRING_FIELDS = ['weekday', 'shiftTime', 'timeZone', 'notifyTo', 'provider', 'model', 'fallbackProvider', 'fallbackModel'] as const
/** Whole-number fields, in the order the card shows them. */
export const YNS_NUMBER_FIELDS = ['searchesPerRun', 'dailyQuota', 'windowDays', 'maxChannelAgeMonths', 'cacheDays', 'fallbackCooldownMinutes'] as const
/** List fields, edited one row per item. */
export const YNS_LIST_FIELDS = ['seedTopics', 'markets', 'languages'] as const
/** Write-only keys. */
export const YNS_SECRET_FIELDS = ['youtubeApiKey'] as const
/** Provider and model pairs set through a model picker. */
export const YNS_MODEL_PAIRS = [
  { key: 'shiftModel', provider: 'provider', model: 'model' },
  { key: 'fallbackModelPick', provider: 'fallbackProvider', model: 'fallbackModel' },
] as const
/** The weekday choices, as the plugin reads them. */
export const YNS_WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

type StringField = typeof YNS_STRING_FIELDS[number]
type NumberField = typeof YNS_NUMBER_FIELDS[number]
type ListField = typeof YNS_LIST_FIELDS[number]
type SecretField = typeof YNS_SECRET_FIELDS[number]

/** The fields this card edits. */
export type YnsSettings = Partial<Record<StringField | NumberField | ListField | SecretField | 'enabled', unknown>>

/** `/yns/status`. */
export interface YnsStatus {
  enabled: boolean
  schedule: { weekday: string; time: string; timeZone: string }
  lastShiftDate: string | null
  apiKey: boolean
  apiKeySource: 'settings' | 'environment' | 'none'
  quota: { day: string; used: number; limit: number }
  run: {
    id: string
    startedAt: string
    trigger: string
    finished: boolean
    abandoned: boolean
    searches: number
    searchesPerRun: number
    units: number
    niches: { name: string; score: number }[]
  } | null
  latest: {
    id: string
    createdAt: string
    recommendation: string
    why: string
    summary: string
    link: string
    changes: string[]
    niches: { name: string; score: number; rpm: [number, number]; category: string }[]
  } | null
  reports: { id: string; createdAt: string; recommendation: string; link: string }[]
}

/** The status block's state. */
export interface YnsLiveState {
  status: YnsStatus | undefined
  failed: boolean
  /** Set after "Run research now" started a run. */
  started: boolean
  /** Why the Host refused "Run research now". */
  runError: string | undefined
}

/** What the card renders. */
export interface YnsCardState extends SettingsFormShell {
  enabled: SettingsFieldState
  strings: Record<StringField, SettingsFieldState>
  numbers: Record<NumberField, SettingsFieldState>
  lists: Record<ListField, SettingsFieldState>
  secrets: Record<SecretField, SettingsFieldState>
}

/** The face the card's slot entry injects. */
export interface YnsCardFace extends SettingsFormActions {
  retryModels: () => void
  refreshStatus: () => void
  /** Start a research run now instead of waiting for the weekly slot. */
  runNow: () => void
  hooks: {
    /** Bound as useYnsCard. */
    ynsCard: SnapshotStore<YnsCardState>
    /** Bound as useYnsModels. */
    ynsModels: SnapshotStore<ScoutModelCatalogState>
    /** Bound as useYnsLive. */
    ynsLive: SnapshotStore<YnsLiveState>
  }
}

function enabledField(): SettingsFieldSpec {
  return {
    field: 'enabled',
    format: value => value === true ? 'true' : 'false',
    parse: text => text === 'true' ? { kind: 'set', value: true } : text === 'false' ? { kind: 'set', value: false } : undefined,
  }
}

/**
 * A list field staged as one item per line; the card edits the lines as rows, and blank rows are dropped on save.
 * @param field - the field.
 * @returns the spec.
 */
export function listField(field: ListField): SettingsFieldSpec {
  return {
    field,
    format: value => Array.isArray(value) ? value.filter(v => typeof v === 'string').join('\n') : '',
    parse: (text) => {
      const items = [...new Set(text.split('\n').map(line => line.trim()).filter(line => line !== ''))]
      return items.length === 0 ? { kind: 'clear' } : { kind: 'set', value: items }
    },
  }
}

/** Bridges the settings scope onto the card, and reads the Host's status. */
export class YnsCardController {
  private readonly form: SettingsFormModel<YnsSettings>
  private readonly store: SnapshotStore<YnsCardState>
  private readonly live = createSnapshotStore<YnsLiveState>({ status: undefined, failed: false, started: false, runError: undefined })

  /**
   * @param scope - the bound settings scope.
   * @param request - same-origin HTTP, injectable for tests.
   */
  constructor(
    scope: SettingsFormScope<YnsSettings>,
    private readonly request: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {
    this.form = new SettingsFormModel(scope, [
      enabledField(),
      ...YNS_STRING_FIELDS.map(field => settingsTextField(field)),
      ...YNS_NUMBER_FIELDS.map(field => settingsNumberField(field)),
      ...YNS_LIST_FIELDS.map(field => listField(field)),
    ], YNS_SECRET_FIELDS.map(field => ({
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
      strings: fields(YNS_STRING_FIELDS),
      numbers: fields(YNS_NUMBER_FIELDS),
      lists: fields(YNS_LIST_FIELDS),
      secrets: fields(YNS_SECRET_FIELDS),
    }))
  }

  /** Read `/yns/status`. */
  refreshStatus(): void {
    void (async () => {
      try {
        const response = await this.request('/yns/status', { cache: 'no-store', credentials: 'same-origin' })
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        const status = await response.json() as YnsStatus
        this.live.update((draft) => { draft.status = status; draft.failed = false })
      } catch {
        // The plugin is not loaded or the sign-in expired: the card says the status is unknown.
        this.live.update((draft) => { draft.failed = true })
      }
    })()
  }

  /** Ask the Host to start a run; a refusal (a run started minutes ago, no key) is shown on the card. */
  runNow(): void {
    void (async () => {
      let error: string | undefined
      try {
        const response = await this.request('/yns/action', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'run-now' }),
        })
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: unknown }
          error = typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`
        }
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure)
      }
      this.live.update((draft) => { draft.started = error === undefined; draft.runError = error })
      this.refreshStatus()
    })()
  }

  /** Stop following the settings scope; the page is gone. */
  dispose(): void {
    this.form.dispose()
  }

  /**
   * Build the face the card's slot registration injects, reading the status as the page opens.
   * @param models - the model catalog the pickers offer.
   * @param retryModels - reloads that catalog.
   * @returns the card's snapshots and actions.
   */
  inject(models: SnapshotStore<ScoutModelCatalogState>, retryModels: () => void): YnsCardFace {
    this.refreshStatus()
    const actions = this.form.actions()
    return {
      hooks: { ynsCard: this.store, ynsModels: models, ynsLive: this.live },
      ...actions,
      save: () => { actions.save(); setTimeout(() => { this.refreshStatus() }, 1500) },
      retryModels,
      refreshStatus: () => { this.refreshStatus() },
      runNow: () => { this.runNow() },
    }
  }
}
