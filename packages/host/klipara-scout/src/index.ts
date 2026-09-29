/**
 * Klipara Scout: an autonomous outreach employee for Klipara. Once a day it
 * starts a shift Session that finds YouTube creators posting long videos,
 * makes each one a free sample clip through the Klipara API, pitches it by
 * email or a context-aware comment through the DeerFlow browser, and watches
 * for replies. The plugin owns everything that must hold whatever the model
 * does: the lead records, the daily sample and pitch caps, the pause switch,
 * sample hosting, and the owner's WhatsApp alerts. The model only chooses
 * whom to pitch and what to say.
 *
 * @module @deepseek-ai/dsh-host-klipara-scout
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ToolDefinition, ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { bestCandidate, kliparaClient, type KliparaApi } from './klipara.ts'
import { serveSample, storeSample } from './samples.ts'
import { localTime, parseShiftTime, shiftDue, startShift } from './shift.ts'
import { advance, dayCount, LEAD_STAGES, ScoutStore, type Lead, type LeadStage, type ScoutState } from './store.ts'
import { channelFacts, execYtDlp, searchLongVideos, type YtDlpRunner } from './youtube.ts'

export { bestCandidate, kliparaClient } from './klipara.ts'
export type { KliparaApi, KliparaCandidate, KliparaJob } from './klipara.ts'
export { localTime, parseShiftTime, shiftDue } from './shift.ts'
export { ScoutStore, emptyState } from './store.ts'
export type { Lead, LeadStage, ScoutState } from './store.ts'
export type { YtDlpRunner } from './youtube.ts'

export const name = 'klipara-scout'
export const inject = ['agents', 'webServer', 'agentDefaultModel', 'agentPresets', 'permissionPresets', 'sessionTitle', 'workspaceRegistry']

/** Composition and live settings. The `Volatile` fields are edited on the Plugins page. */
export interface Config {
  /** Run the daily shift. Off until the operator turns it on. */
  enabled: Volatile<boolean>
  /** Local start time of the daily shift, `HH:MM`. */
  shiftTime: Volatile<string>
  /** IANA time zone the shift time is read in. */
  timeZone: Volatile<string>
  /** Samples started per local day; each exported sample spends one Klip. */
  samplesPerDay: Volatile<number>
  /** Pitches (emails and comments together) per local day. */
  pitchesPerDay: Volatile<number>
  /** Search phrases the shift rotates through. */
  topics: Volatile<string[]>
  minSubscribers: Volatile<number>
  maxSubscribers: Volatile<number>
  /** Skip channels already posting more Shorts than this. */
  maxShorts: Volatile<number>
  /** The Klipara workspace API key (`klp_sk_live_…`). */
  kliparaApiKey: Volatile<string>
  /** WhatsApp chat name or number that hears about replies and pauses. */
  notifyTo: Volatile<string>
  /** Model route for the shift; empty uses the harness default model. */
  provider: Volatile<string>
  model: Volatile<string>
  /** Headline and note on a sample's public page. */
  sampleHeadline: Volatile<string>
  sampleNote: Volatile<string>
  /** Directory for the lead file and samples; empty uses `<DSH home>/klipara-scout`. */
  dataDir: string
  kliparaApi: string
  /** Absolute origin sample links are built on, for example `https://harness.example.com`. */
  publicBaseUrl: string
  /** Route prefix for the sample pages, the leads page and the command route. */
  path: string
  /** Shared secret for the CLI command route; empty leaves that route unmounted. */
  token: string
  workspacePath: string
  agentPreset: string
  permissionPreset: string
  /** The shift's opening message; `{skill}` becomes the skill file's path. */
  shiftPrompt: string
  ytDlp: string
  timeoutMs: number
  /** The WhatsApp plugin's command route and token, for owner alerts. */
  whatsappUrl: string
  whatsappToken: string
}

