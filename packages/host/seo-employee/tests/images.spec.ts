import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CaptureDriver, CaptureRequest, CaptureResult } from '@deepseek-ai/dsh-host-capture'
import { imageProblem, makeImage, siteBrand, templateHtml, type Brand } from '../src/images.ts'
import type { Site } from '../src/types.ts'

const SITE = {
  id: 'klipara', name: 'Klipara', baseUrl: 'https://klipara.linkfa.de', kind: 'klipara', enabled: true,
  profile: { business: 'b', audience: 'a', offer: 'o', voice: '', cta: { text: '', url: '' } },
  markets: [], seeds: [], gscProperty: '', articlesPerWeek: 2, author: { name: 'A', url: '', bio: '' }, createdAt: 'x',
} satisfies Site
const BRAND: Brand = { name: 'Klipara', accent: '#a3262a', paper: '#faf4ee', ink: '#17130f', displayFont: 'Fraunces', bodyFont: 'IBM Plex Sans' }
const signal = new AbortController().signal

describe('what an image may be made from', () => {
  it('photographs only the site\'s own pages, needs a source for a chart, and takes clip covers only from Klipara', () => {
    expect(imageProblem(SITE, { kind: 'screenshot', url: 'https://klipara.linkfa.de/free-clip', mobile: false })).toBeUndefined()
    expect(imageProblem(SITE, { kind: 'screenshot', url: 'https://opus.pro/', mobile: false })).toContain('own pages only')
    expect(imageProblem(SITE, { kind: 'graphic', template: 'chart', title: 'Views', bars: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }], unit: '', source: '' }))
      .toContain('source of its numbers')
    expect(imageProblem({ ...SITE, kind: 'wordpress' }, { kind: 'clip-cover', sampleId: 'abcdefghijk' })).toContain('Klipara')
  })
})

describe('template graphics', () => {
  it('escapes the text and sizes the card to its content', () => {
    const page = templateHtml({ kind: 'graphic', template: 'steps', title: '<b>Clip</b> a podcast', steps: ['Paste the link', 'Pick a clip', 'Post it'] }, BRAND)
    expect(page.html).toContain('&lt;b&gt;Clip&lt;/b&gt;')
    expect(page.html).not.toContain('<b>Clip</b>')
    expect(page).toMatchObject({ width: 1200, height: 630 })
  })

  it('reads the brand colour from the site\'s theme-color', async () => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response('<head><meta name="theme-color" content="#a3262a"></head>'))
    expect((await siteBrand(fetcher, SITE, signal)).accent).toBe('#a3262a')
  })
})

describe('making an image', () => {
  it('renders a graphic through the browser driver, cropped to the card, and stores it under a public name', async () => {
    const requests: CaptureRequest[] = []
    const driver: CaptureDriver = { capture: (request) => { requests.push(request); return Promise.resolve({ png: new Uint8Array([137, 80, 78, 71]), measurement: {} as CaptureResult['measurement'], notes: [] }) } }
    const mediaDir = mkdtempSync(join(tmpdir(), 'seo-media-'))
    const made = await makeImage({
      driver, screen: () => Promise.reject(new Error('unused')), fetch, mediaDir, publicUrl: file => `https://h.test/seo/media/${file}`,
    }, SITE, { kind: 'graphic', template: 'cover', title: 'How to clip a podcast', subtitle: '' }, BRAND, signal)
    expect(requests[0]).toMatchObject({ selector: '#card', width: 1200, height: 630, literalHost: true })
    expect(requests[0]?.url.startsWith('data:text/html;base64,')).toBe(true)
    const file = made.sourceUrl.replace('https://h.test/seo/media/', '')
    expect(file).toMatch(/^[0-9a-f]{24}\.png$/u)
    expect([...readFileSync(join(mediaDir, file))]).toEqual([137, 80, 78, 71])
  })
})

describe('reading a site\'s brand', () => {
  it('prefers the site\'s own design tokens and their light-mode values, and finds the fonts', async () => {
    const css = `:root{--background:oklch(100% 0 0);--color-paper:oklch(97% .01 65);--color-ink:oklch(19% .01 60);--color-accent:oklch(48% .17 28);
--font-display:"Fraunces", ui-serif, serif;--font-body:"IBM Plex Sans", sans-serif}.dark{--color-paper:oklch(15% .008 65);--color-ink:oklch(94% .006 75);--color-accent:oklch(66% .15 28)}`
    const fetcher: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : input.toString()
      return Promise.resolve(new Response(url.endsWith('.css') ? css : '<link rel="stylesheet" href="/assets/site.css">'))
    }
    expect(await siteBrand(fetcher, SITE, signal)).toEqual({
      name: 'Klipara', accent: 'oklch(48% .17 28)', paper: 'oklch(97% .01 65)', ink: 'oklch(19% .01 60)', displayFont: 'Fraunces', bodyFont: 'IBM Plex Sans',
    })
  })

  it('uses the owner\'s colours from the site form over what the site declares', async () => {
    const fetcher: typeof fetch = () => Promise.reject(new Error('not read'))
    const brand = await siteBrand(fetcher, { ...SITE, brand: { accent: '#0055ff', paper: '#ffffff', ink: '#000000', displayFont: 'Inter', bodyFont: '' } }, signal)
    expect(brand).toMatchObject({ accent: '#0055ff', paper: '#ffffff', displayFont: 'Inter' })
  })
})
