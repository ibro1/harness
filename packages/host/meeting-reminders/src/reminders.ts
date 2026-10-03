/**
 * The reminder service behind the plugin's timer and routes: one tick a
 * minute sends what is due, each reminder at most once, and the settings page
 * reads the plan, previews a message and sends one by hand.
 */

import { prune, remember, type Done, type ReminderState, type ReminderStore } from './store.ts'
import {
  addDays, daysBetween, englishDate, hijriDate, localTime, messageFor, occurrences, planReminders, reminderKey, ruleProblems, weekdayName,
  type LocalTime, type Occurrence, type Rule,
} from './schedule.ts'

/** Failed attempts after which a reminder is given up and the owner alerted, by default. */
export const MAX_ATTEMPTS = 3

function clockText(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** What the service reads at each use, so a settings change applies at once. */
export interface ReminderDeps {
  store: ReminderStore
  rules: () => readonly Rule[]
  timeZone: () => string
  hijriOffset: () => number
  /** Used by rules with no template of their own. */
  template: () => string
  /** Sends to a chat; returns text starting with `sent` on success and never throws. */
  send: (to: string, text: string) => Promise<string>
  /** Alerts the owner; empty recipient means no alert. */
  alert: (text: string) => Promise<string>
  now: () => Date
  log: (line: string) => void
  /** Minutes after its time a missed reminder may still go out. */
  lateWindowMinutes: number
  /** Failed attempts after which a reminder is given up and the owner alerted. */
  maxAttempts: number
}

/** A meeting as the status route shows it. */
export interface OccurrenceView extends Occurrence {
  weekday: string
  hijri: string
  english: string
}

/** One rule in the status. */
export interface RuleStatus {
  id: string
  label: string
  chat: string
  enabled: boolean
  problems: string[]
  next: OccurrenceView | null
  reminders: { daysBefore: number; sendDate: string; sendAt: string; state: 'upcoming' | 'due' | 'missed' | Done['outcome'] }[]
}

/** The answer of a manual send. */
export interface ManualSend {
  status: number
  body: Record<string, unknown>
}

/** The reminders, over their store. */
export class MeetingReminders {
  private ticking = false

  /** @param deps - settings readers, the store, the senders and the clock. */
  constructor(private readonly deps: ReminderDeps) {}

  private clock(): LocalTime {
    return localTime(this.deps.now(), this.deps.timeZone())
  }

  private view(occurrence: Occurrence): OccurrenceView {
    return {
      ...occurrence,
      weekday: weekdayName(occurrence.date),
      hijri: hijriDate(occurrence.date, this.deps.hijriOffset()),
      english: englishDate(occurrence.date),
    }
  }

  private rule(id: string): Rule | undefined {
    return this.deps.rules().find(r => r.id === id)
  }

  private message(rule: Rule, occurrence: Occurrence, today: string): string {
    return messageFor(rule, occurrence, today, { template: this.deps.template(), hijriOffset: this.deps.hijriOffset() })
  }

  /**
   * Claim a key for sending; false when it is already sent, in flight or given up.
   * @param state - mutated.
   * @param key - the reminder key.
   * @param at - when, ISO.
   * @param force - claim even a key that is done (a manual resend).
   * @returns whether the caller may send.
   */
  private static claim(state: ReminderState, key: string, at: string, force: boolean): boolean {
    if (state.done[key] !== undefined && !force) return false
    state.done[key] = { outcome: 'sending', at }
    return true
  }

  /**
   * Send one reminder and record the outcome. A failure releases the claim so the next tick retries, until the
   * `maxAttempts`th, which gives the reminder up and alerts the owner. A manual send is not retried.
   */
  private async deliver(rule: Rule, occurrence: Occurrence, daysBefore: number, text: string, manual: boolean): Promise<string> {
    const key = reminderKey(rule.id, occurrence.date, daysBefore)
    const outcome = await this.deps.send(rule.chat, text)
    const ok = outcome.startsWith('sent')
    const at = this.deps.now().toISOString()
    const gaveUp = await this.deps.store.update((state) => {
      remember(state, {
        key, ruleId: rule.id, label: rule.label, meetingDate: occurrence.date, daysBefore, at, ok, outcome, ...manual ? { manual } : {},
      })
      if (ok) {
        state.done[key] = { outcome: 'sent', at }
        Reflect.deleteProperty(state.attempts, key)
        return false
      }
      if (manual) {
        Reflect.deleteProperty(state.done, key)
        return false
      }
      const attempts = (state.attempts[key] ?? 0) + 1
      state.attempts[key] = attempts
      if (attempts < this.deps.maxAttempts) {
        Reflect.deleteProperty(state.done, key)
        return false
      }
      state.done[key] = { outcome: 'gave-up', at }
      return true
    })
    this.deps.log(`${ok ? 'sent' : 'not sent'}: ${rule.label} (${key})${manual ? ' by hand' : ''}: ${outcome}`)
    if (gaveUp) {
      const alerted = await this.deps.alert(
        `Meeting reminders: the "${rule.label}" reminder for ${englishDate(occurrence.date)} could not be posted after ${String(this.deps.maxAttempts)} tries (${outcome}). Please post it yourself.`,
      )
      if (!alerted.startsWith('sent')) this.deps.log(`owner alert for ${key} ${alerted}`)
    }
    return outcome
  }

  /** Send every reminder that is due and not yet done; a tick still running makes the next one wait its turn. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.clock()
      const due = this.deps.rules()
        .filter(rule => rule.enabled && ruleProblems(rule).length === 0)
        .flatMap(rule => planReminders(rule, now, 2, this.deps.lateWindowMinutes))
        .filter(plan => plan.state === 'due')
      if (due.length === 0) return
      const at = this.deps.now().toISOString()
      const claimed = await this.deps.store.update((state) => {
        prune(state, addDays(now.date, -60))
        return due.filter(plan => MeetingReminders.claim(state, plan.key, at, false))
      })
      for (const plan of claimed) {
        if (plan.lateBy > 1) this.deps.log(`${plan.key} is ${String(plan.lateBy)} minutes late; sending now`)
        await this.deliver(plan.rule, plan.occurrence, plan.reminder.daysBefore, this.message(plan.rule, plan.occurrence, now.date), false)
      }
    } catch (error) {
      this.deps.log(`tick failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.ticking = false
    }
  }

  /**
   * The settings page's view: each rule's next meeting and its reminders' times and states, and the recent sends.
   * @returns the status body.
   */
  async status(): Promise<Record<string, unknown>> {
    const state = await this.deps.store.read()
    let now: LocalTime | undefined
    let clockError: string | undefined
    try {
      now = this.clock()
    } catch (error) {
      clockError = `time zone "${this.deps.timeZone()}": ${error instanceof Error ? error.message : String(error)}`
    }
    const rules: RuleStatus[] = this.deps.rules().map((rule) => {
      const problems = ruleProblems(rule)
      const next = now === undefined || problems.length > 0 ? undefined : occurrences(rule, now.date, 1)[0]
      const plans = now === undefined || next === undefined ? [] : planReminders(rule, now, 1, this.deps.lateWindowMinutes)
      const reminders = plans.map(plan => ({
        daysBefore: plan.reminder.daysBefore, sendDate: plan.sendDate, sendAt: plan.sendAt,
        state: state.done[plan.key]?.outcome ?? plan.state,
      }))
      return {
        id: rule.id, label: rule.label, chat: rule.chat, enabled: rule.enabled, problems,
        next: next === undefined ? null : this.view(next), reminders,
      }
    })
    return {
      timeZone: this.deps.timeZone(),
      now: now === undefined ? null : `${now.date} ${clockText(now.minutes)}`,
      today: now === undefined ? null : {
        date: now.date, hijri: hijriDate(now.date, this.deps.hijriOffset()), english: englishDate(now.date),
      },
      hijriOffset: this.deps.hijriOffset(),
      ...clockError === undefined ? {} : { error: clockError },
      rules,
      sent: [...state.sent].reverse(),
    }
  }

  /**
   * Render a rule's message for its next meeting, as it would be sent today, without sending it.
   * @param ruleId - the rule.
   * @returns the route's status and body.
   */
  preview(ruleId: string): ManualSend {
    const rule = this.rule(ruleId)
    if (rule === undefined) return { status: 404, body: { error: `no rule with id "${ruleId}"; save the rules first` } }
    const now = this.clock()
    const next = occurrences(rule, now.date, 1)[0]
    if (next === undefined) return { status: 409, body: { error: 'the rule has no upcoming meeting' } }
    return { status: 200, body: { ruleId, chat: rule.chat, occurrence: this.view(next), text: this.message(rule, next, now.date) } }
  }

  /**
   * Send a rule's reminder for its next meeting now. It is recorded under `daysBefore`'s key, so the scheduled
   * reminder with that key does not go out again; by default that is the next reminder not yet sent.
   * @param request - the rule, optionally which reminder, and `force` to send a key already sent.
   * @returns the route's status and body.
   */
  async sendNow(request: { ruleId: string; daysBefore?: number; force?: boolean }): Promise<ManualSend> {
    const rule = this.rule(request.ruleId)
    if (rule === undefined) return { status: 404, body: { error: `no rule with id "${request.ruleId}"; save the rules first` } }
    const problems = ruleProblems(rule)
    if (problems.length > 0) return { status: 409, body: { error: problems.join('; ') } }
    const now = this.clock()
    const next = occurrences(rule, now.date, 1)[0]
    if (next === undefined) return { status: 409, body: { error: 'the rule has no upcoming meeting' } }
    const state = await this.deps.store.read()
    const pending = planReminders(rule, now, 1, this.deps.lateWindowMinutes).find(plan => state.done[plan.key] === undefined)
    const daysBefore = request.daysBefore ?? pending?.reminder.daysBefore ?? daysBetween(now.date, next.date)
    const key = reminderKey(rule.id, next.date, daysBefore)
    const at = this.deps.now().toISOString()
    const claimed = await this.deps.store.update(s => MeetingReminders.claim(s, key, at, request.force === true))
    if (!claimed) {
      return { status: 409, body: { error: 'already sent', key, done: state.done[key] ?? (await this.deps.store.read()).done[key] } }
    }
    const text = this.message(rule, next, now.date)
    const outcome = await this.deliver(rule, next, daysBefore, text, true)
    const ok = outcome.startsWith('sent')
    return { status: ok ? 200 : 502, body: { ok, outcome, key, text } }
  }
}