/** Composition config. */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  shiftTime: z.string().default('09:00').volatile(),
  timeZone: z.string().default('Africa/Lagos').volatile(),
  samplesPerDay: z.natural().default(3).volatile(),
  pitchesPerDay: z.natural().default(5).volatile(),
  topics: z.array(z.string()).default(['nigerian podcast', 'african business podcast', 'nigerian interview']).volatile(),
  minSubscribers: z.natural().default(2000).volatile(),
  maxSubscribers: z.natural().default(300_000).volatile(),
  maxShorts: z.natural().default(10).volatile(),
  kliparaApiKey: z.string().default('').volatile(),
  notifyTo: z.string().default('').volatile(),
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  sampleHeadline: z.string().default('A clip from your latest video').volatile(),
  sampleNote: z.string().default('Cut by Klipara from your full episode. If you want more like this, just reply to the message it came with.').volatile(),
  dataDir: z.string().default(''),
  kliparaApi: z.string().default('https://klipara.linkfa.de/api/v1'),
  publicBaseUrl: z.string().default(''),
  path: z.string().default('/scout'),
  token: z.string().default(''),
  workspacePath: z.string().default('/workspace/klipara-scout'),
  agentPreset: z.string().default('standard'),
  permissionPreset: z.string().default('workspace-write'),
  shiftPrompt: z.string().default('Run today\'s Klipara Scout shift. Your instructions are the klipara-scout skill at {skill}: read that file first, then follow it exactly.'),
  ytDlp: z.string().default('yt-dlp'),
  timeoutMs: z.natural().min(1000).default(60_000),
  whatsappUrl: z.string().default(''),
  whatsappToken: z.string().default(''),
})

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true, description: 'What happened, as text.' },
  },
} as const satisfies ValueSchemaSpec

/** Everything the tools read or call, injectable for tests. */
export interface ScoutDeps {
  store: ScoutStore
  config: Config
  ytDlp: YtDlpRunner
  klipara: KliparaApi
  samplesDir: string
  /** Absolute URL prefix of the sample pages. */
  sampleBase: () => string
  /** Tell the owner something on WhatsApp; failures are reported, never thrown. */
  notify: (text: string) => Promise<string>
  now: () => Date
}

/** Words of a pitch, for the near-duplicate check. */
function words(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/https?:\/\/\S+/gu, '').split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2))
}

/** Share of words two pitches have in common (Jaccard). */
function overlap(a: string, b: string): number {
  const x = words(a)
  const y = words(b)
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared++
  return shared / (x.size + y.size - shared)
}

/** One line per lead, for listings. */
function describe(lead: Lead): string {
  const facts = [
    lead.subscribers === undefined ? undefined : `${String(lead.subscribers)} subs`,
    lead.shortsCount === undefined ? undefined : `${String(lead.shortsCount)} shorts`,
    lead.email === undefined ? undefined : `email ${lead.email}`,
    lead.samplePageUrl === undefined ? undefined : `sample ${lead.samplePageUrl}`,
  ].filter(v => v !== undefined).join(', ')
  return `- [${lead.stage}] ${lead.channelName} (${lead.channelId}) — ${lead.videoTitle ?? ''} ${lead.videoUrl ?? ''}${facts === '' ? '' : ` — ${facts}`}`
}

/**
 * Build the scout tools without registering them, so one definition serves both
 * the shift Sessions and the CLI command route.
 * @param deps - the store, config, and external calls.
 * @returns the tool definitions.
 */
