/**
 * Meeting reminders: posts recurring WhatsApp reminders of monthly meetings
 * ("first Saturday", "last Friday") to group chats, on a schedule of days
 * before and times, with the Hijri date as the main date. A reminder goes out
 * at most once; one missed while the box was down goes out late within six
 * hours, while the meeting day lasts. The settings page shows the next
 * meetings, previews a message and sends one by hand.
 *
 * @module @deepseek-ai/dsh-host-meeting-reminders
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { MAX_ATTEMPTS, MeetingReminders } from './reminders.ts'
import { LATE_WINDOW_MINUTES, WEEKDAYS, type Rule } from './schedule.ts'
import { whatsAppSender } from './sender.ts'
import { ReminderStore } from './store.ts'

export { MAX_ATTEMPTS, MeetingReminders } from './reminders.ts'
export type { ManualSend, OccurrenceView, ReminderDeps, RuleStatus } from './reminders.ts'
export {
  addDays, daysBetween, englishDate, hijriDate, HIJRI_MONTHS, LATE_WINDOW_MINUTES, localTime, messageFor, nthWeekday, occurrences,
  ordinal, parseClock, planReminders, reminderKey, renderTemplate, ruleProblems, weekdayName, WEEKDAYS, whenText,
} from './schedule.ts'
export type { LocalTime, MessageValues, Occurrence, Override, PlannedReminder, Reminder, Rule, Weekday } from './schedule.ts'
export { whatsAppSender } from './sender.ts'
export type { WhatsAppRoute } from './sender.ts'
export { emptyState, HISTORY_LIMIT, prune, remember, ReminderStore } from './store.ts'
export type { Done, ReminderState, SendRecord } from './store.ts'

/** Plugin name. */
export const name = 'meeting-reminders'
/** Services the plugin needs. */
export const inject = ['webServer']

/** The message used by rules with no template of their own. */
export const DEFAULT_TEMPLATE = [
  'Assalamu alaikum warahmatullahi wabarakatuh,',
  '',
  '*Reminder:* the *{label}* is {when}, in shaa Allah.',
  '',
  '📅 *Date:* {weekday}, {hijriDate} ({date})',
  '⏰ *Time:* {time}',
  '📍 *Venue:* {venue}',
  '',
  'Your attendance is important. Jazakumullahu khairan.',
].join('\n')

/** Composition and live settings; the `Volatile` fields are edited on the Plugins page. */
export interface Config {
  rules: Volatile<Rule[]>
  timeZone: Volatile<string>
  /** Whole days added to the date before the Hijri conversion; Nigeria's moon sighting can differ from Umm al-Qura. */
  hijriOffset: Volatile<number>
  /** The fallback message template. */
  template: Volatile<string>
  /** WhatsApp chat name or number told when a reminder could not be posted. */
  notifyTo: Volatile<string>
  /** Minutes after its time a reminder missed while the server was down may still go out. */
  lateWindowMinutes: number
  /** Failed sends of one reminder before it is given up and `notifyTo` is told. */
  maxAttempts: number
  dataDir: string
  path: string
  whatsappUrl: string
  whatsappToken: string
}

const RULE = z.object({
  id: z.string().required().description('A short id you choose, such as amya-exco; reminders are recorded under it.'),
  label: z.string().required().description('The meeting\'s name in the message, such as AMYA Exco meeting.'),
  chat: z.string().required().description('WhatsApp group JID, ending in @g.us.'),
  meeting: z.object({
    nth: z.union([z.natural().min(1).max(5), z.const('last')]).required(),
    weekday: z.union([...WEEKDAYS]).required(),
  }).required(),
  time: z.string().default(''),
  venue: z.string().default(''),
  reminders: z.array(z.object({
    daysBefore: z.natural().max(27).required(),
    at: z.string().required(),
  })).default([]),
  template: z.string().default(''),
  enabled: z.boolean().default(true),
  override: z.object({
    month: z.string(),
    skip: z.boolean(),
    time: z.string(),
    venue: z.string(),
  }),
})

/** Composition config. */
export const Config = z.object({
  rules: z.array(RULE).default([]).volatile(),
  timeZone: z.string().default('Africa/Lagos').volatile(),
  hijriOffset: z.number().default(0).volatile(),
  template: z.string().default(DEFAULT_TEMPLATE).volatile(),
  notifyTo: z.string().default('').volatile(),
  lateWindowMinutes: z.natural().default(LATE_WINDOW_MINUTES),
  maxAttempts: z.natural().min(1).default(MAX_ATTEMPTS),
  dataDir: z.string().default(''),
  path: z.string().default('/meeting-reminders'),
  whatsappUrl: z.string().default(''),
  whatsappToken: z.string().default(''),
})

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > limit) return undefined
    chunks.push(buffer)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * Mount the reminders: the store, the minute timer and the signed-in routes.
 * @param ctx - the plugin context.
 * @param config - validated composition config.
 */
export function apply(ctx: Context, config: Config): void {
  const dataDir = config.dataDir !== '' ? config.dataDir : join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'meeting-reminders')
  const prefix = config.path.replace(/\/+$/u, '')
  const send = whatsAppSender({ url: config.whatsappUrl, token: config.whatsappToken })
  const log = (line: string): void => { process.stderr.write(`meeting-reminders: ${line}\n`) }
  const reminders = new MeetingReminders({
    store: new ReminderStore(join(dataDir, 'state.json')),
    rules: () => config.rules.get(),
    timeZone: () => config.timeZone.get().trim() || 'Africa/Lagos',
    hijriOffset: () => Math.trunc(config.hijriOffset.get()),
    template: () => config.template.get(),
    send,
    alert: text => send(config.notifyTo.get(), text),
    now: () => new Date(),
    log,
    lateWindowMinutes: config.lateWindowMinutes,
    maxAttempts: config.maxAttempts,
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/status`,
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      json(res, 200, await reminders.status())
    },
  }), `meeting-reminders: ${prefix}/status`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/preview`,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return }
      const body = await readJson(req, 4096)
      if (typeof body?.['ruleId'] !== 'string') { json(res, 400, { error: 'need { ruleId }' }); return }
      try {
        const answer = reminders.preview(body['ruleId'])
        json(res, answer.status, answer.body)
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `meeting-reminders: ${prefix}/preview`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/send-now`,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return }
      const body = await readJson(req, 4096)
      const ruleId = body?.['ruleId']
      const daysBefore = body?.['daysBefore']
      if (typeof ruleId !== 'string' || (daysBefore !== undefined && !(Number.isInteger(daysBefore) && (daysBefore as number) >= 0))) {
        json(res, 400, { error: 'need { ruleId, daysBefore?: whole number, force?: boolean }' })
        return
      }
      try {
        const answer = await reminders.sendNow({
          ruleId, ...daysBefore === undefined ? {} : { daysBefore: daysBefore as number }, force: body?.['force'] === true,
        })
        json(res, answer.status, answer.body)
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `meeting-reminders: ${prefix}/send-now`)

  const timer = setInterval(() => { void reminders.tick() }, 60_000)
  ctx.effect(() => () => { clearInterval(timer) })
}
