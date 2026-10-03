/**
 * The meeting reminders card's staged form over the `meeting-reminders`
 * settings namespace, plus the Host's routes: `/meeting-reminders/status`
 * (each rule's next meeting and reminder times, and recent sends), `preview`
 * `send-now`, and `groups` (the WhatsApp groups the meeting dropdown offers).
 * The meetings form stages the rules array as JSON text in the `rules` field.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { meetingFrom, meetingIssues } from './meeting-reminders-model.ts'

/** Namespace of the meeting reminders plugin; a client package must not import a Host package. */
export const MEETING_REMINDERS_NS = 'meeting-reminders'
/** Where the plugin's routes are mounted. */
const ROUTE = '/meeting-reminders'

/** The fields this card edits. */
export type MeetingRemindersSettings = Partial<Record<'rules' | 'timeZone' | 'hijriOffset' | 'notifyTo' | 'template', unknown>>

/** Where one reminder stands. */
export type MeetingReminderState = 'upcoming' | 'due' | 'missed' | 'sending' | 'sent' | 'gave-up'

/** One rule, as `/meeting-reminders/status` lists it. */
export interface MeetingRuleStatus {
  id: string
  label: string
  chat: string
  enabled: boolean
  problems: string[]
  next: { date: string; weekday: string; hijri: string; english: string; time: string; venue: string } | null
  reminders: { daysBefore: number; sendDate: string; sendAt: string; state: MeetingReminderState }[]
}

/** `/meeting-reminders/status`. */
export interface MeetingRemindersStatus {
  timeZone: string
  now: string | null
  today: { date: string; hijri: string; english: string } | null
  error?: string
  rules: MeetingRuleStatus[]
  sent: { key: string; label: string; at: string; ok: boolean; outcome: string; manual?: boolean }[]
}

/** One WhatsApp group the dropdown offers. */
export interface MeetingGroup {
  jid: string
  name: string
}

/** The WhatsApp groups, as `/meeting-reminders/groups` lists them. */
export interface MeetingGroupsState {
  state: 'loading' | 'ready' | 'failed'
  list: MeetingGroup[]
  error?: string
}

/** The status block's state. */
export interface MeetingRemindersLiveState {
  status: MeetingRemindersStatus | undefined
  failed: boolean
  /** Rendered message or error by rule id, from Preview. */
  previews: Record<string, string>
  /** What the last manual send of each rule answered. */
  results: Record<string, string>
  /** Rule ids with a request in flight. */
  busy: string[]
  groups: MeetingGroupsState
}

/** What the card renders. */
export interface MeetingRemindersCardState extends SettingsFormShell {
  rules: SettingsFieldState
  timeZone: SettingsFieldState
  hijriOffset: SettingsFieldState
  notifyTo: SettingsFieldState
  template: SettingsFieldState
}

/** The face the card's slot entry injects. */
export interface MeetingRemindersCardFace extends SettingsFormActions {
  refreshStatus: () => void
  /** Read the WhatsApp groups again. */
  refreshGroups: () => void
  /** Render a rule's next message without sending it. */
  preview: (ruleId: string) => void
  /** Send a rule's reminder now; `force` sends one already sent. */
  sendNow: (ruleId: string, force: boolean) => Promise<'sent' | 'already-sent' | 'failed'>
  hooks: {
    /** Bound as useMeetingRemindersCard. */
    meetingRemindersCard: SnapshotStore<MeetingRemindersCardState>
    /** Bound as useMeetingRemindersLive. */
    meetingRemindersLive: SnapshotStore<MeetingRemindersLiveState>
  }
}

/**
 * The rules as pretty-printed JSON. A draft that is not a JSON array of objects, or holds a meeting the form reports a
 * problem with, blocks the save.
 * @returns the field spec.
 */
export function rulesField(): SettingsFieldSpec {
  return {
    field: 'rules',
    format: value => JSON.stringify(Array.isArray(value) ? value : [], null, 2),
    parse: (text) => {
      if (text.trim() === '') return { kind: 'clear' }
      try {
        const value: unknown = JSON.parse(text)
        if (!Array.isArray(value) || !value.every(rule => typeof rule === 'object' && rule !== null && !Array.isArray(rule))) return undefined
        const meetings = value.map(meetingFrom)
        return meetings.every((meeting, i) => meetingIssues(meeting, meetings.filter((_, j) => j !== i)).length === 0)
          ? { kind: 'set', value }
          : undefined
      } catch {
        // Not JSON yet while the owner types; the field shows as invalid and the save waits.
        return undefined
      }
    },
  }
}

/** A route's status and JSON body. */
interface RouteAnswer {
  status: number
  body: Record<string, unknown>
}