export function buildScoutTools(deps: ScoutDeps): ToolDefinition[] {
  const { store, config } = deps
  const today = (): string => localTime(deps.now(), config.timeZone.get()).date
  const iso = (): string => deps.now().toISOString()
  const reply = (text: string): { text: string } => ({ text })
  const channelParameter = { type: 'string', required: true, description: 'The lead\'s YouTube channel id, as scout_search or scout_leads reports it.' } as const
  const findLead = (state: ScoutState, channelId: string): Lead => {
    const lead = state.leads.find(l => l.channelId === channelId)
    if (lead === undefined) throw new Error(`No lead with channel id ${channelId}; scout_leads lists them.`)
    return lead
  }
  const refuseWhilePaused = (state: ScoutState): void => {
    if (state.paused !== null) throw new Error(`Outreach is paused (${state.paused.reason}). Stop the shift; only the owner resumes it.`)
  }
  const tool = <const S extends ParameterSchemaSpec>(spec: {
    name: string
    description: string
    parameters: S
    run: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<string>
  }): ToolDefinition => defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: async (args, exec) => reply(await spec.run(args as Record<string, unknown>, exec)),
    presentCall: () => ({ card: 'generic', title: spec.name.replace(/_/gu, ' '), kind: 'other', rawInput: '' }),
  })

  return [
    tool({
      name: 'scout_status',
      description: 'Show today\'s caps and what is left of them, whether outreach is paused, and how many leads sit at each stage. Call it first in a shift and before each sample or pitch.',
      parameters: {},
      run: async () => {
        const state = await store.read()
        const day = state.days[today()] ?? { samples: 0, pitches: 0 }
        const counts = LEAD_STAGES.map(stage => `${stage} ${String(state.leads.filter(l => l.stage === stage).length)}`).join(', ')
        return [
          `Today (${today()}): samples ${String(day.samples)}/${String(config.samplesPerDay.get())}, pitches ${String(day.pitches)}/${String(config.pitchesPerDay.get())}.`,
          state.paused === null ? 'Outreach is running.' : `Outreach is PAUSED since ${state.paused.at}: ${state.paused.reason}`,
          `Leads: ${counts}.`,
          `Search topics: ${config.topics.get().join('; ')}.`,
        ].join('\n')
      },
    }),
    tool({
      name: 'scout_search',
      description: 'Search YouTube for long videos (over 20 minutes, uploaded this month) on a topic, check each new channel\'s size and how many Shorts it already posts, and save the channels that fit as `found` leads. Channels already in the lead list are skipped. Returns the new leads.',
      parameters: {
        topic: { type: 'string', description: 'Search words. Omit to use the next configured topic.' },
        limit: { type: 'integer', description: 'Videos to read from the results, 1 to 30. Defaults to 15.' },
      },
      run: async (args, exec) => {
        const topics = config.topics.get()
        const state = await store.read()
        const topic = typeof args['topic'] === 'string' && args['topic'].trim() !== ''
          ? args['topic'].trim()
          : topics[state.leads.length % Math.max(topics.length, 1)] ?? 'podcast'
        const limit = Math.min(Math.max(typeof args['limit'] === 'number' ? args['limit'] : 15, 1), 30)
        const videos = await searchLongVideos(deps.ytDlp, topic, limit, exec.signal)
        const known = new Set(state.leads.map(l => l.channelId))
        const fresh = [...new Map(videos.filter(v => !known.has(v.channelId)).map(v => [v.channelId, v])).values()]
        const kept: Lead[] = []
        const skipped: string[] = []
        for (const video of fresh) {
          const facts = await channelFacts(deps.ytDlp, video.channelId, config.maxShorts.get() + 1, exec.signal)
          const subs = facts.subscribers
          // A channel outside the limits is kept as a skipped lead, so no later
          // search spends another channel read on it.
          const reason = subs !== undefined && (subs < config.minSubscribers.get() || subs > config.maxSubscribers.get())
            ? `${String(subs)} subscribers`
            : facts.shortsCount > config.maxShorts.get() ? `already posts ${String(facts.shortsCount)}+ Shorts` : undefined
          if (reason !== undefined) skipped.push(`${video.channelName}: ${reason}`)
          const at = iso()
          const stage = reason === undefined ? 'found' : 'skipped'
          kept.push({
            channelId: video.channelId,
            channelName: facts.channelName || video.channelName,
            channelUrl: facts.channelUrl,
            ...subs === undefined ? {} : { subscribers: subs },
            shortsCount: facts.shortsCount,
            ...facts.email === undefined ? {} : { email: facts.email },
            videoId: video.videoId,
            videoUrl: video.videoUrl,
            videoTitle: video.title,
            durationMinutes: video.durationMinutes,
            stage,
            source: 'scout',
            replies: [],
            history: [{ at, stage, note: reason === undefined ? `search: ${topic}` : `search: ${topic}; ${reason}` }],
            createdAt: at,
            updatedAt: at,
          })
        }
        await store.update((s) => {
          const have = new Set(s.leads.map(l => l.channelId))
          s.leads.push(...kept.filter(l => !have.has(l.channelId)))
        })
        return [
          `Searched "${topic}": ${String(videos.length)} long videos, ${String(fresh.length)} new channels, ${String(kept.length - skipped.length)} saved as leads.`,
          ...kept.filter(l => l.stage === 'found').map(describe),
          ...skipped.length === 0 ? [] : [`Skipped: ${skipped.join('; ')}.`],
        ].join('\n')
      },
    }),
    tool({
      name: 'scout_leads',
      description: 'List leads, newest first, optionally only those at one stage.',
      parameters: {
        stage: { type: 'string', enum: [...LEAD_STAGES], description: 'Only leads at this stage.' },
        limit: { type: 'integer', description: 'Most leads to list, 1 to 100. Defaults to 30.' },
      },
      run: async (args) => {
        const state = await store.read()
        const stage = typeof args['stage'] === 'string' ? args['stage'] : undefined
        const limit = Math.min(Math.max(typeof args['limit'] === 'number' ? args['limit'] : 30, 1), 100)
        const leads = state.leads.filter(l => stage === undefined || l.stage === stage).slice(-limit).reverse()
        return leads.length === 0 ? 'No leads match.' : leads.map(describe).join('\n')
      },
    }),
    tool({
      name: 'scout_make_sample',
      description: 'Start making a free sample for a `found` lead: Klipara analyses the lead\'s video in the background (free). Counts against today\'s sample cap. Check it later with scout_check_sample; analysis takes several minutes.',
      parameters: { channel_id: channelParameter },
      run: async (args, exec) => {
        const channelId = String(args['channel_id'])
        const lead = await store.update((s) => {
          refuseWhilePaused(s)
          const found = findLead(s, channelId)
          if (found.stage !== 'found') throw new Error(`${found.channelName} is at stage ${found.stage}; only a found lead gets a sample.`)
          if (found.videoUrl === undefined) throw new Error(`${found.channelName} has no video to sample.`)
          const day = dayCount(s, today())
          if (day.samples >= config.samplesPerDay.get()) throw new Error(`Today's sample cap (${String(config.samplesPerDay.get())}) is reached. Continue with pitches and replies, or end the shift.`)
          day.samples++
          return { ...found }
        })
        let job
        try {
          job = await deps.klipara.startJob(lead.videoUrl ?? '', exec.signal)
        } catch (error) {
          await store.update((s) => { const d = dayCount(s, today()); d.samples = Math.max(0, d.samples - 1) })
          throw error
        }
        await store.update((s) => {
          const l = findLead(s, channelId)
          l.jobId = job.id
          advance(l, 'sampling', iso(), `Klipara job ${job.id}`)
        })
        return `Klipara is analysing ${lead.videoTitle ?? lead.videoUrl ?? ''} (job ${job.id}, ${job.state}). Check it with scout_check_sample in a few minutes.`
      },
    }),
    tool({
      name: 'scout_check_sample',
      description: 'Check a `sampling` lead\'s Klipara job. When analysis is done, export the best standalone clip (spends one Klip), host it, and move the lead to `sampled` with its public sample link. A failed or clipless job moves the lead to `skipped`.',
      parameters: { channel_id: channelParameter },
      run: async (args, exec) => {
        const channelId = String(args['channel_id'])
        const state = await store.read()
        const lead = findLead(state, channelId)
        if (lead.stage !== 'sampling' || lead.jobId === undefined) throw new Error(`${lead.channelName} is at stage ${lead.stage}, not sampling.`)
        const job = await deps.klipara.getJob(lead.jobId, exec.signal)
        if (job.state === 'failed' || job.state === 'cancelled') {
          await store.update((s) => { advance(findLead(s, channelId), 'skipped', iso(), `Klipara job ${job.state}${job.errorCode === undefined ? '' : `: ${job.errorCode}`}`) })
          return `The Klipara job ${job.state}${job.errorCode === undefined ? '' : ` (${job.errorCode})`}; ${lead.channelName} is skipped.`
        }
        if (job.state !== 'succeeded') return `Still ${job.state}; check again in a few minutes.`
        const best = bestCandidate(await deps.klipara.candidates(lead.jobId, exec.signal))
        if (best === undefined) {
          await store.update((s) => { advance(findLead(s, channelId), 'skipped', iso(), 'no clip stands alone') })
          return `Klipara found no clip that stands alone in that video; ${lead.channelName} is skipped.`
        }
        const exported = await deps.klipara.exportClip(best.clipId, exec.signal)
        const sampleId = await storeSample(deps.samplesDir, exported.downloadUrl, exec.signal)
        const samplePageUrl = `${deps.sampleBase()}/${sampleId}`
        await store.update((s) => {
          const l = findLead(s, channelId)
          l.sampleId = sampleId
          l.samplePageUrl = samplePageUrl
          advance(l, 'sampled', iso(), `clip ${best.clipId} (${String(Math.round((best.endMs - best.startMs) / 1000))}s)`)
        })
        return `Sample ready for ${lead.channelName}: ${samplePageUrl} (clip ${String(Math.round(best.startMs / 1000))}s–${String(Math.round(best.endMs / 1000))}s of "${lead.videoTitle ?? ''}"). Pitch it with scout_pitch.`
      },
    }),
    tool({
      name: 'scout_pitch',
      description: 'Reserve one pitch for a `sampled` lead and record exactly what will be sent. Call it BEFORE sending, then send exactly this text: by email to the lead\'s address through Gmail, or as a comment on the lead\'s video. It refuses when outreach is paused, today\'s pitch cap is used, the text lacks the sample link, or the text is too close to an earlier pitch.',
      parameters: {
        channel_id: channelParameter,
        via: { type: 'string', required: true, enum: ['email', 'comment'], description: 'email when the lead has an address, otherwise comment.' },
        to: { type: 'string', required: true, description: 'The email address, or the URL of the video the comment goes on.' },
        text: { type: 'string', required: true, description: 'The whole message, written for this creator and this video, containing the sample link.' },
      },
      run: async (args) => {
        const channelId = String(args['channel_id'])
        const via = args['via'] === 'email' ? 'email' : 'comment'
        const to = String(args['to']).trim()
        const text = String(args['text']).trim()
        return await store.update((s) => {
          refuseWhilePaused(s)
          const lead = findLead(s, channelId)
          if (lead.stage !== 'sampled' || lead.samplePageUrl === undefined) throw new Error(`${lead.channelName} is at stage ${lead.stage}; only a sampled lead is pitched.`)
          if (!text.includes(lead.samplePageUrl)) throw new Error(`The pitch must contain the sample link ${lead.samplePageUrl}.`)
          if (via === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(to)) throw new Error('An email pitch needs an email address in `to`.')
          if (via === 'comment' && !/youtube\.com|youtu\.be/u.test(to)) throw new Error('A comment pitch needs the video URL in `to`.')
          const earlier = s.leads.flatMap(l => l.pitch === undefined ? [] : [l.pitch.text]).slice(-30)
          const closest = Math.max(0, ...earlier.map(t => overlap(t, text)))
          if (closest >= 0.6) throw new Error(`This pitch is ${String(Math.round(closest * 100))}% the same words as an earlier one; YouTube and Gmail flag repeated text. Rewrite it around this creator's video.`)
          const day = dayCount(s, today())
          if (day.pitches >= config.pitchesPerDay.get()) throw new Error(`Today's pitch cap (${String(config.pitchesPerDay.get())}) is reached. End the shift.`)
          day.pitches++
          lead.pitch = { via, to, text, at: iso() }
          advance(lead, 'pitched', iso(), `${via} to ${to}`)
          return `Pitch ${String(day.pitches)}/${String(config.pitchesPerDay.get())} reserved. Now send exactly this ${via === 'email' ? `email to ${to}` : `comment on ${to}`}. If sending fails or YouTube or Gmail shows any warning, captcha or restriction, call scout_pause immediately.`
        })
      },
    }),
    tool({
      name: 'scout_record_reply',
      description: 'Record a creator\'s reply to a pitch (found in the Gmail inbox or in YouTube notifications) and alert the owner on WhatsApp. Moves the lead to `replied`; the owner takes over from there.',
      parameters: {
        channel_id: channelParameter,
        where: { type: 'string', required: true, enum: ['email', 'comment'], description: 'Where the reply came.' },
        text: { type: 'string', required: true, description: 'The reply, verbatim.' },
      },
      run: async (args) => {
        const channelId = String(args['channel_id'])
        const text = String(args['text']).trim()
        const lead = await store.update((s) => {
          const l = findLead(s, channelId)
          l.replies.push({ at: iso(), where: String(args['where']), text })
          if (l.stage === 'pitched') advance(l, 'replied', iso(), 'creator replied')
          return { ...l }
        })
        const sent = await deps.notify(`Klipara Scout: ${lead.channelName} replied (${String(args['where'])}).\n\n"${text.slice(0, 500)}"\n\nVideo: ${lead.videoUrl ?? ''}\nSample: ${lead.samplePageUrl ?? ''}\nPitched ${lead.pitch?.via ?? ''} to ${lead.pitch?.to ?? ''}`)
        return `Reply recorded; ${lead.channelName} is now ${lead.stage}. Owner alert: ${sent}. Do not answer the creator yourself.`
      },
    }),
    tool({
      name: 'scout_update_lead',
      description: 'Close or park a lead: won (they paid), lost (they declined or went silent), or skipped (not worth pitching). Records a note.',
      parameters: {
        channel_id: channelParameter,
        stage: { type: 'string', required: true, enum: ['won', 'lost', 'skipped'], description: 'The new stage.' },
        note: { type: 'string', required: true, description: 'Why.' },
      },
      run: async (args) => {
        const channelId = String(args['channel_id'])
        const stage = String(args['stage']) as LeadStage
        await store.update((s) => { advance(findLead(s, channelId), stage, iso(), String(args['note'])) })
        return `Lead ${channelId} is now ${stage}.`
      },
    }),
    tool({
      name: 'scout_pause',
      description: 'Stop all outreach at once and alert the owner. Call it the moment YouTube or Gmail shows a warning, captcha, sign-in prompt, comment restriction or anything unusual, or a send fails. While paused, samples and pitches are refused and no shift starts.',
      parameters: { reason: { type: 'string', required: true, description: 'What happened, specifically.' } },
      run: async (args) => {
        const reason = String(args['reason']).trim() || 'no reason given'
        await store.update((s) => { s.paused = { reason, at: iso() } })
        const sent = await deps.notify(`Klipara Scout PAUSED: ${reason}\n\nNo outreach runs until you resume it: open a Klipara Scout session and say "resume the scout".`)
        return `Outreach paused. Owner alert: ${sent}. End the shift now.`
      },
    }),
    tool({
      name: 'scout_resume',
      description: 'Resume outreach after a pause. Only when the owner explicitly asks for it in this conversation; never on your own.',
      parameters: {},
      run: async () => {
        const was = await store.update((s) => { const p = s.paused; s.paused = null; return p })
        return was === null ? 'Outreach was not paused.' : `Outreach resumed (it was paused for: ${was.reason}).`
      },
    }),
  ]
}

