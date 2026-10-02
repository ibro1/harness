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
import type { ParameterSchemaSpec, PreToolDecision, ToolDefinition, ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { bestCandidate, KliparaError, kliparaClient, type KliparaApi, type KliparaCandidate } from './klipara.ts'
import { samplePosterSource, serveSample, setSampleCover, storeSample } from './samples.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { EVENT_ID, ownerNote, parseEvent, recordEvent, verifySignature } from './inbound.ts'
import { readFeed, sameShow, searchPodcasts } from './podcasts.ts'
import { findContact } from './contacts.ts'
import { lookUpComment, nextVisibility, outreachStats, statsLine } from './comments.ts'
import { styleProblems } from './style.ts'
import { FallbackRouter, installFallback, localTime, parseShiftTime, shiftDue, startShift, whatsAppNotifier } from '@deepseek-ai/dsh-host-employee-kit'
import { advance, dayCount, LEAD_STAGES, ScoutStore, type Lead, type LeadStage, type ScoutState } from './store.ts'
import { channelFacts, execYtDlp, searchLongVideos, type ChannelFacts, type FoundVideo, type YtDlpRunner } from './youtube.ts'

export { bestCandidate, KliparaError, kliparaClient } from './klipara.ts'
export type { KliparaApi, KliparaCandidate, KliparaJob } from './klipara.ts'
export { localTime, parseShiftTime, shiftDue } from '@deepseek-ai/dsh-host-employee-kit'
export { ScoutStore, emptyState } from './store.ts'
export type { Lead, LeadStage, ScoutState } from './store.ts'
export type { YtDlpRunner } from './youtube.ts'
export { aboutLinks, emailsIn, findContact, hubLinks } from './contacts.ts'
export { lookUpComment, nextVisibility, outreachStats, statsLine } from './comments.ts'
export type { OutreachStats } from './comments.ts'

/** The part of a shift a failure happened in. */
export type ScoutStage = 'discover' | 'sample' | 'pitch' | 'reply-check' | 'inbound'

/**
 * One unexpected scout failure, for error reporting. It names the stage and
 * the lead or sample only; `redact` lists this lead's own strings (channel
 * name, address, video title) that must not leave the process even inside an
 * error message. Rule refusals (caps, link rules, pauses in force) are not failures.
 */
export interface ScoutFailure {
  stage: ScoutStage
  leadId?: string
  sampleId?: string
  error: unknown
  redact: string[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The prompt that opens a Klipara Scout shift or reply check. */
    'klipara-scout': {
      readonly kind: 'klipara-scout'
      readonly form: 'notice'
      readonly summary: string
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * An unexpected scout failure: a shift or reply check that did not start,
     * a search, Klipara call or sample copy that failed, or an outreach pause.
     * @param failure - the stage, the lead or sample id, the error, and the lead strings to redact.
     * @mode emit
     */
    'klipara-scout/failure'(failure: ScoutFailure): void
  }
}

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
  /** Pitches (emails, comments and follow-ups together) per local day. */
  pitchesPerDay: Volatile<number>
  /** Comment pitches per local day, within `pitchesPerDay`: a comment carries no clip, so it is the last resort. */
  commentsPerDay: Volatile<number>
  /** Days an email pitch waits unanswered before its one follow-up is due; 0 sends none. */
  followUpDays: Volatile<number>
  /**
   * YouTube Data API key for reading comments signed out. Empty: comment pitches are not checked, and the leads page
   * says so. Write-only on the settings page.
   */
  youtubeApiKey: Volatile<string>
  /** Minutes after posting before a comment pitch is first looked for. */
  commentCheckMinutes: Volatile<number>
  /** Hours after posting after which a comment still not found counts as held by YouTube. */
  commentHeldHours: Volatile<number>
  /** Held comments in a row that stop comment pitches until the owner resumes the scout; 0 never stops them. */
  heldCommentsPause: Volatile<number>
  /** Minutes between reply checks while a pitch awaits an answer; 0 leaves replies to the daily shift. */
  replyCheckMinutes: Volatile<number>
  /** Search phrases the shift rotates through. */
  topics: Volatile<string[]>
  minSubscribers: Volatile<number>
  maxSubscribers: Volatile<number>
  /** Skip channels already posting more Shorts than this. */
  maxShorts: Volatile<number>
  /** Two-letter podcast store country `scout_search_podcasts` searches, for example `ng`. */
  podcastCountry: Volatile<string>
  /** Skip shows whose newest episode is older than this many days. */
  podcastActiveDays: Volatile<number>
  /** The Klipara workspace API key (`klp_sk_live_…`). */
  kliparaApiKey: Volatile<string>
  /** WhatsApp chat name or number that hears about replies and pauses. */
  notifyTo: Volatile<string>
  /** Model route for the shift; empty uses the harness default model. */
  provider: Volatile<string>
  model: Volatile<string>
  /** Model a turn moves to when the shift's model fails for a provider reason; either empty turns the fallback off. */
  fallbackProvider: Volatile<string>
  fallbackModel: Volatile<string>
  /** Whether a turn on the fallback model may pitch; off holds pitches for the shift's own model. */
  fallbackPitches: Volatile<boolean>
  /** Minutes a failed shift model is left alone when the failure does not say when it is usable again. */
  fallbackCooldownMinutes: Volatile<number>
  /** Public link base a pitch gives for a sample; the link is `<base>/<id>`. Its origin may read the sample JSON. */
  sampleBaseUrl: Volatile<string>
  /** Days a sample stays served; 0 keeps samples for good. */
  sampleTtlDays: Volatile<number>
  /**
   * The browser MCP server signed in to the dedicated outreach Google account.
   * Empty: no pitch is reserved and no reply check runs, because the only other
   * browser is the DeerFlow one whose YouTube account Klipara downloads with.
   */
  outreachBrowser: Volatile<string>
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
  /** Secret Klipara signs free-clip requests with; write-only on the settings page. Empty refuses every request. */
  freeClipSecret: Volatile<string>
  /** The same secret from the deployment's environment; when set it wins over the settings value. */
  envFreeClipSecret: string
  workspacePath: string
  agentPreset: string
  permissionPreset: string
  /** The shift's opening message; `{skill}` becomes the skill file's path. */
  shiftPrompt: string
  ytDlp: string
  timeoutMs: number
  /** How often the plugin checks Klipara for finished samples. */
  sampleCheckMs: number
  /** The WhatsApp plugin's command route and token, for owner alerts. */
  whatsappUrl: string
  whatsappToken: string
  /** MCP server name of the browser scout Sessions must never use. */
  forbiddenBrowser: string
}

/** Composition config. */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  shiftTime: z.string().default('09:00').volatile(),
  timeZone: z.string().default('Africa/Lagos').volatile(),
  samplesPerDay: z.natural().default(3).volatile(),
  pitchesPerDay: z.natural().default(5).volatile(),
  commentsPerDay: z.natural().default(2).volatile(),
  followUpDays: z.natural().default(6).volatile(),
  youtubeApiKey: z.string().role('secret').default('').volatile(),
  commentCheckMinutes: z.natural().min(5).default(180).volatile(),
  commentHeldHours: z.natural().min(1).default(24).volatile(),
  heldCommentsPause: z.natural().default(2).volatile(),
  replyCheckMinutes: z.natural().default(15).volatile(),
  topics: z.array(z.string()).default(['nigerian podcast', 'african business podcast', 'nigerian interview']).volatile(),
  minSubscribers: z.natural().default(2000).volatile(),
  maxSubscribers: z.natural().default(300_000).volatile(),
  maxShorts: z.natural().default(10).volatile(),
  podcastCountry: z.string().default('ng').volatile(),
  podcastActiveDays: z.natural().default(60).volatile(),
  kliparaApiKey: z.string().default('').volatile(),
  notifyTo: z.string().default('').volatile(),
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  fallbackProvider: z.string().default('opencode').volatile(),
  fallbackModel: z.string().default('big-pickle').volatile(),
  fallbackPitches: z.boolean().default(false).volatile(),
  fallbackCooldownMinutes: z.natural().default(15).volatile(),
  sampleBaseUrl: z.string().default('https://klipara.linkfa.de/s').volatile(),
  sampleTtlDays: z.natural().default(30).volatile(),
  outreachBrowser: z.string().default('').volatile(),
  sampleHeadline: z.string().default('A clip from your latest video').volatile(),
  sampleNote: z.string().default('Cut by Klipara from your full episode. If you want more like this, just reply to the message it came with.').volatile(),
  dataDir: z.string().default(''),
  kliparaApi: z.string().default('https://klipara.linkfa.de/api/v1'),
  publicBaseUrl: z.string().default(''),
  path: z.string().default('/scout'),
  token: z.string().default(''),
  freeClipSecret: z.string().role('secret').default('').volatile(),
  envFreeClipSecret: z.string().default(''),
  workspacePath: z.string().default('/workspace/klipara-scout'),
  agentPreset: z.string().default('standard'),
  permissionPreset: z.string().default('workspace-write'),
  shiftPrompt: z.string().default('Run today\'s Klipara Scout shift. Your instructions are the klipara-scout skill at {skill}: read that file first, then follow it exactly.'),
  ytDlp: z.string().default('yt-dlp'),
  timeoutMs: z.natural().min(1000).default(60_000),
  sampleCheckMs: z.natural().min(30_000).default(120_000),
  whatsappUrl: z.string().default(''),
  whatsappToken: z.string().default(''),
  forbiddenBrowser: z.string().default('deerflow'),
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
  /** Hand an unexpected failure to error reporting, when it is loaded. */
  reportFailure?: (failure: ScoutFailure) => void
  /** HTTP for the podcast directory and feeds; the global fetch when omitted. */
  fetch?: typeof fetch
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

/**
 * Email pitches whose one follow-up is due: unanswered, not followed up, and older than `days`.
 * @param leads - every lead.
 * @param days - days a pitch waits; 0 means follow-ups are off.
 * @param now - the current time.
 * @returns the leads, oldest pitch first.
 */
export function followUpsDue(leads: readonly Lead[], days: number, now: Date): Lead[] {
  if (days <= 0) return []
  const cutoff = now.getTime() - days * 86_400_000
  return leads
    .filter(l => l.stage === 'pitched' && l.pitch?.via === 'email' && l.followUp === undefined && l.replies.length === 0 && Date.parse(l.pitch.at) <= cutoff)
    .sort((a, b) => (a.pitch?.at ?? '').localeCompare(b.pitch?.at ?? ''))
}

/**
 * Why a channel is outside the scout's limits.
 * @param facts - the channel.
 * @param config - the limits.
 * @returns the reason, or undefined when the channel fits.
 */
function unfitReason(facts: ChannelFacts, config: Config): string | undefined {
  const subs = facts.subscribers
  if (subs !== undefined && (subs < config.minSubscribers.get() || subs > config.maxSubscribers.get())) return `${String(subs)} subscribers`
  return facts.shortsCount > config.maxShorts.get() ? `already posts ${String(facts.shortsCount)}+ Shorts` : undefined
}

/**
 * A lead for a channel and one of its long videos. A channel outside the
 * limits is kept as a skipped lead, so no later search spends another
 * channel read on it.
 * @param video - the video a sample would be cut from.
 * @param facts - the channel.
 * @param reason - why it is skipped, if it is.
 * @param note - how it was found, for its history.
 * @param at - now.
 * @param extra - fields the source adds (a feed's email, the podcast).
 * @returns the lead.
 */
function channelLead(
  video: FoundVideo, facts: ChannelFacts, reason: string | undefined, note: string, at: string, extra: Partial<Lead> = {},
): Lead {
  const stage = reason === undefined ? 'found' : 'skipped'
  const email = extra.email ?? facts.email
  return {
    channelId: video.channelId,
    channelName: facts.channelName || video.channelName,
    channelUrl: facts.channelUrl,
    ...facts.subscribers === undefined ? {} : { subscribers: facts.subscribers },
    shortsCount: facts.shortsCount,
    ...extra,
    ...email === undefined ? {} : { email },
    videoId: video.videoId,
    videoUrl: video.videoUrl,
    videoTitle: video.title,
    durationMinutes: video.durationMinutes,
    stage,
    source: extra.source ?? 'scout',
    replies: [],
    history: [{ at, stage, note: reason === undefined ? note : `${note}; ${reason}` }],
    createdAt: at,
    updatedAt: at,
  }
}

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
 * The lead a tool names.
 * @param state - the scout state.
 * @param channelId - the lead's channel id.
 * @returns the lead.
 * @throws when no lead has that id.
 */
function findLead(state: ScoutState, channelId: string): Lead {
  const lead = state.leads.find(l => l.channelId === channelId)
  if (lead === undefined) throw new Error(`No lead with channel id ${channelId}; scout_leads lists them.`)
  return lead
}

/**
 * A lead's own strings, which error reports must not carry.
 * @param lead - the lead.
 * @returns its channel name, address, video title and URLs.
 */
export function leadStrings(lead: Lead): string[] {
  return [lead.channelName, lead.email, lead.videoTitle, lead.channelUrl, lead.videoUrl].filter((v): v is string => typeof v === 'string' && v !== '')
}

/** What one sample check found. */
export interface SampleCheck {
  /** `ready` when the lead just became `sampled`. */
  outcome: 'ready' | 'waiting' | 'skipped'
  text: string
}

/**
 * Advance a lead the sample check started on, unless something moved it while
 * the check ran: a creator who asked for a free clip meanwhile is `replied`,
 * and a finished sample must not put them back in line for a pitch.
 */
function stillSampling(lead: Lead, stage: LeadStage, at: string, note: string): void {
  if (lead.stage === 'sampling') advance(lead, stage, at, note)
  else lead.history.push({ at, stage: lead.stage, note: `${note}; stays ${lead.stage}` })
}

/**
 * Check one `sampling` lead's Klipara job and, once it is done, export the best
 * standalone clip, host it, and move the lead to `sampled`.
 * @param deps - the store, config and external calls.
 * @param channelId - the lead.
 * @param signal - cancels the calls.
 * @returns what happened.
 */
export async function finishSample(deps: ScoutDeps, channelId: string, signal: AbortSignal): Promise<SampleCheck> {
  const iso = (): string => deps.now().toISOString()
  const find = (state: ScoutState): Lead => findLead(state, channelId)
  const lead = find(await deps.store.read())
  if (lead.stage !== 'sampling' || lead.jobId === undefined) throw new Error(`${lead.channelName} is at stage ${lead.stage}, not sampling.`)
  const job = await deps.klipara.getJob(lead.jobId, signal)
  if (job.state === 'failed' || job.state === 'cancelled') {
    const why = `Klipara job ${job.state}${job.errorCode === undefined ? '' : `: ${job.errorCode}`}`
    await deps.store.update((s) => { stillSampling(find(s), 'skipped', iso(), why) })
    return { outcome: 'skipped', text: `The Klipara job ${job.state}${job.errorCode === undefined ? '' : ` (${job.errorCode})`}; ${lead.channelName} is skipped.` }
  }
  if (job.state !== 'succeeded') return { outcome: 'waiting', text: `Still ${job.state}; check again in a few minutes.` }
  const best = bestCandidate(await deps.klipara.candidates(lead.jobId, signal))
  if (best === undefined) {
    await deps.store.update((s) => { stillSampling(find(s), 'skipped', iso(), 'no clip stands alone') })
    return { outcome: 'skipped', text: `Klipara found no clip that stands alone in that video; ${lead.channelName} is skipped.` }
  }
  let exported: Awaited<ReturnType<KliparaApi['exportClip']>>
  try {
    exported = await deps.klipara.exportClip(best.clipId, signal)
  } catch (error) {
    // The same export is already running (the watcher and a shift's own check
    // overlapped); the next check replays its result under the same key.
    if (error instanceof KliparaError && error.code === 'idempotency_in_progress') {
      return { outcome: 'waiting', text: 'The export is already running; check again in a minute.' }
    }
    throw error
  }
  const sampleId = await storeSample(deps.samplesDir, exported.downloadUrl, {
    title: lead.videoTitle ?? '',
    creatorName: lead.channelName,
    sourceVideoUrl: lead.videoUrl ?? '',
  }, signal, { clipId: best.clipId, coverUrl: exported.thumbnailUrl ?? best.thumbnailUrl })
  const samplePageUrl = `${deps.sampleBase()}/${sampleId}`
  await deps.store.update((s) => {
    const l = find(s)
    l.sampleId = sampleId
    l.samplePageUrl = samplePageUrl
    stillSampling(l, 'sampled', iso(), `clip ${best.clipId} (${String(Math.round((best.endMs - best.startMs) / 1000))}s)`)
  })
  return {
    outcome: 'ready',
    text: `Sample ready for ${lead.channelName}: ${samplePageUrl} (clip ${String(Math.round(best.startMs / 1000))}s–${String(Math.round(best.endMs / 1000))}s of "${lead.videoTitle ?? ''}"). Pitch it with scout_pitch.`,
  }
}

/**
 * Put Klipara's designed cover on samples that still show a frame, when their
 * clip has one. Reading a job's candidates is free and returns fresh cover
 * links; a sample whose clip has no cover keeps its frame and is not asked
 * about again until the next start.
 * @param deps - the store and Klipara client.
 * @param signal - cancels the calls.
 * @returns how many samples got their cover.
 */
export async function backfillCovers(deps: ScoutDeps, signal: AbortSignal): Promise<number> {
  const state = await deps.store.read()
  const byJob = new Map<string, { sampleId: string; clipId: string }[]>()
  for (const lead of state.leads) {
    if (lead.sampleId === undefined || lead.jobId === undefined) continue
    if (await samplePosterSource(deps.samplesDir, lead.sampleId) === 'cover') continue
    // Samples stored before records named their clip: the history line that made them does.
    const clipId = lead.history.map(h => /^clip (\S+) /u.exec(h.note ?? '')?.[1]).find(id => id !== undefined)
    if (clipId === undefined) continue
    byJob.set(lead.jobId, [...byJob.get(lead.jobId) ?? [], { sampleId: lead.sampleId, clipId }])
  }
  let covered = 0
  for (const [jobId, samples] of byJob) {
    let candidates: KliparaCandidate[]
    try {
      candidates = await deps.klipara.candidates(jobId, signal)
    } catch (error) {
      process.stderr.write(`klipara-scout: no covers for job ${jobId}: ${error instanceof Error ? error.message : String(error)}\n`)
      deps.reportFailure?.({ stage: 'sample', error, redact: [] })
      continue
    }
    for (const { sampleId, clipId } of samples) {
      const cover = candidates.find(c => c.clipId === clipId)?.thumbnailUrl
      try {
        if (cover && await setSampleCover(deps.samplesDir, sampleId, cover, signal)) covered++
      } catch (error) {
        // One unreadable sample must not stop the others.
        process.stderr.write(`klipara-scout: no cover for sample ${sampleId}: ${error instanceof Error ? error.message : String(error)}\n`)
        deps.reportFailure?.({ stage: 'sample', sampleId, error, redact: [] })
      }
    }
  }
  return covered
}

/** Hours between looks at a comment that has not been found yet. */
const COMMENT_RECHECK_HOURS = 1

/**
 * Look up each comment pitch that is due a check, signed out, and record what
 * YouTube shows. A comment still missing `commentHeldHours` after posting is
 * held: the owner hears about it, and after `heldCommentsPause` held comments
 * in a row (counting only comments whose fate is known), comment pitches stop
 * until the owner resumes the scout. Runs without a model turn.
 * @param deps - the store, config, HTTP and owner alerts.
 * @param signal - cancels the lookups.
 * @returns one line per comment checked.
 */
export async function checkComments(deps: ScoutDeps, signal: AbortSignal): Promise<string[]> {
  const { config } = deps
  const key = config.youtubeApiKey.get().trim()
  if (key === '') return []
  const now = deps.now()
  const firstAfterMs = config.commentCheckMinutes.get() * 60_000
  const heldHours = config.commentHeldHours.get()
  const state = await deps.store.read()
  const due = state.leads.filter((lead) => {
    const pitch = lead.pitch
    if (pitch?.via !== 'comment' || lead.videoId === undefined) return false
    const visibility = pitch.visibility?.state ?? 'pending'
    if (visibility !== 'pending' && visibility !== 'unseen') return false
    const age = now.getTime() - Date.parse(pitch.at)
    const last = pitch.visibility?.checkedAt === undefined ? undefined : Date.parse(pitch.visibility.checkedAt)
    return age >= firstAfterMs && (last === undefined || now.getTime() - last >= COMMENT_RECHECK_HOURS * 3_600_000)
  })
  const lines: string[] = []
  const held: Lead[] = []
  for (const lead of due) {
    const pitch = lead.pitch
    if (pitch === undefined || lead.videoId === undefined) continue
    const found = await lookUpComment(deps.fetch ?? fetch, key, lead.videoId, pitch.text, signal)
    const ageHours = (now.getTime() - Date.parse(pitch.at)) / 3_600_000
    // Comments off or the video gone settle a comment as unknown; a bad key or a spent quota is retried next hour.
    const permanent = found.state !== 'unknown' || /commentsDisabled|videoNotFound/u.test(found.detail ?? '')
    const next = permanent ? nextVisibility(pitch.visibility?.state ?? 'pending', found.state, ageHours, heldHours) : pitch.visibility?.state ?? 'pending'
    const stored = await deps.store.update((s) => {
      const l = s.leads.find(x => x.channelId === lead.channelId)
      if (l?.pitch === undefined) return undefined
      l.pitch.visibility = { state: next, checkedAt: now.toISOString(), ...found.detail === undefined ? {} : { detail: found.detail } }
      if (next === 'held') l.history.push({ at: now.toISOString(), stage: l.stage, note: 'comment held by YouTube: not visible signed out' })
      return { ...l }
    })
    if (stored === undefined) continue
    if (next === 'held') held.push(stored)
    if (found.state === 'unknown') deps.reportFailure?.({ stage: 'pitch', leadId: lead.channelId, error: new Error(`Comment check failed: ${found.detail ?? 'unknown'}`), redact: leadStrings(lead) })
    lines.push(`${lead.channelName}: ${next}${found.detail === undefined ? '' : ` (${found.detail})`}`)
  }
  for (const lead of held) {
    await deps.notify(`Klipara Scout: the comment pitch to ${lead.channelName} is not visible to anyone else ${String(heldHours)} hours after posting, so YouTube is holding it. The creator has not seen it.\n\nVideo: ${lead.videoUrl ?? ''}\nSample: ${lead.samplePageUrl ?? ''}`)
  }
  const limit = config.heldCommentsPause.get()
  if (held.length > 0 && limit > 0) {
    const stopped = await deps.store.update((s) => {
      if (s.commentsPaused !== undefined && s.commentsPaused !== null) return false
      const decided = s.leads
        .filter(l => l.pitch?.via === 'comment' && (l.pitch.visibility?.state === 'visible' || l.pitch.visibility?.state === 'held'))
        .sort((a, b) => (a.pitch?.at ?? '').localeCompare(b.pitch?.at ?? ''))
      const recent = decided.slice(-limit)
      if (recent.length < limit || !recent.every(l => l.pitch?.visibility?.state === 'held')) return false
      s.commentsPaused = { reason: `YouTube held the last ${String(limit)} comment pitches`, at: now.toISOString() }
      return true
    })
    if (stopped) {
      await deps.notify(`Klipara Scout: comment pitches are STOPPED. YouTube held the last ${String(limit)} comments, which usually means the outreach account is flagged. Email pitches go on. To restart comments, open a Klipara Scout session and say "resume the scout".`)
      lines.push('Comment pitches stopped.')
    }
  }
  return lines
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
        const due = followUpsDue(state.leads, config.followUpDays.get(), deps.now())
        return [
          `Today (${today()}): samples ${String(day.samples)}/${String(config.samplesPerDay.get())}, pitches ${String(day.pitches)}/${String(config.pitchesPerDay.get())}, of which comments ${String(day.comments ?? 0)}/${String(config.commentsPerDay.get())}.`,
          state.paused === null ? 'Outreach is running.' : `Outreach is PAUSED since ${state.paused.at}: ${state.paused.reason}`,
          ...state.commentsPaused === undefined || state.commentsPaused === null ? [] : [`Comment pitches are STOPPED since ${state.commentsPaused.at}: ${state.commentsPaused.reason}. Pitch by email only.`],
          `Leads: ${counts}.`,
          due.length === 0 ? 'No follow-ups due.' : `Follow-ups due (scout_follow_up): ${due.map(l => `${l.channelName} (${l.channelId}), emailed ${l.pitch?.at.slice(0, 10) ?? ''}`).join('; ')}.`,
          statsLine(outreachStats(state.leads)),
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
        let videos: Awaited<ReturnType<typeof searchLongVideos>>
        try {
          videos = await searchLongVideos(deps.ytDlp, topic, limit, exec.signal)
        } catch (error) {
          deps.reportFailure?.({ stage: 'discover', error, redact: [topic] })
          throw error
        }
        const known = new Set(state.leads.map(l => l.channelId))
        const fresh = [...new Map(videos.filter(v => !known.has(v.channelId)).map(v => [v.channelId, v])).values()]
        const kept: Lead[] = []
        const skipped: string[] = []
        for (const video of fresh) {
          const facts = await channelFacts(deps.ytDlp, video.channelId, config.maxShorts.get() + 1, exec.signal)
          const reason = unfitReason(facts, config)
          if (reason !== undefined) skipped.push(`${video.channelName}: ${reason}`)
          kept.push(channelLead(video, facts, reason, `search: ${topic}`, iso()))
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
      name: 'scout_search_podcasts',
      description: 'Search the podcast directory for active shows on a topic, read each new show\'s feed for the owner\'s contact email, find the show\'s long videos on YouTube, and save the ones that fit as `found` leads with that email, so they are pitched by email rather than by comment. Shows without an email or a video version on YouTube are skipped. When a show\'s channel is already a lead without an email, the email is added to it. Returns the new leads.',
      parameters: {
        topic: { type: 'string', description: 'Search words. Omit to use the next configured topic.' },
        limit: { type: 'integer', description: 'Shows to read from the directory, 1 to 30. Defaults to 15.' },
      },
      run: async (args, exec) => {
        const fetcher = deps.fetch ?? fetch
        const state = await store.read()
        const topics = config.topics.get()
        const topic = typeof args['topic'] === 'string' && args['topic'].trim() !== ''
          ? args['topic'].trim()
          : topics[state.leads.length % Math.max(topics.length, 1)] ?? 'podcast'
        const limit = Math.min(Math.max(typeof args['limit'] === 'number' ? args['limit'] : 15, 1), 30)
        let shows: Awaited<ReturnType<typeof searchPodcasts>>
        try {
          shows = await searchPodcasts(fetcher, topic, config.podcastCountry.get().trim().toLowerCase() || 'ng', limit, exec.signal)
        } catch (error) {
          deps.reportFailure?.({ stage: 'discover', error, redact: [topic] })
          throw error
        }
        const seen = new Set(state.podcastsSeen ?? [])
        const activeSince = deps.now().getTime() - config.podcastActiveDays.get() * 86_400_000
        const fresh = shows.filter(show => !seen.has(show.feedUrl))
        const kept: Lead[] = []
        const emailed: string[] = []
        const passed: string[] = []
        const read: string[] = []
        for (const show of fresh) {
          read.push(show.feedUrl)
          if (show.lastRelease !== undefined && new Date(show.lastRelease).getTime() < activeSince) {
            passed.push(`${show.title}: no episode in ${String(config.podcastActiveDays.get())} days`)
            continue
          }
          let feed: Awaited<ReturnType<typeof readFeed>>
          try {
            feed = await readFeed(fetcher, show.feedUrl, exec.signal)
          } catch (error) {
            passed.push(`${show.title}: feed unreadable (${error instanceof Error ? error.message : String(error)})`)
            continue
          }
          if (feed.email === undefined) {
            passed.push(`${show.title}: no contact email in its feed`)
            continue
          }
          // The show's video version: its newest long uploads whose channel carries the show's name.
          const videos = await searchLongVideos(deps.ytDlp, show.title, 5, exec.signal)
          const video = videos.find(v => feed.youtubeChannelIds.includes(v.channelId)) ?? videos.find(v => sameShow(show, v.channelName))
          if (video === undefined) {
            passed.push(`${show.title}: no recent long video on YouTube`)
            continue
          }
          const sameChannel = (lead: Lead): boolean => lead.channelId === video.channelId
          const existing = (await store.read()).leads.find(sameChannel) ?? kept.find(sameChannel)
          if (existing !== undefined) {
            if (existing.email === undefined) {
              const address = feed.email
              await store.update((s) => {
                const lead = s.leads.find(l => l.channelId === video.channelId)
                if (lead !== undefined && lead.email === undefined) {
                  lead.email = address
                  lead.updatedAt = iso()
                }
              })
              emailed.push(`${existing.channelName}: email ${address} from its podcast feed`)
            }
            continue
          }
          const facts = await channelFacts(deps.ytDlp, video.channelId, config.maxShorts.get() + 1, exec.signal)
          const reason = unfitReason(facts, config)
          if (reason !== undefined) passed.push(`${show.title}: ${reason}`)
          kept.push(channelLead(video, facts, reason, `podcast search: ${topic}`, iso(), {
            email: feed.email,
            source: 'podcast',
            podcast: { title: show.title, feedUrl: show.feedUrl, directoryUrl: show.directoryUrl },
          }))
        }
        await store.update((s) => {
          const have = new Set(s.leads.map(l => l.channelId))
          s.leads.push(...kept.filter(l => !have.has(l.channelId)))
          s.podcastsSeen = [...s.podcastsSeen ?? [], ...read].slice(-5000)
        })
        const found = kept.filter(l => l.stage === 'found')
        return [
          `Searched podcasts for "${topic}": ${String(shows.length)} shows, ${String(fresh.length)} not read before, ${String(found.length)} saved as leads with an email.`,
          ...found.map(describe),
          ...emailed.length === 0 ? [] : [`Email added to existing leads: ${emailed.join('; ')}.`],
          ...passed.length === 0 ? [] : [`Passed over: ${passed.join('; ')}.`],
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
          deps.reportFailure?.({ stage: 'sample', leadId: lead.channelId, error, redact: leadStrings(lead) })
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
      description: 'Check a `sampling` lead\'s Klipara job now. When analysis is done, export the best standalone clip (spends one Klip), host it, and move the lead to `sampled` with its public sample link. A failed or clipless job moves the lead to `skipped`. The plugin also does this by itself every few minutes and tells the shift when samples are ready.',
      parameters: { channel_id: channelParameter },
      run: async (args, exec) => (await finishSample(deps, String(args['channel_id']), exec.signal)).text,
    }),
    tool({
      name: 'scout_pitch',
      description: 'Reserve one pitch for a `sampled` lead and record exactly what will be sent. Call it BEFORE sending, then send exactly this text from the outreach account: by email to the lead\'s address, or as a comment on the lead\'s video. An email must contain the sample link; a comment must contain no link at all (say what you clipped and ask them to reply). It refuses when no outreach account is configured, outreach is paused, today\'s pitch cap is used, the link rule is broken, an email subject starts with Re: or Fwd:, the text has machine-writing tells (long dashes, stock praise, "let me know if you would like"), or the text is too close to an earlier pitch.',
      parameters: {
        channel_id: channelParameter,
        via: { type: 'string', required: true, enum: ['email', 'comment'], description: 'email when the lead has an address, otherwise comment.' },
        to: { type: 'string', required: true, description: 'The email address, or the URL of the video the comment goes on.' },
        text: { type: 'string', required: true, description: 'The whole message, written for this creator and this video: with the sample link in an email, with no link in a comment.' },
      },
      run: async (args) => {
        const channelId = String(args['channel_id'])
        const via = args['via'] === 'email' ? 'email' : 'comment'
        const to = String(args['to']).trim()
        const text = String(args['text']).trim()
        return await store.update((s) => {
          if (config.outreachBrowser.get().trim() === '') {
            throw new Error('No outreach account is configured, so nothing may be sent: the only browser is the DeerFlow one, whose YouTube account Klipara downloads with. Stop pitching and tell the owner.')
          }
          refuseWhilePaused(s)
          const lead = findLead(s, channelId)
          if (lead.inbound !== undefined) throw new Error(`${lead.channelName} asked Klipara for a free clip themselves; they are the owner's to follow up, never pitched.`)
          if (lead.stage !== 'sampled' || lead.samplePageUrl === undefined) throw new Error(`${lead.channelName} is at stage ${lead.stage}; only a sampled lead is pitched.`)
          if (via === 'email' && !text.includes(lead.samplePageUrl)) throw new Error(`An email pitch must contain the sample link ${lead.samplePageUrl}.`)
          if (via === 'comment') {
            // A comment carries no clip, so it is only for a creator with no address anywhere.
            if (lead.email !== undefined) throw new Error(`${lead.channelName} has an email address (${lead.email}); pitch by email, which carries the clip.`)
            if (lead.contactSearch === undefined) throw new Error(`Call scout_find_email for ${lead.channelName} first: a comment cannot carry the clip, so it is only for creators with no address anywhere.`)
            if (s.commentsPaused !== undefined && s.commentsPaused !== null) throw new Error(`Comment pitches are stopped (${s.commentsPaused.reason}). Pitch only leads with an email; leave this one for the owner.`)
          }
          if (via === 'comment' && /https?:\/\/|www\.|\b[\w-]+\.(?:de|com|net|org|io|tv|ly|co)\b/iu.test(text)) {
            throw new Error('A comment pitch must contain no link: YouTube hides comments with links. Say what you clipped and ask them to reply for it.')
          }
          const subject = /^\s*subject:\s*(.*)$/imu.exec(text)?.[1] ?? text.split('\n').find(line => line.trim() !== '') ?? ''
          if (via === 'email' && /^\s*(?:re|fwd?)\s*:/iu.test(subject)) {
            throw new Error('An email pitch may not open with a "Re:" or "Fwd:" subject: it pretends to continue a conversation that never happened, and Gmail flags it. Write a plain subject naming their episode.')
          }
          const tells = styleProblems(text)
          if (tells.length > 0) {
            throw new Error(`This pitch reads as machine-written, which creators ignore and spam filters flag. Rewrite it the way a person would type a quick note, then call scout_pitch again. Found: ${tells.join('; ')}.`)
          }
          if (via === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(to)) throw new Error('An email pitch needs an email address in `to`.')
          if (via === 'comment' && !/youtube\.com|youtu\.be/u.test(to)) throw new Error('A comment pitch needs the video URL in `to`.')
          const earlier = s.leads.flatMap(l => l.pitch === undefined ? [] : [l.pitch.text]).slice(-30)
          const closest = Math.max(0, ...earlier.map(t => overlap(t, text)))
          if (closest >= 0.6) throw new Error(`This pitch is ${String(Math.round(closest * 100))}% the same words as an earlier one; YouTube and Gmail flag repeated text. Rewrite it around this creator's video.`)
          const day = dayCount(s, today())
          if (day.pitches >= config.pitchesPerDay.get()) throw new Error(`Today's pitch cap (${String(config.pitchesPerDay.get())}) is reached. End the shift.`)
          if (via === 'comment' && (day.comments ?? 0) >= config.commentsPerDay.get()) {
            throw new Error(`Today's comment cap (${String(config.commentsPerDay.get())}) is reached. Pitch leads with an email, or leave this one for tomorrow.`)
          }
          day.pitches++
          if (via === 'comment') day.comments = (day.comments ?? 0) + 1
          lead.pitch = { via, to, text, at: iso(), ...via === 'comment' ? { visibility: { state: 'pending' as const } } : {} }
          advance(lead, 'pitched', iso(), `${via} to ${to}`)
          return `Pitch ${String(day.pitches)}/${String(config.pitchesPerDay.get())} reserved. Now send exactly this ${via === 'email' ? `email to ${to}` : `comment on ${to}`} using only the "${config.outreachBrowser.get().trim()}" browser tools, never the deerflow browser. If sending fails or YouTube or Gmail shows any warning, captcha or restriction, call scout_pause immediately.`
        })
      },
    }),
    tool({
      name: 'scout_find_email',
      description: 'Look for a lead\'s email before pitching by comment: the channel\'s About page links, its website\'s home, contact and about pages, Linktree-style pages, and a podcast with the same name. Saves an address it finds on the lead (pitch it by email then) and the social profiles it saw for the owner. A lead with no email must have been searched before scout_pitch accepts a comment for it.',
      parameters: { channel_id: channelParameter },
      run: async (args, exec) => {
        const channelId = String(args['channel_id'])
        const lead = findLead(await store.read(), channelId)
        if (lead.email !== undefined) return `${lead.channelName} already has an email: ${lead.email}. Pitch by email.`
        const result = await findContact(deps.fetch ?? fetch, lead, config.podcastCountry.get(), exec.signal)
        await store.update((s) => {
          const l = findLead(s, channelId)
          l.contactSearch = { at: iso(), tried: result.tried, ...result.email === undefined ? {} : { found: result.email } }
          if (result.socials.length > 0) l.socials = result.socials
          if (result.email !== undefined && l.email === undefined) l.email = result.email
          l.updatedAt = iso()
        })
        return [
          result.email === undefined
            ? `No email found for ${lead.channelName}. A comment pitch is allowed (no link in it), within today's comment cap.`
            : `Found ${result.email} for ${lead.channelName}; it is saved on the lead. Pitch by email.`,
          `Looked at: ${result.tried.join('; ')}.`,
          ...result.socials.length === 0 ? [] : [`Social profiles, for the owner only (do not message them): ${result.socials.join(', ')}.`],
        ].join('\n')
      },
    }),
    tool({
      name: 'scout_follow_up',
      description: 'Reserve the one follow-up for an email pitch that went unanswered (scout_status lists the ones due), then send exactly this text as a reply in the same Gmail thread as the pitch. 2 to 4 short lines, the sample link again, no pressure; never a second follow-up. Counts against today\'s pitch cap. It refuses a lead not due, a text without the sample link, machine-writing tells, or text too close to the original pitch.',
      parameters: {
        channel_id: channelParameter,
        text: { type: 'string', required: true, description: 'The follow-up body, with the sample link. No subject: it is a reply in the pitch\'s thread.' },
      },
      run: async (args) => {
        const channelId = String(args['channel_id'])
        const text = String(args['text']).trim()
        return await store.update((s) => {
          if (config.outreachBrowser.get().trim() === '') throw new Error('No outreach account is configured, so nothing may be sent. Tell the owner.')
          refuseWhilePaused(s)
          const lead = findLead(s, channelId)
          if (!followUpsDue([lead], config.followUpDays.get(), deps.now()).includes(lead)) {
            throw new Error(`${lead.channelName} has no follow-up due: only an email pitch unanswered for ${String(config.followUpDays.get())} days gets one, and only once.`)
          }
          if (lead.samplePageUrl === undefined || !text.includes(lead.samplePageUrl)) throw new Error(`The follow-up must contain the sample link ${lead.samplePageUrl ?? ''}.`)
          const tells = styleProblems(text)
          if (tells.length > 0) throw new Error(`This reads as machine-written. Rewrite it as a short human note. Found: ${tells.join('; ')}.`)
          if (lead.pitch !== undefined && overlap(lead.pitch.text, text) >= 0.6) throw new Error('This repeats the original pitch; write a short new note that points back to the clip.')
          const day = dayCount(s, today())
          if (day.pitches >= config.pitchesPerDay.get()) throw new Error(`Today's pitch cap (${String(config.pitchesPerDay.get())}) is reached. End the shift.`)
          day.pitches++
          lead.followUp = { text, at: iso() }
          lead.updatedAt = iso()
          lead.history.push({ at: iso(), stage: lead.stage, note: 'follow-up email' })
          return `Follow-up reserved. Now open the outreach account's Gmail, find the pitch you sent to ${lead.pitch?.to ?? ''} in Sent, reply to it in the same thread with exactly this text, and confirm it appears in the thread. Use only the "${config.outreachBrowser.get().trim()}" browser tools.`
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
        // The reason describes a page the model saw; only that outreach paused is reported.
        deps.reportFailure?.({ stage: 'pitch', error: new Error('Outreach paused by the shift (a warning, captcha or failed send)'), redact: [reason] })
        const sent = await deps.notify(`Klipara Scout PAUSED: ${reason}\n\nNo outreach runs until you resume it: open a Klipara Scout session and say "resume the scout".`)
        return `Outreach paused. Owner alert: ${sent}. End the shift now.`
      },
    }),
    tool({
      name: 'scout_resume',
      description: 'Resume outreach after a pause, and comment pitches after YouTube held too many. Only when the owner explicitly asks for it in this conversation; never on your own.',
      parameters: {},
      run: async () => {
        const was = await store.update((s) => {
          const both = { paused: s.paused, comments: s.commentsPaused ?? null }
          s.paused = null
          s.commentsPaused = null
          return both
        })
        const lines = [
          was.paused === null ? 'Outreach was not paused.' : `Outreach resumed (it was paused for: ${was.paused.reason}).`,
          ...was.comments === null ? [] : [`Comment pitches resumed (they were stopped for: ${was.comments.reason}).`],
        ]
        return lines.join(' ')
      },
    }),
  ]
}

/**
 * The origin allowed to read sample JSON and files: the sample link base's own.
 * @param base - the configured sample link base.
 * @returns its origin, or `null` (no cross-origin reads) when it is not a URL.
 */
function corsOrigin(base: string): string {
  try {
    return new URL(base).origin
  } catch {
    // An unparsable base allows no page to read the JSON.
    return 'null'
  }
}

/**
 * Whether an agent drives a scout shift or reply-check Session.
 * @param agent - the agent.
 * @returns true for a Session this plugin started.
 */
function isScoutSession(agent: Agent): boolean {
  return String(agent.session.id).startsWith('scout-')
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
<body><h1>Klipara Scout</h1><p>${html(statsLine(outreachStats(state.leads)))}</p><p>Today ${html(date)}: samples ${String(day.samples)}/${String(config.samplesPerDay.get())}, pitches ${String(day.pitches)}/${String(config.pitchesPerDay.get())}. ${state.paused === null ? 'Outreach running.' : `<strong>Paused: ${html(state.paused.reason)}</strong>`}</p>
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
  const reportFailure = (failure: ScoutFailure): void => { ctx.emit('klipara-scout/failure', failure) }
  const notify = whatsAppNotifier({ url: config.whatsappUrl, token: config.whatsappToken, to: () => config.notifyTo.get() })
  const deps: ScoutDeps = {
    store,
    config,
    ytDlp: execYtDlp(config.ytDlp, config.timeoutMs),
    klipara: kliparaClient(config.kliparaApi, () => config.kliparaApiKey.get(), config.timeoutMs),
    samplesDir,
    sampleBase: () => config.sampleBaseUrl.get().replace(/\/+$/u, ''),
    notify,
    now: () => new Date(),
    reportFailure,
  }
  const tools = buildScoutTools(deps)

  // The fallback model: a scout turn whose model fails for a provider reason,
  // after the harness's own retries, retries on the fallback and finishes the
  // turn there.
  const route = (provider: string, model: string): { provider: string; model: string } | undefined =>
    provider.trim() === '' || model.trim() === '' ? undefined : { provider: provider.trim(), model: model.trim() }
  const router = new FallbackRouter({
    fallback: () => route(config.fallbackProvider.get(), config.fallbackModel.get()),
    shift: () => route(config.provider.get(), config.model.get()),
    cooldownMs: () => config.fallbackCooldownMinutes.get() * 60_000,
    onSwitch: (change) => {
      const from = `${change.from.provider}/${change.from.model}`
      const to = `${change.to.provider}/${change.to.model}`
      const until = localTime(change.until, config.timeZone.get())
      const at = `${String(Math.floor(until.minutes / 60)).padStart(2, '0')}:${String(until.minutes % 60).padStart(2, '0')}${until.date === localTime(new Date(), config.timeZone.get()).date ? '' : ` on ${until.date}`}`
      process.stderr.write(`klipara-scout: ${from} failed in ${change.sessionId} turn ${String(change.turn)} (${change.failure.code}: ${change.failure.message.slice(0, 300)}); scout turns use ${to} until ${change.until.toISOString()}\n`)
      void notify(`Klipara Scout: ${from} failed (${change.failure.message.slice(0, 160)}). Scout turns use ${to} until ${at}${change.stated ? ', when its quota resets' : ''}, then try ${from} again${config.fallbackPitches.get() ? '' : '; pitches wait for it'}.`)
    },
  })
  const pitchHeld = (sessionId: string, tool: string): string | undefined =>
    (tool === 'scout_pitch' || tool === 'scout_follow_up') && !config.fallbackPitches.get() && router.onFallback(sessionId)
      ? `Pitching and follow-ups are held while this turn runs on the fallback model (${config.fallbackModel.get()}): leave them for the shift's own model, and do the rest of the work.`
      : undefined
  installFallback(ctx, router, isScoutSession)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: `${prefix}/s`,
    authenticate: false,
    handler: (req: IncomingMessage, res: ServerResponse) => serveSample(req, res, samplesDir, `${prefix}/s`, {
      fileBase: `${config.publicBaseUrl.replace(/\/+$/u, '')}${prefix}/s`,
      corsOrigin: corsOrigin(config.sampleBaseUrl.get()),
      ttlDays: config.sampleTtlDays.get(),
      headline: config.sampleHeadline.get(),
      note: config.sampleNote.get(),
    }),
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

  // The leads as JSON, for the table on the Klipara Scout settings page.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/leads.json`,
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      const state = await store.read()
      const date = localTime(new Date(), config.timeZone.get()).date
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({
        date,
        today: state.days[date] ?? { samples: 0, pitches: 0 },
        caps: { samples: config.samplesPerDay.get(), pitches: config.pitchesPerDay.get() },
        paused: state.paused,
        commentsPaused: state.commentsPaused ?? null,
        commentChecks: config.youtubeApiKey.get().trim() !== '',
        stats: outreachStats(state.leads),
        // Newest first, with skipped channels after every lead still in play.
        leads: [...state.leads].reverse().sort((a, b) => Number(a.stage === 'skipped') - Number(b.stage === 'skipped')),
      }))
    },
  }), `klipara-scout: ${prefix}/leads.json`)

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
        let request: { name?: unknown; args?: unknown; session?: unknown }
        try {
          request = JSON.parse(body) as { name?: unknown; args?: unknown; session?: unknown }
        } catch {
          json(400, { error: 'the command body is not JSON' })
          return
        }
        const found = tools.find(t => t.name === request.name)
        if (found === undefined) { json(400, { error: `no such tool: ${String(request.name)}` }); return }
        const held = pitchHeld(typeof request.session === 'string' ? request.session : '', found.name)
        if (held !== undefined) { json(200, { error: held }); return }
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

  // Creators who asked Klipara for a free clip on its own page: signed by
  // Klipara, recorded so the scout never cold-pitches them, and the owner told.
  const freeClipSecret = (): { secret: string; source: 'environment' | 'settings' | 'none' } => {
    const fromEnv = config.envFreeClipSecret.trim()
    if (fromEnv !== '') return { secret: fromEnv, source: 'environment' }
    const fromSettings = config.freeClipSecret.get().trim()
    return fromSettings === '' ? { secret: '', source: 'none' } : { secret: fromSettings, source: 'settings' }
  }
  // Whether a secret is in force and the address to give Klipara; never the secret.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/inbound/status`,
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      const path = `${prefix}/inbound/free-clip`
      const url = config.publicBaseUrl === '' ? null : `${config.publicBaseUrl.replace(/\/+$/u, '')}${path}`
      res.end(JSON.stringify({ source: freeClipSecret().source, path, url }))
    },
  }), `klipara-scout: ${prefix}/inbound/status`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/inbound/free-clip`,
    authenticate: false,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const json = (status: number, body: unknown): void => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (req.method !== 'POST') { json(405, { error: 'POST only' }); return }
      const raw = await readBody(req, 16 * 1024)
      if (raw === undefined) { json(413, { error: 'the body is too large' }); return }
      const header = (name: string): string => { const v = req.headers[name]; return Array.isArray(v) ? v[0] ?? '' : v ?? '' }
      const { secret } = freeClipSecret()
      if (secret === '') { json(401, { error: 'the free-clip hand-off has no secret set in the harness' }); return }
      const verdict = verifySignature(secret, header('x-klipara-timestamp'), header('x-klipara-signature'), raw, Math.floor(Date.now() / 1000))
      if (verdict !== 'ok') { json(401, { error: verdict }); return }
      const eventId = header('x-klipara-event-id')
      if (!EVENT_ID.test(eventId)) { json(400, { error: 'X-Klipara-Event-Id is missing or malformed' }); return }
      const event = parseEvent(raw)
      // A malformed body will not improve on retry; 422 tells Klipara so, and the failure report says why.
      if (typeof event === 'string') {
        deps.reportFailure?.({ stage: 'inbound', error: new Error(`Klipara free-clip event ${eventId}: ${event}`), redact: [] })
        json(422, { error: event })
        return
      }
      const recorded = await store.update(s => recordEvent(s, eventId, event, new Date().toISOString()))
      json(200, { ok: true, duplicate: recorded.duplicate })
      if (recorded.duplicate) return
      // The channel's name, for the leads page and the owner's note; best effort, after answering.
      if (recorded.created) {
        try {
          const facts = await channelFacts(deps.ytDlp, event.channelId, config.maxShorts.get() + 1, AbortSignal.timeout(60_000))
          await store.update((s) => {
            const lead = s.leads.find(l => l.channelId === event.channelId)
            if (lead === undefined) return
            if (lead.channelName === lead.channelId && facts.channelName !== '') lead.channelName = facts.channelName
            if (lead.subscribers === undefined && facts.subscribers !== undefined) lead.subscribers = facts.subscribers
            lead.shortsCount ??= facts.shortsCount
            recorded.lead.channelName = lead.channelName
          })
        } catch (error) {
          process.stderr.write(`klipara-scout: no channel facts for free-clip requester ${event.channelId}: ${error instanceof Error ? error.message : String(error)}\n`)
        }
      }
      const note = ownerNote(recorded, event)
      if (note !== undefined) await notify(note)
    },
  }), `klipara-scout: ${prefix}/inbound/free-clip`)

  // Scout Sessions never drive the DeerFlow browser: its Google account is the
  // one Klipara downloads YouTube videos with, and outreach from it risks that
  // account. Refused where the call runs, so no prompt or tool list bypasses it.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.agent !== undefined && isScoutSession(exec.agent) && exec.name.startsWith(`mcp__${config.forbiddenBrowser}__`)) {
      return { kind: 'deny', reason: `Scout sessions may not use the ${config.forbiddenBrowser} browser: its Google account is the one Klipara downloads with. Use the ${config.outreachBrowser.get() || 'outreach'} browser tools.` }
    }
    const held = exec.agent === undefined ? undefined : pitchHeld(String(exec.agent.session.id), exec.name)
    if (held !== undefined) return { kind: 'deny', reason: held }
    return next()
  })

  // Tools only on shift Sessions: they would otherwise ride every chat's prompt.
  const installed = new Map<Agent, { dispose: () => Promise<void> }>()
  const install = (agent: Agent): void => {
    if (installed.has(agent) || !isScoutSession(agent)) return
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
        sessionPrefix: 'scout-',
        source: summary => ({ kind: 'klipara-scout', form: 'notice', summary }),
      }, AbortSignal.timeout(120_000))
      await store.update((s) => { s.lastShiftSession = sessionId })
      process.stderr.write(`klipara-scout: started the ${now.date} shift as session ${sessionId}\n`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      reportFailure({ stage: 'discover', error, redact: [] })
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

  // The sample watcher: Klipara takes minutes per video, longer than a shift's
  // turn, so the plugin finishes samples itself and wakes the latest shift to
  // pitch them. When that Session is no longer live, they wait for the next shift.
  let watching = false
  const watch = async (): Promise<void> => {
    if (watching || config.kliparaApiKey.get().trim() === '') return
    watching = true
    try {
      const state = await store.read()
      if (state.paused !== null) return
      const ready: string[] = []
      for (const lead of state.leads.filter(l => l.stage === 'sampling')) {
        try {
          const check = await finishSample(deps, lead.channelId, AbortSignal.timeout(5 * 60_000))
          if (check.outcome === 'ready') ready.push(check.text)
        } catch (error) {
          process.stderr.write(`klipara-scout: sample check for ${lead.channelName} failed: ${error instanceof Error ? error.message : String(error)}\n`)
          reportFailure({ stage: 'sample', leadId: lead.channelId, error, redact: leadStrings(lead) })
        }
      }
      if (ready.length === 0) return
      process.stderr.write(`klipara-scout: ${String(ready.length)} sample(s) ready\n`)
      const shift = state.lastShiftSession === undefined ? undefined : ctx.agents.get(brandString<SessionId>(state.lastShiftSession))
      if (shift === undefined) return
      shift.followup(createUserMessage({
        content: [{ type: 'text', text: `Samples finished since your last turn:\n${ready.join('\n')}\n\nPitch them now as the klipara-scout skill says, within today's pitch cap (scout_status shows what is left).` }],
        source: { kind: 'klipara-scout', form: 'notice', summary: boundContextSummary(`${String(ready.length)} Klipara Scout sample(s) ready`) },
      }))
    } finally {
      watching = false
    }
  }
  const watcher = setInterval(() => { void watch() }, config.sampleCheckMs)
  ctx.effect(() => () => { clearInterval(watcher) })

  // Samples made before Klipara returned covers show a frame; once per start,
  // shortly after boot, swap in the cover where the clip has one.
  const backfill = setTimeout(() => {
    if (config.kliparaApiKey.get().trim() === '') return
    backfillCovers(deps, AbortSignal.timeout(10 * 60_000)).then((covered) => {
      if (covered > 0) process.stderr.write(`klipara-scout: put Klipara's cover on ${String(covered)} earlier sample(s)\n`)
    }, (error: unknown) => {
      process.stderr.write(`klipara-scout: cover backfill failed: ${error instanceof Error ? error.message : String(error)}\n`)
    })
  }, 30_000)
  ctx.effect(() => () => { clearTimeout(backfill) })

  // Reply checks: while any pitch awaits an answer, ask the shift to look at the
  // Gmail inbox and YouTube notifications every few minutes. Each check is a
  // model turn driving the browser, so none runs with nothing pitched, while
  // the shift is busy, or while outreach is paused. With the day's shift no
  // longer live, one reply Session is started for the day and reused.
  let lastReplyCheck = Date.now()
  let startingReplies = false
  const checkReplies = async (): Promise<void> => {
    const every = config.replyCheckMinutes.get()
    if (!config.enabled.get() || every <= 0 || startingReplies || Date.now() - lastReplyCheck < every * 60_000) return
    const state = await store.read()
    const awaiting = state.leads.filter(l => l.stage === 'pitched')
    const outreach = config.outreachBrowser.get().trim()
    if (state.paused !== null || awaiting.length === 0 || outreach === '') return
    lastReplyCheck = Date.now()
    const prompt = `Reply check. Using only the "${outreach}" browser tools (never the deerflow browser), open the outreach account's Gmail inbox and YouTube notifications and look only for answers from these pitched creators: ${awaiting.map(l => `${l.channelName} (${l.pitch?.via ?? ''} to ${l.pitch?.to ?? ''})`).join('; ')}. Record each answer with scout_record_reply. Do nothing else: no searches, samples or pitches. Then end your turn with one line.`
    const live = state.lastShiftSession === undefined ? undefined : ctx.agents.get(brandString<SessionId>(state.lastShiftSession))
    if (live !== undefined) {
      if (live.status === 'running') return
      live.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'klipara-scout', form: 'notice', summary: boundContextSummary('Klipara Scout reply check') },
      }))
      return
    }
    startingReplies = true
    try {
      const date = localTime(new Date(), config.timeZone.get()).date
      await mkdir(config.workspacePath, { recursive: true })
      const sessionId = await startShift(ctx, {
        workspacePath: config.workspacePath,
        title: `Klipara Scout replies ${date}`,
        prompt: `${prompt}\nYour instructions are the klipara-scout skill at ${join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'skills', 'klipara-scout', 'SKILL.md')}.`,
        agentPreset: config.agentPreset,
        permissionPreset: config.permissionPreset,
        provider: config.provider.get(),
        model: config.model.get(),
        sessionPrefix: 'scout-',
        source: summary => ({ kind: 'klipara-scout', form: 'notice', summary }),
      }, AbortSignal.timeout(120_000))
      await store.update((s) => { s.lastShiftSession = sessionId })
    } catch (error) {
      process.stderr.write(`klipara-scout: the reply check did not start: ${error instanceof Error ? error.message : String(error)}\n`)
      reportFailure({ stage: 'reply-check', error, redact: [] })
    } finally {
      startingReplies = false
    }
  }
  const replyTimer = setInterval(() => { void checkReplies() }, 60_000)
  ctx.effect(() => () => { clearInterval(replyTimer) })

  // Comment visibility, read signed out every ten minutes, with no model turn.
  let checkingComments = false
  const commentTimer = setInterval(() => {
    if (checkingComments || !config.enabled.get()) return
    checkingComments = true
    void checkComments(deps, AbortSignal.timeout(300_000))
      .then((lines) => { if (lines.length > 0) process.stderr.write(`klipara-scout: comment checks: ${lines.join('; ')}\n`) })
      .catch((error: unknown) => {
        process.stderr.write(`klipara-scout: comment check failed: ${error instanceof Error ? error.message : String(error)}\n`)
        reportFailure({ stage: 'pitch', error, redact: [] })
      })
      .finally(() => { checkingComments = false })
  }, 600_000)
  ctx.effect(() => () => { clearInterval(commentTimer) })
}