/** The answer's `key` text, else its error, else its HTTP status code. */
function answerText(answer: RouteAnswer, key: string): string {
  const value = answer.body[key] ?? answer.body['error']
  return typeof value === 'string' ? value : String(answer.status)
}

/** Bridges the settings scope onto the card, and calls the Host's routes. */
export class MeetingRemindersCardController {
  private readonly form: SettingsFormModel<MeetingRemindersSettings>
  private readonly store: SnapshotStore<MeetingRemindersCardState>
  private readonly live = createSnapshotStore<MeetingRemindersLiveState>({
    status: undefined, failed: false, previews: {}, results: {}, busy: [], groups: { state: 'loading', list: [] },
  })

  /**
   * @param scope - the bound settings scope.
   * @param request - same-origin HTTP, injectable for tests.
   */
  constructor(
    scope: SettingsFormScope<MeetingRemindersSettings>,
    private readonly request: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {
    this.form = new SettingsFormModel(scope, [
      rulesField(),
      settingsTextField('timeZone'),
      settingsNumberField('hijriOffset'),
      settingsTextField('notifyTo'),
      settingsTextField('template'),
    ])
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      rules: this.form.field('rules'),
      timeZone: this.form.field('timeZone'),
      hijriOffset: this.form.field('hijriOffset'),
      notifyTo: this.form.field('notifyTo'),
      template: this.form.field('template'),
    }))
  }

  /** Read `/meeting-reminders/status`. */
  refreshStatus(): void {
    void (async () => {
      try {
        const response = await this.request(`${ROUTE}/status`, { cache: 'no-store', credentials: 'same-origin' })
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        const status = await response.json() as MeetingRemindersStatus
        this.live.update((draft) => { draft.status = status; draft.failed = false })
      } catch {
        // The plugin is not loaded or the sign-in expired: the card says the status is unknown.
        this.live.update((draft) => { draft.failed = true })
      }
    })()
  }

  /** Read `/meeting-reminders/groups`. */
  refreshGroups(): void {
    this.live.update((draft) => { draft.groups = { state: 'loading', list: draft.groups.list } })
    void (async () => {
      try {
        const response = await this.request(`${ROUTE}/groups`, { cache: 'no-store', credentials: 'same-origin' })
        const body = await response.json() as { groups?: MeetingGroup[]; error?: string }
        if (!response.ok || body.groups === undefined) throw new Error(body.error ?? String(response.status))
        const list = body.groups
        this.live.update((draft) => { draft.groups = { state: 'ready', list } })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.live.update((draft) => { draft.groups = { state: 'failed', list: [], error: message } })
      }
    })()
  }

  private async post(path: string, ruleId: string, body: Record<string, unknown>): Promise<RouteAnswer> {
    this.live.update((draft) => { draft.busy.push(ruleId) })
    try {
      const response = await this.request(`${ROUTE}/${path}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    } catch (error) {
      return { status: 0, body: { error: error instanceof Error ? error.message : String(error) } }
    } finally {
      this.live.update((draft) => { draft.busy = draft.busy.filter(id => id !== ruleId) })
    }
  }

  /**
   * Render a rule's next message into the live state.
   * @param ruleId - the rule.
   */
  preview(ruleId: string): void {
    void this.post('preview', ruleId, { ruleId }).then((answer) => {
      this.live.update((draft) => { draft.previews[ruleId] = answerText(answer, 'text') })
    })
  }

  /**
   * Send a rule's reminder now and record what the route answered.
   * @param ruleId - the rule.
   * @param force - send even when this reminder was already sent.
   * @returns how it went.
   */
  async sendNow(ruleId: string, force: boolean): Promise<'sent' | 'already-sent' | 'failed'> {
    const answer = await this.post('send-now', ruleId, { ruleId, force })
    const already = answer.status === 409 && answer.body['error'] === 'already sent'
    this.live.update((draft) => { draft.results[ruleId] = answerText(answer, 'outcome') })
    this.refreshStatus()
    return answer.status === 200 ? 'sent' : already ? 'already-sent' : 'failed'
  }

  /** Stop following the settings scope; the page is gone. */
  dispose(): void {
    this.form.dispose()
  }

  /**
   * Build the face the card's slot registration injects, reading the status as the page opens.
   * @returns the card's snapshots and actions.
   */
  inject(): MeetingRemindersCardFace {
    this.refreshStatus()
    this.refreshGroups()
    const actions = this.form.actions()
    return {
      hooks: { meetingRemindersCard: this.store, meetingRemindersLive: this.live },
      ...actions,
      save: () => { actions.save(); setTimeout(() => { this.refreshStatus() }, 1500) },
      refreshStatus: () => { this.refreshStatus() },
      refreshGroups: () => { this.refreshGroups() },
      preview: (ruleId) => { this.preview(ruleId) },
      sendNow: (ruleId, force) => this.sendNow(ruleId, force),
    }
  }
}