/** Compare two secrets in constant time, whatever their lengths. */
function secretEquals(a: string, b: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(a), digest(b))
}

/** Escape text for HTML. */
function html(value: string): string {
  return value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c] ?? c)
}

/**
 * The owner's leads page: every lead, newest first, with its stage and links.
 * @param state - the scout state.
 * @param date - today's local date.
 * @param config - live caps.
 * @returns the HTML document.
 */
export function leadsPage(state: ScoutState, date: string, config: Pick<Config, 'samplesPerDay' | 'pitchesPerDay'>): string {
  const day = state.days[date] ?? { samples: 0, pitches: 0 }
  const rows = [...state.leads].reverse().map(l => `<tr><td>${html(l.stage)}</td><td><a href="${html(l.channelUrl)}">${html(l.channelName)}</a><br><small>${l.subscribers === undefined ? '' : `${String(l.subscribers)} subs`}</small></td><td>${l.videoUrl === undefined ? '' : `<a href="${html(l.videoUrl)}">${html(l.videoTitle ?? 'video')}</a>`}</td><td>${l.samplePageUrl === undefined ? '' : `<a href="${html(l.samplePageUrl)}">sample</a>`}</td><td>${l.pitch === undefined ? '' : `${html(l.pitch.via)} → ${html(l.pitch.to)}`}</td><td>${l.replies.map(r => html(r.text.slice(0, 200))).join('<hr>')}</td><td><small>${html(l.updatedAt.slice(0, 16).replace('T', ' '))}</small></td></tr>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Klipara Scout leads</title>
<style>:root{color-scheme:dark light;--bg:#0f0f12;--fg:#eee;--line:#2a2a31}@media (prefers-color-scheme:light){:root{--bg:#fafafa;--fg:#111;--line:#ddd}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}div{overflow-x:auto}a{color:inherit}</style></head>
<body><h1>Klipara Scout</h1><p>Today ${html(date)}: samples ${String(day.samples)}/${String(config.samplesPerDay.get())}, pitches ${String(day.pitches)}/${String(config.pitchesPerDay.get())}. ${state.paused === null ? 'Outreach running.' : `<strong>Paused: ${html(state.paused.reason)}</strong>`}</p>
<div><table><thead><tr><th>Stage</th><th>Channel</th><th>Video</th><th>Sample</th><th>Pitch</th><th>Replies</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table></div></body></html>`
}

/** Read a request body up to a limit, or undefined past it. */
async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Mount the scout: its store, public sample pages, the owner's leads page, the
 * CLI command route, the tools on shift Sessions, and the daily timer.
 * @param ctx - the plugin context.
 * @param config - validated composition config.
 */
export function apply(ctx: Context, config: Config): void {
  const dataDir = config.dataDir !== '' ? config.dataDir : join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'klipara-scout')
  const store = new ScoutStore(join(dataDir, 'leads.json'))
  const samplesDir = join(dataDir, 'samples')
  const prefix = config.path.replace(/\/+$/u, '')
  const notify = async (text: string): Promise<string> => {
    const to = config.notifyTo.get().trim()
    if (to === '' || config.whatsappUrl === '' || config.whatsappToken === '') return 'not sent (no WhatsApp recipient or route configured)'
    try {
      const response = await fetch(config.whatsappUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.whatsappToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'whatsapp_send', args: { to, text, send_now: true } }),
        signal: AbortSignal.timeout(20_000),
      })
      const body = await response.json() as { error?: string }
      return body.error === undefined ? `sent to ${to}` : `failed: ${body.error}`
    } catch (error) {
      return `failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const deps: ScoutDeps = {
    store,
    config,
    ytDlp: execYtDlp(config.ytDlp, config.timeoutMs),
    klipara: kliparaClient(config.kliparaApi, () => config.kliparaApiKey.get(), config.timeoutMs),
    samplesDir,
    sampleBase: () => `${config.publicBaseUrl.replace(/\/+$/u, '')}${prefix}/s`,
    notify,
    now: () => new Date(),
  }
  const tools = buildScoutTools(deps)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: `${prefix}/s`,
    authenticate: false,
    handler: (req: IncomingMessage, res: ServerResponse) => serveSample(req, res, samplesDir, `${prefix}/s`, config.sampleHeadline.get(), config.sampleNote.get()),
  }), `klipara-scout: ${prefix}/s`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/leads`,
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      const state = await store.read()
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(leadsPage(state, localTime(new Date(), config.timeZone.get()).date, config))
    },
  }), `klipara-scout: ${prefix}/leads`)

  if (config.token !== '') {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${prefix}/command`,
      authenticate: false,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const header = req.headers.authorization ?? ''
        const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
        const json = (status: number, body: unknown): void => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
        if (!secretEquals(presented, config.token)) { res.writeHead(404); res.end(); return }
        if (req.method === 'GET') { json(200, { tools: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }); return }
        const body = await readBody(req, 64 * 1024)
        if (body === undefined) { json(413, { error: 'the command body is too large' }); return }
        let request: { name?: unknown; args?: unknown }
        try {
          request = JSON.parse(body) as { name?: unknown; args?: unknown }
        } catch {
          json(400, { error: 'the command body is not JSON' })
          return
        }
        const found = tools.find(t => t.name === request.name)
        if (found === undefined) { json(400, { error: `no such tool: ${String(request.name)}` }); return }
        const abort = new AbortController()
        res.on('close', () => { if (!res.writableEnded) abort.abort() })
        try {
          const args = typeof request.args === 'object' && request.args !== null ? request.args as Record<string, unknown> : {}
          json(200, { result: await found.execute(args, { signal: abort.signal } as ToolRunContext) })
        } catch (error) {
          json(200, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), `klipara-scout: ${prefix}/command`)
  }

  // Tools only on shift Sessions: they would otherwise ride every chat's prompt.
  const installed = new Map<Agent, { dispose: () => Promise<void> }>()
  const install = (agent: Agent): void => {
    if (installed.has(agent) || !String(agent.session.id).startsWith('scout-')) return
    installed.set(agent, agent.ctx.inject(['tools'], (scope) => {
      for (const definition of tools) scope.effect(() => scope.tools.register(definition), `klipara-scout: ${definition.name}`)
    }))
  }
  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const fiber = installed.get(agent)
    installed.delete(agent)
    void fiber?.dispose().catch(() => undefined)
  })

  // The shift clock: checked every minute, at most one shift per local day. A
  // start that fails is retried after half an hour rather than at the next
  // tick, so a lasting fault costs one alert per attempt, not one a minute.
  // Starts and failures go to stderr: the harness logger's warnings do not
  // reach the container log the operator reads.
  let starting = false
  let retryAt = 0
  const tick = async (): Promise<void> => {
    if (starting || !config.enabled.get() || Date.now() < retryAt) return
    const start = parseShiftTime(config.shiftTime.get())
    if (start === undefined) return
    const now = localTime(new Date(), config.timeZone.get())
    const state = await store.read()
    if (state.paused !== null || !shiftDue(now, start, state.lastShiftDate)) return
    starting = true
    const previous = state.lastShiftDate
    try {
      await store.update((s) => { s.lastShiftDate = now.date })
      await mkdir(config.workspacePath, { recursive: true })
      const sessionId = await startShift(ctx, {
        workspacePath: config.workspacePath,
        title: `Klipara Scout shift ${now.date}`,
        prompt: config.shiftPrompt.replaceAll('{skill}', join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'skills', 'klipara-scout', 'SKILL.md')),
        agentPreset: config.agentPreset,
        permissionPreset: config.permissionPreset,
        provider: config.provider.get(),
        model: config.model.get(),
      }, AbortSignal.timeout(120_000))
      process.stderr.write(`klipara-scout: started the ${now.date} shift as session ${sessionId}\n`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await store.update((s) => { s.lastShiftDate = previous })
      retryAt = Date.now() + 30 * 60_000
      process.stderr.write(`klipara-scout: the ${now.date} shift did not start (retrying in 30 minutes): ${reason}\n`)
      await notify(`Klipara Scout could not start today's shift (retrying in 30 minutes): ${reason}`)
    } finally {
      starting = false
    }
  }
  const timer = setInterval(() => { void tick() }, 60_000)
  ctx.effect(() => () => { clearInterval(timer) })
}
