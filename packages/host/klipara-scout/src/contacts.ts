/**
 * Finding a creator's email before falling back to a comment. A comment pitch
 * cannot carry the sample link, so it is an offer without its proof; an email
 * carries the clip. Most channels hide their business address behind YouTube's
 * sign-in and captcha, but many link a website, a Linktree, or have a podcast
 * feed under the same name, and those publish an address.
 *
 * Places tried, in order, each recorded with what it gave:
 * 1. the channel's About page, read signed out: the links it lists;
 * 2. each linked website's home, `/contact`, `/contact-us` and `/about` pages;
 * 3. each Linktree-style page's `mailto:` links and the sites it links;
 * 4. the podcast directory, searched by the channel's name, when a show with
 *    a matching name has an owner email in its feed and its feed links no
 *    other YouTube channel.
 * Social profiles (Instagram, X, TikTok, Facebook) are kept for the owner to
 * message by hand; none is contacted here.
 */

import { creatorEmail, readFeed, searchPodcasts } from './podcasts.ts'

/** What a search found. */
export interface ContactResult {
  email?: string
  socials: string[]
  tried: string[]
}

/** Hosts that are social profiles: kept for the owner, never fetched. */
const SOCIAL = [
  'instagram.com', 'twitter.com', 'x.com', 'tiktok.com', 'facebook.com', 'fb.com', 'threads.net', 'snapchat.com', 'wa.me',
  'whatsapp.com', 't.me', 'linkedin.com',
]

/** Link hubs whose page lists the creator's other links. */
const HUB = ['linktr.ee', 'beacons.ai', 'bio.link', 'linkin.bio', 'campsite.bio', 'stan.store', 'hoo.be', 'lnk.bio']

/** Hosts never worth fetching for an address: video, music and shop platforms. */
const SKIP = [
  'rss.com', 'podbean.com', 'buzzsprout.com', 'spreaker.com', 'libsyn.com', 'anchor.fm', 'youtube.com', 'youtu.be',
  'spotify.com', 'apple.com', 'soundcloud.com', 'amazon.com', 'amazon.co.uk', 'a.co', 'amzn.to', 'patreon.com', 'paypal.com', 'paystack.com', 'selar.co',
  'google.com', 'goo.gl', 'bit.ly', 'discord.gg', 'discord.com', 'twitch.tv', 'podcasters.spotify.com',
  'buymeacoffee.com', 'ko-fi.com', 'gofundme.com',
]

/** An address in page text. */
const EMAIL = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/giu


/** Words that say nothing about which show a name is. */
const FILLER = new Set(['the', 'a', 'an', 'podcast', 'pod', 'show', 'with', 'w', 'and', 'official', 'tv', 'channel', 'network'])

function nameWords(name: string): string[] {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(w => w !== '' && !FILLER.has(w))
}

/**
 * Whether a podcast is the channel's own show. Stricter than a shared word or two: the two names must be the same
 * once filler words are dropped, or one must contain the other with at least two words and three quarters of the other's length.
 * "The Edge" is not "The Edge: Houston Astros".
 * @param names - the show's title and author.
 * @param channelName - the YouTube channel's name.
 * @returns true when the names identify the same show.
 */
export function ownShow(names: readonly string[], channelName: string): boolean {
  const channel = nameWords(channelName)
  if (channel.length === 0) return false
  return names.some((name) => {
    const show = nameWords(name)
    if (show.length === 0) return false
    const a = channel.join(' ')
    const b = show.join(' ')
    if (a === b) return true
    const [short, long] = a.length <= b.length ? [channel, show] : [show, channel]
    return short.length >= 2 && ` ${long.join(' ')} `.includes(` ${short.join(' ')} `) && short.join(' ').length / long.join(' ').length >= 0.75
  })
}

/** Pages tried on each website. */
const SITE_PATHS = ['/', '/contact', '/contact-us', '/about']

/** Most websites read for one lead. */
const MAX_SITES = 3

/** Largest page body read, in bytes. */
const MAX_PAGE_BYTES = 1_500_000

/**
 * Every plausible address in a page, mailto links first.
 * @param page - HTML or text.
 * @returns distinct lower-case addresses, best first.
 */
