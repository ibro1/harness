/**
 * The tools employee card's staged form over the `tools-employee` settings
 * namespace, plus the Host's status (`/tools/status`): the schedule, the
 * current run, the site's deploy state, the shortlist awaiting approval, the
 * published tools, AdSense readiness, Search Console and the weekly pace. The
 * service account key and the deploy hook are `role('secret')` fields, written
 * blind.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScoutModelCatalogState } from './scout-model-catalog.ts'

/** Namespace of the tools employee plugin; a client package must not import a Host package. */
export const TOOLS_NS = 'tools-employee'

/** String fields. */
export const TOOLS_STRING_FIELDS = [
  'weekday', 'shiftTime', 'timeZone', 'notifyTo', 'adsenseClient', 'gscProperty', 'seoSiteId', 'siteRepo',
  'provider', 'model', 'fallbackProvider', 'fallbackModel',
] as const
/** Whole-number fields. */
export const TOOLS_NUMBER_FIELDS = ['maxToolsPerWeek', 'serpPerDay', 'fallbackCooldownMinutes'] as const
/** List fields, edited one row per item. */
export const TOOLS_LIST_FIELDS = ['seedTopics', 'markets'] as const
/** Write-only keys. */
export const TOOLS_SECRET_FIELDS = ['googleServiceAccountKey', 'deployHook'] as const
/** Provider and model pairs set through a model picker. */
export const TOOLS_MODEL_PAIRS = [
  { key: 'shiftModel', provider: 'provider', model: 'model' },
  { key: 'fallbackModelPick', provider: 'fallbackProvider', model: 'fallbackModel' },
] as const
/** The weekday choices, as the plugin reads them. */
export const TOOLS_WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const
/** The actions `/tools/action` accepts. */
export const TOOLS_ACTIONS = ['run-now', 'publish-site', 'check-site'] as const

type StringField = typeof TOOLS_STRING_FIELDS[number]
type NumberField = typeof TOOLS_NUMBER_FIELDS[number]
type ListField = typeof TOOLS_LIST_FIELDS[number]
type SecretField = typeof TOOLS_SECRET_FIELDS[number]

/** One action the card can ask the Host for. */
export type ToolsAction = typeof TOOLS_ACTIONS[number]

/** The fields this card edits. */
export type ToolsSettings = Partial<Record<StringField | NumberField | ListField | SecretField | 'enabled', unknown>>

/** `/tools/status`. */
export interface ToolsStatus {
  enabled: boolean
  schedule: { weekday: string; time: string; timeZone: string }
  lastShiftDate: string | null
  run: { id: string; kind: 'research' | 'build'; startedAt: string; trigger: string; finished: boolean; abandoned: boolean } | null
  site: {
    url: string
    state: 'live' | 'outdated' | 'not-deployed' | 'unreachable' | 'unknown'
    detail: string
    liveVersion: string | null
    localVersion: string | null
    checkedAt: string | null
    repo: string
    pushReady: boolean
    pushDetail: string
    deployHookSet: boolean
  }
  shortlist: {
    id: string
    createdAt: string
    status: 'pending' | 'decided'
    link: string
    items: {
      n: number
      slug: string
      tool: string
      keyword: string
      verdict: string
      demand: string
      market: string
      rpm: string
      difficulty: number
      approved: boolean | null
      built: boolean
      published: boolean
    }[]
  } | null
  tools: {
    slug: string
    title: string
    url: string
    keyword: string
    publishedAt: string
    seed: boolean
    tests: 'passed' | 'failed' | 'unknown'
    testsAt: string | null
    live: boolean
    clicks: number | null
    impressions: number | null
    position: number | null
    flag: string | null
  }[]
  pace: { thisWeek: number; max: number }
  serp: { today: number; max: number }
  adsense: { clientSet: boolean; ready: boolean; verdict: string; checks: { label: string; ok: boolean; detail: string }[] }
  gsc: { connected: boolean; keySet: boolean; property: string; detail: string; lastReviewAt: string | null }
  keywordPlanner: { available: boolean; detail: string }
}

/** The status block's state. */
export interface ToolsLiveState {
  status: ToolsStatus | undefined
  failed: boolean
  /** Set after "Run now" started a run. */
  started: boolean
  /** The action whose answer is shown, if any. */
  action: ToolsAction | undefined
  /** The Host's message for an accepted action. */
  actionMessage: string | undefined
  /** Why the Host refused the action. */
  actionError: string | undefined
}

