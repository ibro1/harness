/**
 * The TikTok Shop employee: a daily shift that finds UK TikTok Shop products
 * worth promoting (SocialCrawl data), writes short videos about them under
 * code-enforced honesty rules, renders each from the product's own images
 * with an AI voiceover and burned-in captions, and sends the owner a review
 * link on WhatsApp to post from their own TikTok account. Posting stays with
 * the owner; results they report steer later scripts.
 *
 * @module @deepseek-ai/dsh-host-tiktok-shop-employee
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { FallbackRouter, installFallback, localTime, parseShiftTime, shiftDue, startShift, whatsAppNotifier } from '@deepseek-ai/dsh-host-employee-kit'
import { reviewPage } from './pages.ts'
import { renderVideo } from './render.ts'
import { DEFAULT_BLOCKED_WORDS } from './rules.ts'
import { socialCrawl } from './socialcrawl.ts'
import { directShop, PRODUCT_URL, SEARCH_URL, withFallback } from './direct.ts'
import { TikTokBrowser, type PostRun } from './tiktok-browser.ts'
import { resolveBrowserPath } from '@deepseek-ai/dsh-host-capture'
import { ShopStore } from './store.ts'
import { buildShopTools } from './tools.ts'
import { createSpeaker, envKeys, VOICE_PROVIDERS, type VoiceProvider } from './voice.ts'

export { lineSpans, renderVideo, wrap } from './render.ts'
export type { RenderJob, RenderTools, ScriptLine } from './render.ts'
export { blockedWord, DEFAULT_BLOCKED_WORDS, finalCaption, scriptProblems } from './rules.ts'
export { parseProduct, socialCrawl } from './socialcrawl.ts'
export { DirectUnavailable, directShop, productsIn, proxyOption, withFallback } from './direct.ts'
export type { DirectSettings, SourcedAnswer } from './direct.ts'
export { TikTokBrowser } from './tiktok-browser.ts'
export type { AccountState, PostRun, PostStep } from './tiktok-browser.ts'
export type { ShopProduct, SocialCrawl } from './socialcrawl.ts'
export { emptyState, ShopStore } from './store.ts'
export type { ShopState, TrackedProduct, VideoRecord } from './store.ts'
export { buildShopTools, priceText } from './tools.ts'
export type { ShopDeps } from './tools.ts'
export { createSpeaker, envKeys, pcmToWav } from './voice.ts'
export { reviewPage } from './pages.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The prompt that opens a TikTok Shop employee shift. */
    'tiktok-shop-employee': {
      readonly kind: 'tiktok-shop-employee'
      readonly form: 'notice'
      readonly summary: string
    }
  }
}

/** Plugin name. */
export const name = 'tiktok-shop-employee'
/** Services the plugin needs. */
export const inject = ['agents', 'webServer', 'agentDefaultModel', 'agentPresets', 'permissionPresets', 'sessionTitle', 'workspaceRegistry']

/** Session ids of the employee's shifts start with this. */
const SESSION_PREFIX = 'tts-'