export function emailsIn(page: string): string[] {
  const decoded = page.replace(/&#64;|&#x40;|\\u0040/giu, '@').replace(/\s*\[at\]\s*/giu, '@').replace(/\s*\[dot\]\s*/giu, '.')
  const mailto = [...decoded.matchAll(/mailto:([^"'?\s>]+)/giu)].map(m => decodeURIComponent(m[1] ?? ''))
  const plain = decoded.match(EMAIL) ?? []
  const all = [...mailto, ...plain].map(e => e.toLowerCase().replace(/[.,;:]+$/u, ''))
  return [...new Set(all)].filter(e => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/u.test(e) && creatorEmail(e))
}

/**
 * The links a channel's About page lists, read from the page's embedded data.
 * @param page - the About page HTML.
 * @returns absolute https URLs, in page order.
 */
export function aboutLinks(page: string): string[] {
  const links = [...page.matchAll(/"channelExternalLinkViewModel":\{"title":\{"content":"[^"]*"\},"link":\{"content":"([^"]+)"/gu)].map(m => m[1] ?? '')
  return [...new Set(links.filter(l => l !== '').map(l => (/^https?:\/\//u.test(l) ? l : `https://${l}`)))]
}

/**
 * The outbound links of a link-hub page (a Linktree and its kind).
 * @param page - the hub's HTML.
 * @returns absolute http(s) URLs.
 */
export function hubLinks(page: string): string[] {
  return [...new Set([...page.matchAll(/href="(https?:\/\/[^"]+)"/giu)].map(m => m[1] ?? '').filter(u => u !== ''))]
}

/** Whether a host is one of the listed domains or under one. */
function hostIn(host: string, domains: readonly string[]): boolean {
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`))
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, '')
  } catch (_error) {
    // Not a URL: nothing to fetch.
    return undefined
  }
}

/** Fetch a page as text, bounded in time and size; undefined when it cannot be read. */
async function page(
  fetcher: typeof fetch, url: string, signal: AbortSignal, headers: Record<string, string> = {},
): Promise<string | undefined> {
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', 'Accept-Language': 'en', ...headers },
    })
    if (!response.ok) return undefined
    const type = response.headers.get('content-type') ?? ''
    if (type !== '' && !/text|html|xml|json/iu.test(type)) return undefined
    const text = await response.text()
    return text.slice(0, MAX_PAGE_BYTES)
  } catch (_error) {
    // Unreachable, refused or too slow: the next place is tried.
    return undefined
  }
}

/**
 * Look for a channel's email in the places listed above, stopping at the first address.
 * @param fetcher - HTTP.
 * @param channel - the channel's URL and name.
 * @param podcastCountry - the podcast directory country to search.
 * @param signal - cancels the search.
 * @returns the address when one was found, the social profiles seen, and each place tried.
 */
export async function findContact(
  fetcher: typeof fetch,
  channel: { channelId: string; channelUrl: string; channelName: string },
  podcastCountry: string,
  signal: AbortSignal,
): Promise<ContactResult> {
  const tried: string[] = []
  const socials: string[] = []
  const done = (email: string | undefined): ContactResult => ({ ...email === undefined ? {} : { email }, socials, tried })

  // YouTube asks for cookie consent first in some regions; these cookies answer it.
  const about = await page(fetcher, `${channel.channelUrl.replace(/\/+$/u, '')}/about`, signal, { Cookie: 'CONSENT=YES+1; SOCS=CAI' })
  const links = about === undefined ? [] : aboutLinks(about)
  tried.push(about === undefined ? 'About page: could not be read' : `About page: ${String(links.length)} link${links.length === 1 ? '' : 's'}`)
  const aboutEmail = about === undefined ? undefined : emailsIn(about.match(/"description":\{"simpleText":"[^"]*"/u)?.[0] ?? '')[0]
  if (aboutEmail !== undefined) { tried.push(`About page description: ${aboutEmail}`); return done(aboutEmail) }

  const sites: string[] = []
  const hubs: string[] = []
  for (const link of links) {
    const host = hostOf(link)
    if (host === undefined) continue
    if (hostIn(host, SOCIAL)) socials.push(link)
    else if (hostIn(host, HUB)) hubs.push(link)
    else if (!hostIn(host, SKIP)) sites.push(link)
  }

  for (const hub of hubs) {
    const body = await page(fetcher, hub, signal)
    if (body === undefined) { tried.push(`${hub}: could not be read`); continue }
    const found = emailsIn(body)[0]
    tried.push(`${hub}: ${found ?? 'no address'}`)
    if (found !== undefined) return done(found)
    for (const link of hubLinks(body)) {
      const host = hostOf(link)
      if (host === undefined || hostIn(host, HUB) || hostIn(host, SKIP)) continue
      if (hostIn(host, SOCIAL)) { if (!socials.includes(link)) socials.push(link) } else if (!sites.includes(link)) sites.push(link)
    }
  }

  for (const site of sites.slice(0, MAX_SITES)) {
    let origin: string
    try {
      origin = new URL(site).origin
    } catch (_error) {
      continue
    }
    for (const path of SITE_PATHS) {
      const url = `${origin}${path}`
      const body = await page(fetcher, url, signal)
      if (body === undefined) { tried.push(`${url}: could not be read`); continue }
      const found = emailsIn(body)[0]
      tried.push(`${url}: ${found ?? 'no address'}`)
      if (found !== undefined) return done(found)
    }
  }

  try {
    const shows = await searchPodcasts(fetcher, channel.channelName, podcastCountry, 5, signal)
    const show = shows.find(s => ownShow([s.title, s.author], channel.channelName))
    if (show === undefined) {
      tried.push(`podcast directory: no show named like "${channel.channelName}"`)
    } else {
      const feed = await readFeed(fetcher, show.feedUrl, signal)
      // A feed that names other YouTube channels belongs to a different show with a similar name.
      if (feed.youtubeChannelIds.length > 0 && !feed.youtubeChannelIds.includes(channel.channelId)) {
        tried.push(`podcast "${show.title}": its feed links a different YouTube channel`)
      } else {
        tried.push(`podcast "${show.title}": ${feed.email ?? 'no address in its feed'}`)
        if (feed.email !== undefined) return done(feed.email.toLowerCase())
      }
    }
  } catch (error) {
    tried.push(`podcast directory: ${error instanceof Error ? error.message : String(error)}`)
  }
  return done(undefined)
}
