/**
 * Types shared by the SEO employee's modules: the sites it writes for, keyword
 * and Search Console data, article drafts, and the publisher connectors.
 */

/** Which connector publishes a site's articles. */
export type PublisherKind = 'klipara' | 'wordpress'

/** One market a site is researched for: a Google Ads geo target and an optional language. */
export interface Market {
  /** Label, for example `Nigeria`. */
  label: string
  /** Google Ads geo target constant id, for example `2566`; empty means worldwide. */
  geoId: string
  /** Google Ads language constant id, for example `1000` (English); empty means all languages (used for Hausa). */
  languageId: string
}

/** What the writer needs to know about the business behind a site. */
export interface SiteProfile {
  /** What the business does, in plain words. */
  business: string
  /** Who the readers are. */
  audience: string
  /** What the business sells and to whom; what an article may point readers to. */
  offer: string
  /** How articles should sound; words and claims to avoid. */
  voice: string
  /** The call to action an article ends with. */
  cta: { text: string; url: string }
}

/** A site the employee researches and writes for. */
export interface Site {
  id: string
  name: string
  /** Public origin, for example `https://klipara.linkfa.de`. */
  baseUrl: string
  kind: PublisherKind
  enabled: boolean
  profile: SiteProfile
  markets: Market[]
  /** Seed topics for keyword research. */
  seeds: string[]
  /** Search Console property, for example `sc-domain:linkfa.de` or `https://klipara.linkfa.de/`. */
  gscProperty: string
  articlesPerWeek: number
  author: { name: string; url: string; bio: string }
  createdAt: string
}

/** Credentials a site's publisher uses; stored on the server, never sent to the browser. */
export interface SiteSecrets {
  /** Klipara: an API key with the `content:write` scope. */
  apiKey?: string
  /** WordPress: the user an application password belongs to. */
  wpUser?: string
  /** WordPress: an application password (Users → Profile → Application Passwords). */
  wpAppPassword?: string
}

/** Competition for ad slots as Google Ads reports it; not organic ranking difficulty. */
export type AdsCompetition = 'UNSPECIFIED' | 'UNKNOWN' | 'LOW' | 'MEDIUM' | 'HIGH'

/** One keyword idea from Keyword Planner. */
export interface KeywordIdea {
  text: string
  /** Rounded 12-month average; undefined when Google gives none. */
  avgMonthlySearches?: number
  monthly: { year: number; month: number; searches: number }[]
  competition: AdsCompetition
  /** 0–100 ad competition, undefined when Google has too little data. */
  competitionIndex?: number
  lowTopOfPageBidMicros?: number
  highTopOfPageBidMicros?: number
}

/** One Search Console row. Keys are present for the dimensions requested. */
export interface GscRow {
  query?: string
  page?: string
  country?: string
  device?: string
  date?: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

/** A question and answer shown as an FAQ and marked up as FAQPage. */
export interface Faq {
  q: string
  a: string
}

/** A source an article cites. */
export interface Source {
  title: string
  url: string
}

/** An article as the writer submits it. */
export interface ArticleDraft {
  slug: string
  title: string
  /** At most 60 characters. */
  metaTitle: string
  /** 70–160 characters. */
  metaDescription: string
  /** One-line subtitle. */
  dek: string
  /** Markdown; no raw HTML. Klipara sample clips embed as a line `::clip[<id>]`. */
  bodyMarkdown: string
  tags: string[]
  faq: Faq[]
  sources: Source[]
  coverImageUrl?: string
  coverAlt?: string
}

/** Publication state on the site. */
export type ArticleStatus = 'draft' | 'published'

/** An article as the site reports it. */
export interface RemoteArticle {
  id: string
  slug: string
  title: string
  url: string
  status: ArticleStatus
  tags: string[]
  publishedAt?: string
  updatedAt?: string
}

/** The calls every site connector implements. Failures throw `PublisherError`. */
export interface Publisher {
  /** Every article on the site, for internal links and duplicate checks. */
  list(signal: AbortSignal): Promise<RemoteArticle[]>
  create(draft: ArticleDraft, status: ArticleStatus, author: Site['author'], signal: AbortSignal): Promise<RemoteArticle>
  update(id: string, draft: ArticleDraft, status: ArticleStatus, author: Site['author'], signal: AbortSignal): Promise<RemoteArticle>
  unpublish(id: string, signal: AbortSignal): Promise<RemoteArticle>
  /** Copy an image to the site; returns its URL there. */
  uploadMedia(imageUrl: string, alt: string, signal: AbortSignal): Promise<string>
}