/** What the card renders. */
export interface ToolsCardState extends SettingsFormShell {
  enabled: SettingsFieldState
  strings: Record<StringField, SettingsFieldState>
  numbers: Record<NumberField, SettingsFieldState>
  lists: Record<ListField, SettingsFieldState>
  secrets: Record<SecretField, SettingsFieldState>
}

/** The face the card's slot entry injects. */
export interface ToolsCardFace extends SettingsFormActions {
  retryModels: () => void
  refreshStatus: () => void
  /** Start a shift now instead of waiting for the weekly slot. */
  runNow: () => void
  /** Push the site to its repository now. */
  publishSite: () => void
  /** Compare the live site with the local build now. */
  checkSite: () => void
  hooks: {
    /** Bound as useToolsCard. */
    toolsCard: SnapshotStore<ToolsCardState>
    /** Bound as useToolsModels. */
    toolsModels: SnapshotStore<ScoutModelCatalogState>
    /** Bound as useToolsLive. */
    toolsLive: SnapshotStore<ToolsLiveState>
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
export function toolsListField(field: ListField): SettingsFieldSpec {
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
export class ToolsCardController {
  private readonly form: SettingsFormModel<ToolsSettings>
  private readonly store: SnapshotStore<ToolsCardState>
  private readonly live = createSnapshotStore<ToolsLiveState>({
    status: undefined, failed: false, started: false, action: undefined, actionMessage: undefined, actionError: undefined,
  })

  /**
   * @param scope - the bound settings scope.
   * @param request - same-origin HTTP, injectable for tests.
   */
  constructor(
    scope: SettingsFormScope<ToolsSettings>,
    private readonly request: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {
    this.form = new SettingsFormModel(scope, [
      enabledField(),
      ...TOOLS_STRING_FIELDS.map(field => settingsTextField(field)),
      ...TOOLS_NUMBER_FIELDS.map(field => settingsNumberField(field)),
      ...TOOLS_LIST_FIELDS.map(field => toolsListField(field)),
    ], TOOLS_SECRET_FIELDS.map(field => ({
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
      strings: fields(TOOLS_STRING_FIELDS),
      numbers: fields(TOOLS_NUMBER_FIELDS),
      lists: fields(TOOLS_LIST_FIELDS),
      secrets: fields(TOOLS_SECRET_FIELDS),
    }))
  }

  /** Read `/tools/status`. */
  refreshStatus(): void {
    void (async () => {
      try {
        const response = await this.request('/tools/status', { cache: 'no-store', credentials: 'same-origin' })
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        const status = await response.json() as ToolsStatus
        this.live.update((draft) => { draft.status = status; draft.failed = false })
      } catch {
        // The plugin is not loaded or the sign-in expired: the card says the status is unknown.
        this.live.update((draft) => { draft.failed = true })
      }
    })()
  }

  /**
   * Ask the Host for an action; a refusal (a run started minutes ago, no repository) is shown on the card.
   * @param action - what to do.
   */
  act(action: ToolsAction): void {
    void (async () => {
      let error: string | undefined
      let message: string | undefined
      try {
        const response = await this.request('/tools/action', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
        })
        const body = await response.json().catch(() => ({})) as { error?: unknown; message?: unknown }
        if (response.ok) message = typeof body.message === 'string' ? body.message : undefined
        else error = typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure)
      }
      this.live.update((draft) => {
        if (action === 'run-now') draft.started = error === undefined
        draft.action = action
        draft.actionMessage = message
        draft.actionError = error
      })
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
  inject(models: SnapshotStore<ScoutModelCatalogState>, retryModels: () => void): ToolsCardFace {
    this.refreshStatus()
    const actions = this.form.actions()
    return {
      hooks: { toolsCard: this.store, toolsModels: models, toolsLive: this.live },
      ...actions,
      save: () => { actions.save(); setTimeout(() => { this.refreshStatus() }, 1500) },
      retryModels,
      refreshStatus: () => { this.refreshStatus() },
      runNow: () => { this.act('run-now') },
      publishSite: () => { this.act('publish-site') },
      checkSite: () => { this.act('check-site') },
    }
  }
}