/** Composition and live settings; the `Volatile` fields are edited on the Plugins page. */
export interface Config {
  enabled: Volatile<boolean>
  shiftTime: Volatile<string>
  timeZone: Volatile<string>
  /** WhatsApp chat name or number that gets review links and alerts. */
  notifyTo: Volatile<string>
  provider: Volatile<string>
  model: Volatile<string>
  fallbackProvider: Volatile<string>
  fallbackModel: Volatile<string>
  fallbackCooldownMinutes: Volatile<number>
  /** Videos rendered per local day. */
  videosPerDay: Volatile<number>
  /** Themes the shift searches, one per line ("lip balm", "car accessories"). */
  themes: Volatile<string[]>
  /** Words that keep a product out of the shop. */
  blockedWords: Volatile<string[]>
  /** TikTok Shop market, `GB` for the United Kingdom. */
  region: Volatile<string>
  /** SocialCrawl API key; write-only on the settings page. Wins over `envSocialCrawlApiKey`. */
  socialCrawlApiKey: Volatile<string>
  /** The same key from the deployment environment (`SOCIALCRAWL_API_KEY`), used when the page has none. */
  envSocialCrawlApiKey: string
  /** Proxy for reading TikTok directly, `http://user:pass@host:port`; write-only. Wins over `envProxy`. */
  directProxy: Volatile<string>
  /** The proxy from the environment (`TTS_PROXY_URL`, else `HTTPS_PROXY`). */
  envProxy: string
  /** Direct search page; `{region}`, `{query}` and `{slug}` are filled in. */
  directSearchUrl: Volatile<string>
  /** Direct product page; `{region}` and `{id}` are filled in. */
  directProductUrl: Volatile<string>
  /** Chromium for the direct read and the TikTok browser; empty searches PATH. */
  browserPath: string
  /** TikTok's web upload page, where the owner's posts are made. */
  tiktokUploadUrl: Volatile<string>
  /** `auto` (every Gemini key, then Groq as the last resort), `gemini`, `groq` or `elevenlabs`. */
  voiceProvider: Volatile<string>
  /** Gemini voice name, such as Puck. */
  voice: Volatile<string>
  /** Groq Orpheus voice name, such as troy. */
  groqVoice: Volatile<string>
  /** ElevenLabs voice id; empty uses speak.py's default. */
  elevenLabsVoice: Volatile<string>
  /** Gemini speech model. */
  geminiTtsModel: Volatile<string>
  /** Gemini only: how the line is delivered. */
  voiceStyle: Volatile<string>
  /** A Groq key for the voice, tried before the deployment's GROQ_API_KEY ones; write-only. */
  groqApiKey: Volatile<string>
  /** Path of video-use's speak.py, for the ElevenLabs voice. */
  speakScript: string
  ffmpeg: string
  ffprobe: string
  /** Bold font for burned-in text. */
  font: string
  dataDir: string
  /** Absolute origin review links are built on, for example `https://harness.example.com`. */
  publicBaseUrl: string
  path: string
  /** Shared secret for the CLI command route; empty leaves it unmounted. */
  token: string
  workspacePath: string
  agentPreset: string
  permissionPreset: string
  /** The shift's opening message; `{skill}` becomes the skill file's path. */
  shiftPrompt: string
  whatsappUrl: string
  whatsappToken: string
  /** MCP server name of the browser these Sessions must never use. */
  forbiddenBrowser: string
}

/** Composition config. */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  shiftTime: z.string().default('11:00').volatile(),
  timeZone: z.string().default('Africa/Lagos').volatile(),
  notifyTo: z.string().default('').volatile(),
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  fallbackProvider: z.string().default('opencode').volatile(),
  fallbackModel: z.string().default('big-pickle').volatile(),
  fallbackCooldownMinutes: z.natural().default(15).volatile(),
  videosPerDay: z.natural().default(3).volatile(),
  themes: z.array(z.string()).default(['lip balm', 'phone accessories', 'kitchen gadgets', 'car accessories', 'skincare', 'home organisation']).volatile(),
  blockedWords: z.array(z.string()).default([...DEFAULT_BLOCKED_WORDS]).volatile(),
  region: z.string().default('GB').volatile(),
  socialCrawlApiKey: z.string().role('secret').default('').volatile(),
  envSocialCrawlApiKey: z.string().default(''),
  directProxy: z.string().role('secret').default('').volatile(),
  envProxy: z.string().default(''),
  directSearchUrl: z.string().default(SEARCH_URL).volatile(),
  directProductUrl: z.string().default(PRODUCT_URL).volatile(),
  browserPath: z.string().default(''),
  tiktokUploadUrl: z.string().default('https://www.tiktok.com/tiktokstudio/upload?from=webapp').volatile(),
  voiceProvider: z.string().default('auto').volatile(),
  voice: z.string().default('Puck').volatile(),
  groqVoice: z.string().default('troy').volatile(),
  elevenLabsVoice: z.string().default('').volatile(),
  geminiTtsModel: z.string().default('gemini-3.1-flash-tts-preview').volatile(),
  voiceStyle: z.string().default('Read as an upbeat, natural British TikTok voiceover, quick and friendly. Leave a clear one-second pause between paragraphs.').volatile(),
  groqApiKey: z.string().role('secret').default('').volatile(),
  speakScript: z.string().default('/opt/video-use/helpers/speak.py'),
  ffmpeg: z.string().default('ffmpeg'),
  ffprobe: z.string().default('ffprobe'),
  font: z.string().default('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'),
  dataDir: z.string().default(''),
  publicBaseUrl: z.string().default(''),
  path: z.string().default('/tts'),
  token: z.string().default(''),
  workspacePath: z.string().default('/workspace/tiktok-shop-employee'),
  agentPreset: z.string().default('standard'),
  permissionPreset: z.string().default('workspace-write'),
  shiftPrompt: z.string().default('Run today\'s TikTok Shop employee shift. Your instructions are the tiktok-shop-employee skill at {skill}: read that file first, then follow it exactly.'),
  whatsappUrl: z.string().default(''),
  whatsappToken: z.string().default(''),
  forbiddenBrowser: z.string().default('deerflow'),
})

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > limit) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function isSession(agent: Agent): boolean {
  return String(agent.session.id).startsWith(SESSION_PREFIX)
}

