/**
 * Pick a site's connector by its publisher kind and wire its credentials. The
 * credentials are read again on every call, so a key saved in settings applies
 * without rebuilding the connector.
 */

import type { Publisher, Site, SiteSecrets } from '../types.ts'
import { PublisherError } from './errors.ts'
import { kliparaPublisher } from './klipara.ts'
import { wordpressPublisher } from './wordpress.ts'

export { PublisherError, type PublisherErrorCode } from './errors.ts'
export { kliparaIdempotencyKey, kliparaPublisher, type KliparaPublisher, type KliparaPublisherOptions } from './klipara.ts'
export { escapeHtml, markdownToHtml, markdownToText, safeUrl, type MarkdownOptions } from './markdown.ts'
export {
  KLIPARA_CLIP_PAGE, MAX_MEDIA_BYTES, probeWordPress, wordpressContent, wordpressPublisher,
  type WordPressProbe, type WordPressPublisherOptions, type WordPressSeoPlugin,
} from './wordpress.ts'

/** Read one secret, or fail naming it and the site. */
function required(site: Site, secrets: () => SiteSecrets, field: keyof SiteSecrets, label: string): () => string {
  const read = (): string => {
    const value = secrets()[field]?.trim() ?? ''
    if (value === '') throw new PublisherError(`Site "${site.name}" has no ${label} (${field}) saved.`, 0, 'config', false)
    return value
  }
  read()
  return read
}

/**
 * Build the connector for a site.
 * @param fetcher - the HTTP client.
 * @param site - the site; `kind` selects the connector and `baseUrl` is where it writes.
 * @param secrets - reads the site's credentials at call time.
 * @param timeoutMs - abandon one HTTP call after this long.
 * @returns the connector.
 * @throws PublisherError with code `config` naming the first missing credential.
 */
export function createPublisher(fetcher: typeof fetch, site: Site, secrets: () => SiteSecrets, timeoutMs: number): Publisher {
  switch (site.kind) {
    case 'klipara':
      return kliparaPublisher(fetcher, { baseUrl: site.baseUrl, apiKey: required(site, secrets, 'apiKey', 'Klipara API key') }, timeoutMs)
    case 'wordpress':
      return wordpressPublisher(fetcher, {
        baseUrl: site.baseUrl,
        user: required(site, secrets, 'wpUser', 'WordPress user'),
        appPassword: required(site, secrets, 'wpAppPassword', 'WordPress application password'),
      }, timeoutMs)
    default:
      return assertNever(site.kind)
  }
}

/** Exhaustiveness check for the closed `PublisherKind` union. */
function assertNever(kind: never): never {
  throw new PublisherError(`Unknown publisher kind ${String(kind)}.`, 0, 'config', false)
}
