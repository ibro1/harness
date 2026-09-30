/**
 * The Error reporting card's staged form over the `error-reporting` settings
 * namespace, plus the Host's status line and the test button. The DSN is a
 * `role('secret')` field: it never rides a response, so the card writes it
 * blind and learns only from the Host's status whether one is in force.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Namespace of the error-reporting plugin, spelled here rather than imported:
 * a client package must not depend on a Host package.
 */
export const ERROR_REPORTING_NS = 'error-reporting'

/** The Host routes the card reads and posts to. */
const STATUS_PATH = '/api/monitor/status'
const TEST_PATH = '/api/monitor/test'

/** Text fields, in the order the card shows them. */
export const ERROR_REPORTING_TEXT_FIELDS = ['publicDsn', 'environment', 'release'] as const
type TextField = typeof ERROR_REPORTING_TEXT_FIELDS[number]

/** The fields this card edits. */
export type ErrorReportingSettings = Partial<Record<TextField | 'dsn' | 'tracesSampleRate', unknown>>

/** Where reports go, as the Host reports it; never the key. */
export interface ErrorReportingStatus {
  enabled: boolean
  source: 'environment' | 'settings' | 'none'
  host?: string
  projectId?: string
  environment?: string
  release?: string
  error?: string
}

/** The status line and the last test, as the card renders them. */
export interface ErrorReportingLive {
  status: ErrorReportingStatus | undefined
  statusFailed: boolean
  test: { state: 'idle' | 'sending' } | { state: 'sent'; eventId: string } | { state: 'failed'; message: string }
}

/** What the card renders. */
export interface ErrorReportingCardState extends SettingsFormShell {
  dsn: SettingsFieldState
  text: Record<TextField, SettingsFieldState>
  tracesSampleRate: SettingsFieldState
}

/** The face the card's slot entry injects. */
export interface ErrorReportingCardFace extends SettingsFormActions {
  /** Send one test event through the Host. */
  sendTest: () => void
  /** Remove the saved DSN, turning reporting off unless the environment sets one. */
  removeDsn: () => void
  /** Read the status line again. */
  refreshStatus: () => void
  hooks: {
    /** Card snapshot bound by the renderer as useErrorReportingCard. */
    errorReportingCard: SnapshotStore<ErrorReportingCardState>
    /** Status and test result bound as useErrorReportingLive. */
    errorReportingLive: SnapshotStore<ErrorReportingLive>
  }
}

/** Bridges the `error-reporting` scope onto the card's staged form, status and test. */
export class ErrorReportingCardController {
  private readonly form: SettingsFormModel<ErrorReportingSettings>
  private readonly store: SnapshotStore<ErrorReportingCardState>
  private readonly live = createSnapshotStore<ErrorReportingLive>({ status: undefined, statusFailed: false, test: { state: 'idle' } })

  /**
   * @param scope - the bound settings scope for the `error-reporting` namespace.
   * @param request - same-origin HTTP, injectable for tests.
   */
  constructor(
    private readonly scope: SettingsFormScope<ErrorReportingSettings>,
    private readonly request: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {
    this.form = new SettingsFormModel(scope, [
      ...ERROR_REPORTING_TEXT_FIELDS.map(field => settingsTextField(field)),
      settingsNumberField('tracesSampleRate'),
    ], [{
      field: 'dsn',
      write: async (text) => {
        const accepted = await scope.mutate([{ op: 'set', path: ['dsn'], value: text.trim() }])
        this.refreshStatus()
        return accepted
      },
    }])
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      dsn: this.form.field('dsn'),
      text: Object.fromEntries(ERROR_REPORTING_TEXT_FIELDS.map(field => [field, this.form.field(field)])) as
        Record<TextField, SettingsFieldState>,
      tracesSampleRate: this.form.field('tracesSampleRate'),
    }))
  }

  /** Read the Host's status line. */
  refreshStatus(): void {
    void (async () => {
      try {
        const response = await this.request(STATUS_PATH, { cache: 'no-store', credentials: 'same-origin' })
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        const status = await response.json() as ErrorReportingStatus
        this.live.update((draft) => { draft.status = status; draft.statusFailed = false })
      } catch {
        // The plugin is not loaded or the session expired: the card says the status is unknown.
        this.live.update((draft) => { draft.statusFailed = true })
      }
    })()
  }

  /** Send one test event and record what the Host answered. */
  sendTest(): void {
    this.live.update((draft) => { draft.test = { state: 'sending' } })
    void (async () => {
      try {
        const response = await this.request(TEST_PATH, { method: 'POST', credentials: 'same-origin' })
        const body = await response.json() as { eventId?: string; sent?: boolean; error?: string }
        this.live.update((draft) => {
          draft.test = response.ok && body.sent === true && typeof body.eventId === 'string'
            ? { state: 'sent', eventId: body.eventId }
            : { state: 'failed', message: body.error ?? (body.sent === false ? 'not confirmed by the server within 5 seconds' : `HTTP ${String(response.status)}`) }
        })
      } catch (error) {
        this.live.update((draft) => { draft.test = { state: 'failed', message: error instanceof Error ? error.message : String(error) } })
      }
    })()
  }

  /** Remove the saved DSN. */
  removeDsn(): void {
    void (async () => {
      await this.scope.mutate([{ op: 'unset', path: ['dsn'] }])
      this.refreshStatus()
    })()
  }

  /** Stop following the settings scope; the page is gone. */
  dispose(): void { this.form.dispose() }

  /**
   * Build the face the card's slot registration injects, reading the status as the page opens.
   * @returns the card's snapshots and actions.
   */
  inject(): ErrorReportingCardFace {
    this.refreshStatus()
    const actions = this.form.actions()
    return {
      hooks: { errorReportingCard: this.store, errorReportingLive: this.live },
      ...actions,
      save: () => { actions.save(); setTimeout(() => { this.refreshStatus() }, 1500) },
      sendTest: () => { this.sendTest() },
      removeDsn: () => { this.removeDsn() },
      refreshStatus: () => { this.refreshStatus() },
    }
  }
}
