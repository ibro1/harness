/**
 * The privacy scrubber every report passes before it leaves the process or
 * the browser. The harness holds outreach data, so a report keeps only what
 * locates a fault: exception types, redacted messages, code locations, and a
 * fixed set of tags. It removes:
 *
 * - cookies, headers, request bodies, and every query-string value;
 * - anything shaped like an email address, phone number, API key, bearer
 *   token, JWT or OAuth code, in any string;
 * - creator and lead data (names, handles, addresses, pitch, reply and
 *   comment text, sample titles) and prompts, transcripts and model output,
 *   by key at any depth, and by value where the caller names the strings;
 * - breadcrumbs, local variables, and any user field but the id.
 *
 * Dependency-free: the same code runs in Node and in the browser bundle.
 */

/**
 * The parts of a Sentry event the scrubber reads or rewrites. Every Sentry
 * event type is assignable to it, so the SDK's own event passes unconverted.
 */
export interface ScrubbableEvent {
  message?: string | undefined
  logentry?: { message?: string | undefined; params?: unknown[] | undefined } | undefined
  exception?: { values?: ScrubbableException[] | undefined } | undefined
  tags?: object | undefined
  extra?: object | undefined
  contexts?: object | undefined
  request?: object | undefined
  user?: object | undefined
  breadcrumbs?: unknown[] | undefined
  threads?: unknown
  server_name?: string | undefined
}

/** One exception of an event. */
export interface ScrubbableException {
  type?: string | undefined
  value?: string | undefined
  stacktrace?: { frames?: object[] | undefined } | undefined
  mechanism?: object | undefined
}

/** Tags a report may carry; any other tag is dropped. */
export const ALLOWED_TAGS = new Set([
  'plugin', 'logger', 'stage', 'lead_id', 'sample_id', 'provider', 'model', 'session_id',
  'route', 'method', 'source', 'kind', 'test', 'slot', 'runtime', 'handled', 'mechanism', 'level', 'url', 'transaction', 'release', 'environment',
])

/** SDK-owned contexts that describe the runtime, not the data; kept as they are. */
const RUNTIME_CONTEXTS = new Set(['os', 'runtime', 'device', 'app', 'browser', 'culture', 'cloud_resource', 'trace'])

/**
 * Keys whose values are people, outreach content, model traffic or
 * credentials, at any depth: the value is replaced whatever it holds.
 */
const SENSITIVE_KEY = new RegExp([
  // people and channels
  '^(?:first|last|full|display|user|channel|creator|lead|contact|sender|recipient|author)?_?name$', 'handle', 'username', 'e-?mail', 'phone', 'mobile', 'whatsapp',
  'address', 'channel_?url', 'avatar',
  // outreach content
  'pitch', 'repl(?:y|ies)', 'comment', 'message_?text', '^text$', '^body$', '^title$', 'video_?title', 'sample_?title', 'subject', 'note', 'caption', 'description',
  // model traffic
  'prompt', 'transcript', 'completion', 'output', 'content', 'messages', 'history', 'argument', '^args$', '^input$', 'tool_?input', 'html', 'page_?(?:text|content)', 'snapshot', 'screenshot',
  // credentials and transport
  'cookie', 'authori[sz]ation', 'auth', 'token', 'secret', 'password', 'passwd', 'api_?key', 'private_?key', 'session_?key', 'credential', 'dsn', 'headers?$', '^data$', 'query_?string',
].join('|'), 'iu')

const REDACTED = '[redacted]'

/** A pattern and what replaces each match. */
type Redaction = [RegExp, string | ((match: string) => string)]

/** Personal values: addresses and phone numbers. Applied to every string, tags included. */
const PERSONAL: Redaction[] = [
  [/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/gu, '[email]'],
  // International (+234 803 123 4567), Nigerian local (08031234567) and North American (212-555-0147) shapes.
  [/(?<![\w+])\+\d[\d\s().-]{7,}\d(?!\w)/gu, '[phone]'],
  [/\b0[789][01]\d{8}\b/gu, '[phone]'],
  [/\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/gu, '[phone]'],
]

