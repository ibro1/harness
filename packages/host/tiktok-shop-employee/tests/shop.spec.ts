/**
 * The TikTok Shop employee against stand-ins: what a script may say, which products may be promoted, how the data
 * service's answers are read, and what the tools refuse and record. Rendering is tested elsewhere with real ffmpeg.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  blockedWord, buildShopTools, createSpeaker, DEFAULT_BLOCKED_WORDS, envKeys, finalCaption, parseProduct, reviewPage,
  lineSpans, scriptProblems, ShopStore, socialCrawl, wrap,
} from '../src/index.ts'
import type { ShopProduct, SocialCrawl } from '../src/index.ts'

const exec = { signal: new AbortController().signal } as ToolRunContext
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const BALM: ShopProduct = { id: '1729', title: 'Pink Collagen Lip Balm', price: 12.99, currency: 'GBP', sold: 5400, rating: 4.6, images: ['https://img.test/a.jpg', 'https://img.test/b.jpg'] }
const WINE: ShopProduct = { id: '1730', title: 'Red Wine Glass Set', price: 19.5, currency: 'GBP', images: ['https://img.test/c.jpg'] }

function setup(overrides: { videosPerDay?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tts-'))
  dirs.push(dir)
  const rendered: string[] = []
  const notes: string[] = []
  const data: SocialCrawl = {
    search: () => Promise.resolve([BALM, WINE]),
    product: () => Promise.resolve({ ...BALM, description: 'Tinted balm with collagen. Adds shine.', images: [...BALM.images, 'https://img.test/d.jpg'] }),
  }
  const store = new ShopStore(join(dir, 'state.json'))
  const tools = new Map(buildShopTools({
    store, data, blockedWords: () => [...DEFAULT_BLOCKED_WORDS], videosPerDay: () => overrides.videosPerDay ?? 3,
    today: () => '2026-10-02', now: () => new Date('2026-10-02T10:00:00Z'),
    startRender: (id) => { rendered.push(id) }, notify: (text) => { notes.push(text); return Promise.resolve('sent') },
  }).map((t: ToolDefinition) => [t.name, t]))
  const run = async (name: string, args: Record<string, unknown> = {}): Promise<string> =>
    ((await tools.get(name)!.execute(args, exec)) as { text: string }).text
  return { run, store, rendered, notes }
}

const GOOD = {
  product_id: '1729', format: 'showcase', hook: 'Dry lips this winter?',
  lines: [
    { voice: 'If your lips crack every winter, this one is worth a look.', caption: 'Cracked winter lips?' },
    { voice: 'It is a tinted collagen balm that adds a glossy shine in one swipe.', caption: 'Tint plus shine' },
    { voice: 'It is twelve ninety-nine on TikTok Shop right now. Tap the orange basket.', caption: 'Tap the orange basket' },
  ],
  caption: 'The tinted balm everyone is adding to their basket.',
  hashtags: ['tiktokmademebuyit', 'lipcare'],
}

describe('script rules', () => {
  it('refuses lines that claim the narrator used the product', () => {
    expect(scriptProblems(['I\'ve been using this every morning'], '£12.99')).toHaveLength(1)
    expect(scriptProblems(['My skin has never looked better'], '£12.99')[0]?.why).toContain('used or owns')
    expect(scriptProblems(['My favourite balm this winter'], '£12.99')).toHaveLength(1)
    expect(scriptProblems(['This balm adds shine in one swipe'], '£12.99')).toEqual([])
  })

  it('refuses health claims and prices other than the listing\'s', () => {
    expect(scriptProblems(['It cures dry lips'], '£12.99')[0]?.why).toContain('health')
    expect(scriptProblems(['Only £9.99 today'], '£12.99')[0]?.why).toContain('listing price is £12.99')
    expect(scriptProblems(['Only £12.99 today'], '£12.99')).toEqual([])
  })

  it('keeps blocked products out by whole word', () => {
    expect(blockedWord(WINE, DEFAULT_BLOCKED_WORDS)).toBe('wine')
    expect(blockedWord({ title: 'Swine-shaped plush toy' }, ['wine'])).toBeUndefined()
    expect(blockedWord(BALM, DEFAULT_BLOCKED_WORDS)).toBeUndefined()
  })

  it('puts the advertising label first in every caption', () => {
    expect(finalCaption('Worth a look.', ['#tiktokmademebuyit', 'ad'])).toBe('#ad Worth a look.\n\n#tiktokmademebuyit')
  })

  it('splits one recording into lines at its longest pauses', () => {
    const pauses = [{ start: 1.0, end: 1.1 }, { start: 2.1, end: 3.0 }, { start: 4.6, end: 5.6 }]
    expect(lineSpans(pauses, 3, 8)).toEqual([{ start: 0, end: 2.1 }, { start: 3.0, end: 4.6 }, { start: 5.6, end: 8 }])
    expect(lineSpans([{ start: 2, end: 3 }], 3, 8)).toBeUndefined()
  })

  it('wraps captions at word boundaries', () => {
    expect(wrap('Tap the orange basket below now', 12)).toEqual(['Tap the', 'orange', 'basket below', 'now'])
  })
})

describe('the data service', () => {
  it('reads products under the field names such services use', () => {
    expect(parseProduct({ product_id: 99, name: 'Car mount', sale_price: '£8.50', sold_count: '1.2K sold', image: { url_list: ['https://i.test/x.jpg'] } }))
      .toMatchObject({ id: '99', title: 'Car mount', price: 8.5, sold: 1200, images: ['https://i.test/x.jpg'], currency: 'GBP' })
    expect(parseProduct({ title: 'No id' })).toBeUndefined()
  })

  it('asks for the UK market with the key, and says how to get a key when none is saved', async () => {
    const seen: string[] = []
    const fetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      seen.push(`${url} ${new Headers(init?.headers).get('x-api-key') ?? ''}`)
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: '1', title: 'Balm', price: 3 }] }), { headers: { 'content-type': 'application/json' } }))
    }
    const found = await socialCrawl(() => 'sc_test', () => 'gb', fetcher).search('lip balm', exec.signal)
    expect(found.map(p => p.title)).toEqual(['Balm'])
    expect(seen[0]).toContain('query=lip+balm&region=GB')
    expect(seen[0]).toContain('sc_test')
    await expect(socialCrawl(() => '', () => 'GB', fetcher).search('x', exec.signal)).rejects.toThrow('No SocialCrawl API key')
  })
})

describe('tools', () => {
  it('saves allowed products only and lists best sellers', async () => {
    const { run, store } = setup()
    const text = await run('tts_search', { query: 'lip balm' })
    expect(text).toContain('1729: Pink Collagen Lip Balm (£12.99, 5400 sold')
    expect(text).toContain('Red Wine Glass Set (wine)')
    expect((await store.read()).products.map(p => p.id)).toEqual(['1729'])
  })

  it('renders an honest script, records it with #ad, and stops at the daily cap', async () => {
    const { run, store, rendered } = setup({ videosPerDay: 1 })
    await run('tts_search', { query: 'lip balm' })
    expect(await run('tts_make_video', GOOD)).toContain('is rendering (1/1 today)')
    const video = (await store.read()).videos[0]!
    expect(rendered).toEqual([video.id])
    expect(video.caption.startsWith('#ad ')).toBe(true)
    expect(video.endCard).toBe('£12.99 · tap the orange basket')
    await expect(run('tts_make_video', GOOD)).rejects.toThrow('cap of 1 videos is reached')
  })

  it('refuses a script with a fake testimonial or a wrong price, and renders nothing', async () => {
    const { run, rendered } = setup()
    await run('tts_search', { query: 'lip balm' })
    const fake = { ...GOOD, lines: [{ voice: 'I have been using this balm for a week and my lips love it.', caption: 'My go-to balm' }, ...GOOD.lines.slice(1)] }
    await expect(run('tts_make_video', fake)).rejects.toThrow('claims the narrator used or owns the product')
    await expect(run('tts_make_video', { ...GOOD, caption: 'Only £5 today' })).rejects.toThrow('listing price is £12.99')
    expect(rendered).toEqual([])
  })

  it('refuses while paused, and the pause alerts the owner', async () => {
    const { run, notes } = setup()
    await run('tts_search', { query: 'lip balm' })
    expect(await run('tts_pause', { reason: 'voice keeps failing' })).toContain('Paused')
    expect(notes[0]).toContain('voice keeps failing')
    await expect(run('tts_make_video', GOOD)).rejects.toThrow('Paused')
  })
})

describe('review page', () => {
  it('shows the video, the caption, the labels to switch on, and the buttons for a ready video', () => {
    const page = reviewPage({
      id: 'abc123', productId: '1729', format: 'showcase', hook: 'h', lines: [], endCard: '', caption: '#ad <b>Worth it</b>',
      status: 'ready', createdAt: 'x', file: 'abc123.mp4', seconds: 14,
    }, { ...BALM, foundAt: 'x', query: 'q' }, { media: '/tts/v/abc123/media?sig=s', action: '/tts/v/abc123/action?sig=s' })
    expect(page).toContain('<video src="/tts/v/abc123/media?sig=s"')
    expect(page).toContain('#ad &lt;b&gt;Worth it&lt;/b&gt;')
    expect(page).toContain('AI-generated content')
    expect(page).toContain('value="posted"')
  })
})

describe('voice keys', () => {
  const settings = {
    provider: 'auto' as const, geminiVoice: 'Puck', groqVoice: 'troy', elevenLabsVoice: '', style: 'Upbeat.',
    geminiModel: 'gemini-3.1-flash-tts-preview', groqApiKey: '', speakScript: '',
  }
  const pcm = Buffer.alloc(4800).toString('base64')
  /** Gemini keys named in `busy` answer 429; Groq always answers. Records which key was used for each call. */
  function voiceFetch(busy: string[], used: string[]) {
    return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      const headers = new Headers(init?.headers)
      const key = headers.get('x-goog-api-key') ?? (headers.get('authorization') ?? '').replace('Bearer ', '')
      used.push(key)
      if (url.includes('generativelanguage') && busy.includes(key)) {
        return Promise.resolve(new Response('{"error":{"message":"Quota exceeded for GenerateRequestsPerDayPerProjectPerModel"}}', { status: 429 }))
      }
      if (url.includes('generativelanguage')) {
        return Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm } }] } }] })))
      }
      return Promise.resolve(new Response(new Uint8Array([82, 73, 70, 70])))
    }
  }

  it('reads GEMINI_API_KEY then _1 to _9, skipping blanks and repeats', () => {
    expect(envKeys({ GEMINI_API_KEY: 'a', GEMINI_API_KEY_1: 'b', GEMINI_API_KEY_2: '', GEMINI_API_KEY_3: 'a', GEMINI_API_KEY_9: 'c' }, 'GEMINI_API_KEY').map(k => k.name))
      .toEqual(['GEMINI_API_KEY', 'GEMINI_API_KEY_1', 'GEMINI_API_KEY_9'])
  })

  it('moves to the next Gemini key when one is out of quota, uses Groq only when every Gemini key is, and rests a spent key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tts-voice-'))
    dirs.push(dir)
    const env = { GEMINI_API_KEY: 'g0', GEMINI_API_KEY_1: 'g1', GROQ_API_KEY: 'q0' }
    const used: string[] = []
    const speak = createSpeaker(() => settings, env, voiceFetch(['g0'], used))
    await speak('Hello there.', join(dir, 'a.wav'), exec.signal)
    expect(used).toEqual(['g0', 'g1'])
    await speak('Again.', join(dir, 'b.wav'), exec.signal)
    // g0 rests after its daily quota, so the next line goes straight to g1.
    expect(used).toEqual(['g0', 'g1', 'g1'])
    const header = readFileSync(join(dir, 'a.wav')).subarray(0, 4).toString()
    expect(header).toBe('RIFF')

    const used2: string[] = []
    await createSpeaker(() => settings, env, voiceFetch(['g0', 'g1'], used2))('Last resort.', join(dir, 'c.wav'), exec.signal)
    expect(used2).toEqual(['g0', 'g1', 'q0'])
  })

  it('says which keys failed when none can speak', async () => {
    const speak = createSpeaker(() => ({ ...settings, provider: 'gemini' }), { GEMINI_API_KEY: 'g0' }, voiceFetch(['g0'], []))
    await expect(speak('x', '/tmp/never.wav', exec.signal)).rejects.toThrow(/GEMINI_API_KEY: daily quota spent/u)
  })
})