/** Image types the renderer accepts, by the answer's content type. */
const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }

/**
 * Mount the employee: store, review routes, tools on its Sessions, the CLI command route, the render queue and the
 * daily timer.
 * @param ctx - the plugin context.
 * @param config - validated composition config.
 */
export function apply(ctx: Context, config: Config): void {
  const dataDir = config.dataDir !== '' ? config.dataDir : join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'tiktok-shop-employee')
  const store = new ShopStore(join(dataDir, 'state.json'))
  const mediaDir = join(dataDir, 'media')
  const prefix = config.path.replace(/\/+$/u, '')
  const publicBase = config.publicBaseUrl.replace(/\/+$/u, '')
  const notify = whatsAppNotifier({ url: config.whatsappUrl, token: config.whatsappToken, to: () => config.notifyTo.get() })
  const today = (): string => localTime(new Date(), config.timeZone.get()).date

  let linkKey = ''
  const keyReady = store.update((s) => {
    s.linkKey ??= randomBytes(32).toString('hex')
    return s.linkKey
  }).then((key) => { linkKey = key }, (error: unknown) => {
    process.stderr.write(`tiktok-shop-employee: the state file could not be read: ${error instanceof Error ? error.message : String(error)}\n`)
  })
  const sign = (videoId: string): string => createHmac('sha256', linkKey).update(`video:${videoId}`).digest('hex').slice(0, 32)
  const signed = (videoId: string, sig: string | null): boolean => {
    if (linkKey === '' || sig === null) return false
    const want = Buffer.from(sign(videoId))
    const got = Buffer.from(sig)
    return want.length === got.length && timingSafeEqual(want, got)
  }
  const reviewLink = (videoId: string): string => `${publicBase}${prefix}/v/${videoId}?sig=${sign(videoId)}`

  const dataKey = (): string => config.socialCrawlApiKey.get().trim() || config.envSocialCrawlApiKey.trim()
  const proxy = (): string => config.directProxy.get().trim() || config.envProxy.trim()
  const speak = createSpeaker(() => ({
    provider: (VOICE_PROVIDERS as readonly string[]).includes(config.voiceProvider.get()) ? config.voiceProvider.get() as VoiceProvider : 'auto',
    geminiVoice: config.voice.get(),
    groqVoice: config.groqVoice.get(),
    elevenLabsVoice: config.elevenLabsVoice.get(),
    style: config.voiceStyle.get(),
    geminiModel: config.geminiTtsModel.get().trim() || 'gemini-3.1-flash-tts-preview',
    groqApiKey: config.groqApiKey.get(),
    speakScript: config.speakScript,
  }))

  // The owner's TikTok account, in its own profile, only through the proxy.
  const tiktok = new TikTokBrowser(() => ({
    profileDir: join(dataDir, 'tiktok-profile'),
    browserPath: resolveBrowserPath(config.browserPath),
    proxy: proxy(),
    uploadUrl: config.tiktokUploadUrl.get(),
  }))
  /** Prepare or post one video in the TikTok browser, recording the steps and a screenshot; tells the owner when done. */
  const runPost = async (videoId: string, mode: 'prepare' | 'post'): Promise<void> => {
    const state = await store.read()
    const video = state.videos.find(v => v.id === videoId)
    const product = state.products.find(p => p.id === video?.productId)
    if (video?.file === undefined || product === undefined) return
    const result: PostRun = await tiktok.run({
      videoPath: join(mediaDir, video.file), caption: video.caption, productId: product.id, productTitle: product.title,
    }, mode).catch((error: unknown): PostRun => ({
      mode, steps: [], posted: false, error: error instanceof Error ? error.message : String(error),
    }))
    let shot: string | undefined
    if (result.screenshot !== undefined) {
      shot = `${videoId}-${mode}.png`
      await writeFile(join(mediaDir, shot), result.screenshot)
    }
    const at = new Date().toISOString()
    await store.update((s) => {
      const v = s.videos.find(x => x.id === videoId)
      if (v === undefined) return
      v.posting = {
        mode, state: result.error === undefined || result.posted ? 'done' : 'failed', at, steps: result.steps,
        ...result.error === undefined ? {} : { error: result.error }, ...shot === undefined ? {} : { shot },
      }
      if (result.posted) Object.assign(v, { status: 'posted', postedAt: at })
    })
    const failed = result.steps.filter(s => !s.ok).map(s => s.step)
    await notify(result.posted
      ? `TikTok Shop: "${product.title}" is posted on your TikTok. ${reviewLink(videoId)}`
      : `TikTok Shop: ${mode === 'prepare' ? 'the dry run' : 'posting'} for "${product.title}" ${result.error === undefined ? 'finished' : `stopped: ${result.error}`}.${failed.length === 0 ? '' : ` Steps that did not work: ${failed.join(', ')}.`} Screenshot and steps: ${reviewLink(videoId)}`)
  }
  const startPost = (videoId: string, mode: 'prepare' | 'post'): void => {
    void store.update((s) => {
      const v = s.videos.find(x => x.id === videoId)
      if (v !== undefined) v.posting = { mode, state: 'running', at: new Date().toISOString(), steps: [] }
    }).then(() => runPost(videoId, mode))
  }

  // Renders run one at a time, in the order they were asked for.
  let renders: Promise<void> = Promise.resolve()
  const renderOne = async (videoId: string): Promise<void> => {
    const state = await store.read()
    const video = state.videos.find(v => v.id === videoId)
    const product = state.products.find(p => p.id === video?.productId)
    if (video === undefined || product === undefined) return
    const workDir = join(dataDir, 'work', videoId)
    try {
      await mkdir(workDir, { recursive: true })
      await mkdir(mediaDir, { recursive: true })
      const images: string[] = []
      for (const [i, url] of product.images.slice(0, 4).entries()) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
          const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
          const ext = IMAGE_TYPES[type] ?? (extname(new URL(url).pathname).toLowerCase() || '.jpg')
          if (!response.ok) continue
          const file = join(workDir, `image-${String(i)}${ext}`)
          await writeFile(file, Buffer.from(await response.arrayBuffer()))
          images.push(file)
        } catch (error) {
          process.stderr.write(`tiktok-shop-employee: image ${url} could not be read: ${error instanceof Error ? error.message : String(error)}\n`)
        }
      }
      if (images.length === 0) throw new Error('none of the product\'s images could be downloaded')
      const file = `${videoId}.mp4`
      const seconds = await renderVideo({
        images, lines: video.lines, hook: video.hook, endCard: video.endCard, workDir, outPath: join(mediaDir, file),
      }, {
        ffmpeg: config.ffmpeg, ffprobe: config.ffprobe, font: config.font, speak,
        // One request for the whole script: lines on their own paragraphs, read with a pause between them.
        speakAll: (lines, out, signal) => speak(lines.join('\n\n'), out, signal),
      }, AbortSignal.timeout(900_000))
      await store.update((s) => {
        const v = s.videos.find(x => x.id === videoId)
        if (v !== undefined) Object.assign(v, { status: 'ready', file, seconds })
      })
      await notify(`TikTok Shop: a new ${String(Math.round(seconds))}s video for "${product.title}" is ready.\n\nWatch, download and get the caption: ${reviewLink(videoId)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await store.update((s) => {
        const v = s.videos.find(x => x.id === videoId)
        if (v !== undefined) Object.assign(v, { status: 'failed', error: message.slice(0, 500) })
      })
      process.stderr.write(`tiktok-shop-employee: video ${videoId} failed: ${message}\n`)
      await notify(`TikTok Shop: the video for "${product.title}" failed to render: ${message.slice(0, 300)}`)
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  const startRender = (videoId: string): void => {
    renders = renders.then(() => renderOne(videoId))
  }
  // A restart while rendering leaves videos marked rendering; finish them.
  void keyReady.then(async () => {
    const state = await store.read()
    for (const v of state.videos.filter(x => x.status === 'rendering')) startRender(v.id)
  })

  const tools = buildShopTools({
    store,
    data: withFallback(
      directShop(() => ({
        proxy: proxy(),
        browserPath: resolveBrowserPath(config.browserPath),
        region: config.region.get(),
        searchUrl: config.directSearchUrl.get(),
        productUrl: config.directProductUrl.get(),
        timeoutMs: 45_000,
      })),
      socialCrawl(dataKey, () => config.region.get()),
      () => proxy() !== '',
    ),
    blockedWords: () => [...config.blockedWords.get()],
    videosPerDay: () => config.videosPerDay.get(),
    today,
    now: () => new Date(),
    startRender,
    notify,
  })

  // ----- The owner's review page, reached from WhatsApp without the harness sign-in -----
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: `${prefix}/v`,
    authenticate: false,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      await keyReady
      const url = new URL(req.url ?? '/', 'http://x')
      const [videoId = '', part = ''] = url.pathname.slice(`${prefix}/v/`.length).split('/')
      if (!/^[\w-]{6,40}$/u.test(videoId) || !signed(videoId, url.searchParams.get('sig'))) { res.writeHead(404); res.end(); return }
      const state = await store.read()
      const video = state.videos.find(v => v.id === videoId)
      if (video === undefined) { res.writeHead(404); res.end(); return }
      const sig = sign(videoId)
      if (part === 'media') {
        if (video.file === undefined) { res.writeHead(404); res.end(); return }
        const path = join(mediaDir, video.file)
        const info = await stat(path).catch(() => undefined)
        if (info === undefined) { res.writeHead(404); res.end(); return }
        const headers: Record<string, string> = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' }
        if (url.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename="tiktok-${videoId}.mp4"`
        const range = /^bytes=(\d*)-(\d*)$/u.exec(req.headers.range ?? '')
        if (range !== null) {
          const start = range[1] === '' ? Math.max(0, info.size - Number(range[2])) : Number(range[1])
          const end = range[2] === '' || range[1] === '' ? info.size - 1 : Math.min(Number(range[2]), info.size - 1)
          if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${String(info.size)}` }); res.end(); return }
          res.writeHead(206, { ...headers, 'Content-Range': `bytes ${String(start)}-${String(end)}/${String(info.size)}`, 'Content-Length': String(end - start + 1) })
          createReadStream(path, { start, end }).pipe(res)
          return
        }
        res.writeHead(200, { ...headers, 'Content-Length': String(info.size) })
        createReadStream(path).pipe(res)
        return
      }
      if (part === 'shot') {
        const shot = video.posting?.shot
        const info = shot === undefined ? undefined : await stat(join(mediaDir, shot)).catch(() => undefined)
        if (shot === undefined || info === undefined) { res.writeHead(404); res.end(); return }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': String(info.size) })
        createReadStream(join(mediaDir, shot)).pipe(res)
        return
      }
      if (part === 'action') {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const form = new URLSearchParams(await readBody(req, 4096) ?? '')
        const action = form.get('do')
        const at = new Date().toISOString()
        const count = (name: string): number | undefined => {
          const value = Number.parseInt(form.get(name) ?? '', 10)
          return Number.isFinite(value) && value >= 0 ? value : undefined
        }
        await store.update((s) => {
          const v = s.videos.find(x => x.id === videoId)
          if (v === undefined) return
          if ((action === 'prepare' || action === 'post') && v.status === 'ready' && v.posting?.state !== 'running') {
            queueMicrotask(() => { startPost(videoId, action) })
          } else if (action === 'posted' && v.status === 'ready') Object.assign(v, { status: 'posted', postedAt: at })
          else if (action === 'skipped' && v.status === 'ready') Object.assign(v, { status: 'skipped', skippedAt: at })
          else if (action === 'results' && v.status === 'posted') {
            const views = count('views')
            const sales = count('sales')
            v.results = { ...views === undefined ? {} : { views }, ...sales === undefined ? {} : { sales }, at }
          }
        })
        res.writeHead(303, { Location: `${prefix}/v/${videoId}?sig=${sig}` })
        res.end()
        return
      }
      const fresh = (await store.read()).videos.find(v => v.id === videoId) ?? video
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
      res.end(reviewPage(fresh, state.products.find(p => p.id === fresh.productId), {
        media: `${prefix}/v/${videoId}/media?sig=${sig}`,
        action: `${prefix}/v/${videoId}/action?sig=${sig}`,
        shot: `${prefix}/v/${videoId}/shot?sig=${sig}&t=${encodeURIComponent(fresh.posting?.at ?? '')}`,
      }, tiktok.current().state === 'signed-in'))
    },
  }), `tiktok-shop-employee: ${prefix}/v`)

  // ----- Status and owner actions for the settings page (signed in) -----
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/status`,
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      await keyReady
      const state = await store.read()
      json(res, 200, {
        date: today(),
        today: state.days[today()]?.videos ?? 0,
        cap: config.videosPerDay.get(),
        paused: state.paused,
        lastShiftDate: state.lastShiftDate,
        dataKey: dataKey() !== '',
        dataKeySource: config.socialCrawlApiKey.get().trim() !== '' ? 'settings' : config.envSocialCrawlApiKey.trim() !== '' ? 'environment' : 'none',
        proxy: proxy() !== '',
        tiktok: tiktok.current().state,
        groqKey: config.groqApiKey.get().trim() !== '',
        // How many keys of each the voice can use; never the keys.
        voiceKeys: { gemini: envKeys(process.env, 'GEMINI_API_KEY').length, groq: envKeys(process.env, 'GROQ_API_KEY').length },
        products: state.products.length,
        videos: [...state.videos].reverse().slice(0, 50).map(v => ({
          id: v.id, status: v.status, format: v.format, hook: v.hook, createdAt: v.createdAt,
          seconds: v.seconds, error: v.error, results: v.results,
          product: state.products.find(p => p.id === v.productId)?.title ?? v.productId,
          review: reviewLink(v.id),
        })),
      })
    },
  }), `tiktok-shop-employee: ${prefix}/status`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/action`,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return }
      let body: { action?: unknown }
      try {
        body = JSON.parse(await readBody(req, 4096) ?? '{}') as { action?: unknown }
      } catch {
        json(res, 400, { error: 'not JSON' })
        return
      }
      if (body.action === 'pause') await store.update((s) => { s.paused = { reason: 'paused by the owner', at: new Date().toISOString() } })
      else if (body.action === 'resume') await store.update((s) => { s.paused = null })
      else if (body.action === 'run-now') {
        void start(`TikTok Shop employee shift ${today()} (on request)`)
      } else { json(res, 400, { error: 'unknown action' }); return }
      json(res, 200, { ok: true })
    },
  }), `tiktok-shop-employee: ${prefix}/action`)

  // ----- The TikTok account (signed in) -----
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/tiktok`,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET') { json(res, 200, tiktok.current()); return }
      if (req.method !== 'POST') { json(res, 405, { error: 'GET or POST' }); return }
      let body: { action?: unknown }
      try {
        body = JSON.parse(await readBody(req, 4096) ?? '{}') as { action?: unknown }
      } catch {
        json(res, 400, { error: 'not JSON' })
        return
      }
      try {
        if (body.action === 'connect') json(res, 200, await tiktok.startLogin())
        else if (body.action === 'check') json(res, 200, await tiktok.check())
        else if (body.action === 'disconnect') { await tiktok.signOut(); json(res, 200, tiktok.current()) } else json(res, 400, { error: 'unknown action' })
      } catch (error) {
        json(res, 200, { state: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `tiktok-shop-employee: ${prefix}/tiktok`)
  // The session's state is read once at start, so the card does not open a browser on every visit.
  void keyReady.then(() => (proxy() === '' ? undefined : tiktok.check())).catch(() => undefined)

  // ----- CLI command route: the same tools for the agy and opencode CLIs -----
  if (config.token !== '') {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${prefix}/command`,
      authenticate: false,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const header = req.headers.authorization ?? ''
        const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
        const expected = Buffer.from(config.token)
        if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) { res.writeHead(404); res.end(); return }
        if (req.method === 'GET') { json(res, 200, { tools: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }); return }
        const raw = await readBody(req, 256 * 1024)
        if (raw === undefined) { json(res, 413, { error: 'too large' }); return }
        let request: { name?: unknown; args?: unknown }
        try {
          request = JSON.parse(raw) as { name?: unknown; args?: unknown }
        } catch {
          json(res, 400, { error: 'not JSON' })
          return
        }
        const found = tools.find(t => t.name === request.name)
        if (found === undefined) { json(res, 400, { error: `no such tool: ${String(request.name)}` }); return }
        const abort = new AbortController()
        res.on('close', () => { if (!res.writableEnded) abort.abort() })
        try {
          const args = typeof request.args === 'object' && request.args !== null ? request.args as Record<string, unknown> : {}
          json(res, 200, { result: await found.execute(args, { signal: abort.signal } as ToolRunContext) })
        } catch (error) {
          json(res, 200, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), `tiktok-shop-employee: ${prefix}/command`)
  }

  // Its Sessions never drive the DeerFlow browser, whose Google account Klipara downloads with.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.agent !== undefined && isSession(exec.agent) && exec.name.startsWith(`mcp__${config.forbiddenBrowser}__`)) {
      return { kind: 'deny', reason: `TikTok Shop employee sessions may not use the ${config.forbiddenBrowser} browser.` }
    }
    return next()
  })

  const installed = new Map<Agent, { dispose: () => Promise<void> }>()
  const install = (agent: Agent): void => {
    if (installed.has(agent) || !isSession(agent)) return
    installed.set(agent, agent.ctx.inject(['tools'], (scope) => {
      for (const definition of tools) scope.effect(() => scope.tools.register(definition), `tiktok-shop-employee: ${definition.name}`)
    }))
  }
  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const fiber = installed.get(agent)
    installed.delete(agent)
    void fiber?.dispose().catch(() => undefined)
  })

  const resolveRoute = (provider: string, model: string): { provider: string; model: string } | undefined =>
    provider.trim() === '' || model.trim() === '' ? undefined : { provider: provider.trim(), model: model.trim() }
  installFallback(ctx, new FallbackRouter({
    fallback: () => resolveRoute(config.fallbackProvider.get(), config.fallbackModel.get()),
    shift: () => resolveRoute(config.provider.get(), config.model.get()),
    cooldownMs: () => config.fallbackCooldownMinutes.get() * 60_000,
    onSwitch: (change) => {
      process.stderr.write(`tiktok-shop-employee: ${change.from.provider}/${change.from.model} failed (${change.failure.code}); shift turns use ${change.to.provider}/${change.to.model} until ${change.until.toISOString()}\n`)
    },
  }), isSession)

  const skillPath = join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'skills', 'tiktok-shop-employee', 'SKILL.md')
  const start = async (title: string): Promise<string> => {
    await mkdir(config.workspacePath, { recursive: true })
    const themes = config.themes.get().filter(t => t.trim() !== '')
    const sessionId = await startShift(ctx, {
      workspacePath: config.workspacePath,
      title,
      prompt: `${config.shiftPrompt.replaceAll('{skill}', skillPath)}${themes.length === 0 ? '' : `\nThemes to search: ${themes.join('; ')}.`}`,
      agentPreset: config.agentPreset,
      permissionPreset: config.permissionPreset,
      provider: config.provider.get(),
      model: config.model.get(),
      sessionPrefix: SESSION_PREFIX,
      source: summary => ({ kind: 'tiktok-shop-employee', form: 'notice', summary }),
    }, AbortSignal.timeout(120_000))
    await store.update((s) => { s.lastShiftSession = sessionId })
    return sessionId
  }

  let starting = false
  let retryAt = 0
  const tick = async (): Promise<void> => {
    if (starting || !config.enabled.get() || Date.now() < retryAt) return
    const at = parseShiftTime(config.shiftTime.get())
    if (at === undefined) return
    const now = localTime(new Date(), config.timeZone.get())
    const state = await store.read()
    if (state.paused !== null || !shiftDue(now, at, state.lastShiftDate)) return
    starting = true
    const previous = state.lastShiftDate
    try {
      await store.update((s) => { s.lastShiftDate = now.date })
      const sessionId = await start(`TikTok Shop employee shift ${now.date}`)
      process.stderr.write(`tiktok-shop-employee: started the ${now.date} shift as session ${sessionId}\n`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await store.update((s) => { s.lastShiftDate = previous })
      retryAt = Date.now() + 30 * 60_000
      void notify(`TikTok Shop employee: today's shift did not start (${reason.slice(0, 200)}). Retrying in 30 minutes.`)
    } finally {
      starting = false
    }
  }
  const timer = setInterval(() => { void tick() }, 60_000)
  ctx.effect(() => () => { clearInterval(timer) })
}