/** Credentials. Applied to every string but tags, whose values are ids the reporter sets. */
const CREDENTIALS: Redaction[] = [
  [/\bBearer\s+[\w.~+/=-]+/giu, 'Bearer [redacted]'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/gu, '[jwt]'],
  [/\b(?:code|token|access_token|refresh_token|id_token|key|sentry_key|api_key|apikey|secret|password|state)=[^&\s"']+/giu,
    match => `${match.slice(0, match.indexOf('='))}=[redacted]`],
  [/\b(?:klp_sk_(?:live|test)_|sk-(?:ant-|proj-)?|ghp_|gho_|github_pat_|xox[abpr]-|AIza|ya29\.|glpat-|dop_v1_|AKIA)[\w.-]{8,}/gu, '[key]'],
  [/\b[A-Fa-f0-9]{40,}\b/gu, '[key]'],
  [/\b(?=[\w-]*[A-Z])(?=[\w-]*[a-z])(?=[\w-]*\d)[\w-]{32,}\b/gu, '[key]'],
]

function apply(value: string, redactions: readonly Redaction[]): string {
  let out = value
  for (const [pattern, replacement] of redactions) {
    const replace = typeof replacement === 'string' ? (): string => replacement : replacement
    out = out.replace(pattern, replace)
  }
  return out
}

function removeNamed(value: string, named: readonly string[]): string {
  let out = value
  for (const text of named) {
    if (text.trim().length >= 3) out = out.split(text).join(REDACTED)
  }
  return out
}

/**
 * Redact credentials, addresses, phone numbers, the named strings, and every
 * query-string value from one string, then cap its length.
 * @param value - the string.
 * @param named - exact strings to remove (a lead's own name, address, title).
 * @param max - the longest result kept.
 * @returns the redacted string.
 */
export function scrubString(value: string, named: readonly string[] = [], max = 1000): string {
  let out = removeNamed(value, named)
  out = out.replace(/(https?:\/\/[^\s?#"']+)\?[^\s#"']*/giu, (_match, base: string) => `${base}?[query]`)
  out = apply(apply(out, CREDENTIALS), PERSONAL)
  return out.length > max ? `${out.slice(0, max)}…` : out
}

/**
 * Scrub a tag value: the named strings and personal values go, ids stay.
 * @param value - the tag value.
 * @param named - exact strings to remove.
 * @returns the scrubbed value, at most 200 characters.
 */
export function scrubTag(value: string, named: readonly string[] = []): string {
  const out = apply(removeNamed(value, named), PERSONAL)
  return out.length > 200 ? out.slice(0, 200) : out
}

/**
 * Scrub a free-form value at any depth: sensitive keys lose their value
 * entirely, strings are redacted, depth and size are capped.
 * @param value - the value.
 * @param named - exact strings to remove.
 * @param depth - remaining depth.
 * @returns the scrubbed copy.
 */
export function scrubValue(value: unknown, named: readonly string[] = [], depth = 6): unknown {
  if (typeof value === 'string') return scrubString(value, named)
  if (value === null || typeof value !== 'object') return value
  if (depth <= 0) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 50).map(item => scrubValue(item, named, depth - 1))
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value).slice(0, 100)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrubValue(inner, named, depth - 1)
  }
  return out
}

/**
 * The request fields a report keeps: method and URL without its query
 * values; never headers, cookies, bodies or environment.
 * @param request - the SDK's request record.
 * @returns the kept fields.
 */
function scrubRequest(request: object): { method?: string; url?: string } {
  const { method, url } = request as { method?: unknown; url?: unknown }
  return {
    ...typeof method === 'string' ? { method } : {},
    ...typeof url === 'string' ? { url: scrubString(url.replace(/[?#].*$/u, '')) } : {},
  }
}

/**
 * Scrub one event of its sensitive parts.
 * @param event - the event the SDK is about to send.
 * @param named - exact strings to remove anywhere they appear.
 * @returns a scrubbed copy.
 */
export function scrubEvent(event: ScrubbableEvent, named: readonly string[] = []): ScrubbableEvent {
  const { breadcrumbs: _breadcrumbs, threads: _threads, server_name: _server, ...out } = event
  if (typeof out.message === 'string') out.message = scrubString(out.message, named)
  if (out.logentry !== undefined) {
    out.logentry = out.logentry.message === undefined ? {} : { message: scrubString(out.logentry.message, named) }
  }
  if (out.exception?.values !== undefined) {
    out.exception = {
      values: out.exception.values.map((exception): ScrubbableException => ({
        ...exception.type === undefined ? {} : { type: exception.type },
        ...exception.value === undefined ? {} : { value: scrubString(exception.value, named) },
        ...exception.stacktrace?.frames === undefined ? {} : {
          stacktrace: {
            frames: exception.stacktrace.frames.map((frame) => {
              const { vars: _vars, ...kept } = frame as { vars?: unknown }
              return kept
            }),
          },
        },
        ...exception.mechanism === undefined ? {} : {
          mechanism: (({ type, handled }: { type?: unknown; handled?: unknown }) => ({ type, handled }))(exception.mechanism),
        },
      })),
    }
  }
  if (out.tags !== undefined) {
    out.tags = Object.fromEntries(Object.entries(out.tags)
      .filter(([key]) => ALLOWED_TAGS.has(key))
      .map(([key, value]) => [key, typeof value === 'string' ? scrubTag(value, named) : value]))
  }
  if (out.extra !== undefined) out.extra = scrubValue(out.extra, named) as object
  if (out.contexts !== undefined) {
    out.contexts = Object.fromEntries(Object.entries(out.contexts).map(([key, value]) =>
      [key, RUNTIME_CONTEXTS.has(key) ? value : scrubValue(value, named)]))
  }
  if (out.request !== undefined) out.request = scrubRequest(out.request)
  if (out.user !== undefined) {
    const { id } = out.user as { id?: unknown }
    out.user = id === undefined ? {} : { id }
  }
  return out
}

/** Messages of failures that are expected and not worth a report. */
const EXPECTED_MESSAGES = [
  /\b(?:401|403|404)\b.*\b(?:unauthori[sz]ed|forbidden|not found)\b/iu,
  /\b(?:unauthori[sz]ed|forbidden|not found)\b.*\b(?:401|403|404)\b/iu,
  /\babort(?:ed|error)?\b|\bcancel(?:l?ed|lation)?\b/iu,
  /RESOURCE_EXHAUSTED|\bquota\b|\b429\b|rate.?limit/iu,
  /^Failed to fetch$|^Load failed$|NetworkError when attempting to fetch resource/iu,
]

/** Error names of expected failures. */
const EXPECTED_NAMES = new Set(['AbortError', 'CanceledError', 'CancelledError'])

/**
 * Whether an error is an expected one (a 401/403/404, an abort or
 * cancellation, a spent quota or rate limit, a browser network drop) that
 * reporting skips.
 * @param error - the error or rejection reason.
 * @returns true to skip it.
 */
export function expectedError(error: unknown): boolean {
  if (error === null || error === undefined) return false
  const record = typeof error === 'object' ? error as Record<string, unknown> : {}
  const name = typeof record['name'] === 'string' ? record['name'] : ''
  if (EXPECTED_NAMES.has(name)) return true
  const status = [record['status'], record['statusCode'], record['code']].find(v => typeof v === 'number')
  if (status === 401 || status === 403 || status === 404 || status === 429) return true
  if (record['code'] === 'ABORTED' || record['code'] === 'ABORT_ERR' || record['code'] === 'QUOTA' || record['code'] === 'RATE_LIMIT') return true
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : typeof record['message'] === 'string' ? record['message'] : ''
  return EXPECTED_MESSAGES.some(pattern => pattern.test(message))
}
