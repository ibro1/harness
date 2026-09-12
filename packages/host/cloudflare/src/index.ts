/**
 * Cloudflare control for the harness: a settings-configured roster of zones,
 * and the agent tools that purge cache and manage DNS through Cloudflare's v4
 * API.
 *
 * The harness already drives the deploy half of the loop through
 * `dsh-host-dokploy` and had nothing for the edge half. A deploy is correct at
 * the origin and still serves stale bytes for hours, separately per edge
 * location, whenever the changed assets were cached: an HTML document updated
 * while its images did not, and the only remaining fix was a person opening the
 * Cloudflare dashboard. `cloudflare_purge` ends that state from inside the
 * loop, and `cloudflare_cache_status` reports it without credentials, so the
 * agent can tell a stale edge from a wrong origin before it changes anything.
 *
 * Zones live in the `cloudflare` user-settings namespace, one entry per zone
 * with a name, a zone id, and an API token supplied either as the name of an
 * environment variable or inline. The tools resolve a zone by name against that
 * roster and never take a zone id or token from the model, so a prompt cannot
 * point them at somebody else's zone.
 *
 * @module @deepseek-ai/dsh-host-cloudflare
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** The settings namespace holding the zone roster. */
const NS = 'cloudflare'

/** One configured Cloudflare zone, as stored in settings. */
interface CloudflareZone {
  name: string
  zoneId: string
  /** Name of the environment variable holding this zone's API token (preferred). */
  apiTokenEnv?: string
  /** The API token inline — simpler, but stored in settings and shown in the card. */
  apiToken?: string
}

/**
 * The account-wide credential, separate from every zone's.
 *
 * Creating a zone is an account operation, not a zone one: it needs
 * `Account → Zone: Edit`, which no per-zone token carries and which reaches
 * every domain on the account. Keeping it in its own field means the narrow
 * per-zone tokens stay narrow, and an account that never creates zones never
 * has to hold a token that could.
 */
interface CloudflareAccount {
  /** The account id, from any zone's overview page. Empty disables the account tools. */
  id?: string
  /** Name of the environment variable holding the account token (preferred). */
  apiTokenEnv?: string
  /** The account token inline — simpler, but stored in settings and shown in the card. */
  apiToken?: string
}

/** The resolved `cloudflare` settings section. */
interface CloudflareConfig {
  zones: CloudflareZone[]
  account?: CloudflareAccount
}

/**
 * Schema for the settings namespace. Both token forms are optional here and
 * the settings card accepts either, because a zone authenticates with whichever
 * one is present; a zone carrying neither fails at its first call with a
 * message naming what to set.
 */
const CONFIG_SCHEMA: z<CloudflareConfig> = z.object({
  zones: z.array(z.object({
    name: z.string().required().description('A short label you choose for this zone, used when asking a tool to act on it.'),
    zoneId: z.string().required().description('The Cloudflare zone id, from the zone overview page.'),
    apiTokenEnv: z.string().description('Preferred: name of the environment variable holding this zone API token (e.g. CLOUDFLARE_TOKEN_SITE), so the token stays out of settings. Requires that variable to be set on the harness.'),
    apiToken: z.string().description('Alternative to apiTokenEnv: the API token itself. Simpler, but it is stored here in settings and shown in this form.'),
  })).default([]).description('Cloudflare zones this harness may purge and edit DNS on. Give each zone either apiTokenEnv or apiToken.'),
  account: z.object({
    id: z.string().description('The Cloudflare account id, from any zone overview page. Leave empty to keep the account tools off.'),
    apiTokenEnv: z.string().description('Preferred: name of the environment variable holding the account token (e.g. CLOUDFLARE_ACCOUNT_TOKEN), so it stays out of settings.'),
    apiToken: z.string().description('Alternative to apiTokenEnv: the account token itself. Simpler, but stored here in settings and shown in this form.'),
  }).description('Optional. Only needed to create zones or list every zone on the account; it needs Account → Zone: Edit, which reaches every domain you own.'),
})

/** The plugin name, for the Loader. */
export const name = 'cloudflare'

/** The services this plugin reads. */
export const inject = ['settings', 'agents', 'webServer']

/** Composition config; the roster lives in settings, so nothing is required here. */
export interface Config {
  /** Milliseconds one API call may take before it is abandoned. */
  timeoutMs: number
  /** Absolute path of the token-guarded command route MCP clients reach. */
  path: string
  /** Shared secret the command route requires; empty leaves the route unmounted. */
  token: string
  /** Root of the Cloudflare v4 API, overridable for a deployment that fronts it with an egress proxy. */
  apiBase: string
}

/** Composition config; the roster lives in settings, so nothing is required here. */
export const Config: z<Config> = z.object({
  timeoutMs: z.natural().min(1000).default(15_000),
  path: z.string().default('/cloudflare'),
  token: z.string().default(''),
  apiBase: z.string().default('https://api.cloudflare.com/client/v4'),
})

/** Largest command body accepted on the MCP route. */
const MAX_COMMAND_BODY_BYTES = 64 * 1024

/** Cloudflare rejects a `purge_cache` call carrying more files than this. */
const MAX_PURGE_URLS = 30

/** Compare two secrets without leaking their relationship through timing. */
function secretEquals(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

/**
 * Read a request body, refusing one past the cap rather than buffering it.
 * @param req - the request to drain. @param limit - most bytes to accept.
 * @returns the body text, or undefined when it exceeded the cap.
 */
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

/** The canonical output of every Cloudflare tool: text for the model to read. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      required: true,
      description: 'What Cloudflare reported, as text.',
    },
  },
} as const satisfies ValueSchemaSpec

/** Trim the API root to its base, so a trailing slash does not double up. */
function apiBase(url: string): string {
  return url.replace(/\/+$/u, '')
}

/** Read the zone roster live from settings each call, so edits take effect at once. */
type ReadZones = () => readonly CloudflareZone[]

/** Read the account section live from settings, so an edit takes effect at once. */
type ReadAccount = () => CloudflareAccount | undefined

/**
 * Resolve a zone by name, or explain which names exist.
 * @param zones - the current roster.
 * @param requested - the name the model asked for, if any.
 * @returns the matched zone.
 * @throws when none are configured, the name is unknown, or several exist and
 * the caller named none — never guessing, since purging the wrong zone costs
 * every visitor of that site a cold cache.
 */
function resolveZone(zones: readonly CloudflareZone[], requested: string | undefined): CloudflareZone {
  if (zones.length === 0) {
    throw new Error('No Cloudflare zones are configured; add one under Settings → cloudflare.')
  }
  if (requested !== undefined && requested !== '') {
    const match = zones.find(zone => zone.name === requested)
    if (match === undefined) {
      throw new Error(`No Cloudflare zone named ${JSON.stringify(requested)}; configured: ${zones.map(z2 => z2.name).join(', ')}.`)
    }
    return match
  }
  if (zones.length > 1) {
    throw new Error(`Several Cloudflare zones are configured (${zones.map(z2 => z2.name).join(', ')}); pass zone to choose one.`)
  }
  return zones[0] as CloudflareZone
}

/**
 * Resolve one zone's API token from its environment variable or its inline value.
 * @param zone - the resolved zone.
 * @returns the token.
 * @throws when neither form yields a non-empty token, naming which field to fix.
 */
/**
 * A token and the label errors name it by — a zone's, or the account's.
 *
 * The call helper takes this rather than a zone, so the account tools reuse it
 * without a second copy of the JSON, success-flag and timeout handling.
 */
interface Credential {
  name: string
  token: string
}

function resolveToken(zone: CloudflareZone): string {
  const fromEnv = zone.apiTokenEnv !== undefined && zone.apiTokenEnv !== ''
    ? process.env[zone.apiTokenEnv]?.trim()
    : undefined
  const inline = zone.apiToken !== undefined && zone.apiToken.trim() !== '' ? zone.apiToken.trim() : undefined
  const apiToken = fromEnv ?? inline
  if (apiToken === undefined || apiToken === '') {
    const hint = zone.apiTokenEnv !== undefined && zone.apiTokenEnv !== ''
      ? `set the ${zone.apiTokenEnv} environment variable, or put the token in this zone's apiToken field`
      : 'give this zone an apiToken, or an apiTokenEnv naming a set environment variable'
    throw new Error(`Cloudflare ${zone.name} has no API token: ${hint}.`)
  }
  return apiToken
}

/** A record whose fields Cloudflare owns; read defensively. */
type Json = Record<string, unknown>

/** Best-effort string field. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Best-effort array of records. */
function rows(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((row): row is Json => typeof row === 'object' && row !== null) : []
}

/**
 * Join the `message` of every entry in a Cloudflare `errors` array.
 * @param value - the `errors` field as received.
 * @returns the messages, comma-separated, or an empty string when there are none.
 */
function errorMessages(value: unknown): string {
  return rows(value).map(row => str(row['message'])).filter(message => message !== '').join('; ')
}

/**
 * Call one Cloudflare v4 endpoint and unwrap its `result`.
 *
 * Cloudflare answers `200` with `success: false` for many failures, so the HTTP
 * status alone decides nothing: every response is parsed and `success` is
 * checked, and Cloudflare's own `errors[].message` becomes the thrown message
 * because it is the part that says what to change.
 *
 * @param base - the API root from composition config.
 * @param zone - the resolved zone, carrying its id and token.
 * @param path - the path after the API root, for example `/zones/abc/purge_cache`.
 * @param init - method and body; GET when omitted.
 * @param timeoutMs - abandon the call after this long.
 * @returns the `result` field of the response.
 * @throws when the request fails, the body is not JSON, or Cloudflare reports
 * `success: false`.
 */
async function callCloudflare(
  base: string,
  credential: Credential,
  path: string,
  init: { method?: string; body?: unknown } | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const apiToken = credential.token
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(`${apiBase(base)}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      throw new Error(`Cloudflare ${credential.name} answered ${String(response.status)} with a non-JSON body: ${text.slice(0, 300)}`)
    }
    const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Json
    if (body['success'] !== true) {
      const messages = errorMessages(body['errors'])
      throw new Error(`Cloudflare ${credential.name} refused the call (HTTP ${String(response.status)}): ${messages === '' ? text.slice(0, 300) : messages}`)
    }
    return body['result']
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Cloudflare ${credential.name} did not answer within ${String(timeoutMs)}ms`)
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve the account credential, or explain what is missing.
 *
 * Both halves are required and the error says which one is absent, because
 * "Cloudflare refused the call" for a blank account id is a much worse message
 * than "no account id is configured".
 * @param account - the account section of settings, if any.
 * @returns the account id and the token to call with.
 * @throws when no account is configured, or it carries no usable token.
 */
function resolveAccount(account: CloudflareAccount | undefined): { id: string; credential: Credential } {
  const id = account?.id?.trim() ?? ''
  if (id === '') {
    throw new Error('No Cloudflare account is configured; add an account id under Settings → cloudflare. It is only needed for creating zones and listing every zone on the account.')
  }
  const fromEnv = account?.apiTokenEnv !== undefined && account.apiTokenEnv !== ''
    ? process.env[account.apiTokenEnv]?.trim()
    : undefined
  const inline = account?.apiToken !== undefined && account.apiToken.trim() !== '' ? account.apiToken.trim() : undefined
  const apiToken = fromEnv ?? inline
  if (apiToken === undefined || apiToken === '') {
    const hint = account?.apiTokenEnv !== undefined && account.apiTokenEnv !== ''
      ? `set the ${account.apiTokenEnv} environment variable, or put the token in the account's apiToken field`
      : 'give the account an apiToken, or an apiTokenEnv naming a set environment variable'
    throw new Error(`The Cloudflare account has no API token: ${hint}. It needs Account → Zone: Edit.`)
  }
  return { id, credential: { name: 'account', token: apiToken } }
}

/**
 * Decide whether one resolved IP address belongs to a range the harness must
 * not be aimed at: loopback, private, link-local, CGNAT, multicast, reserved,
 * and the unspecified address, in both families.
 * @param address - the literal address, as `dns.lookup` returned it.
 * @returns true when a request to this address is refused.
 */
function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const octets = address.split('.').map(part => Number.parseInt(part, 10))
    const [a = 0, b = 0] = octets
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 192 && b === 0) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    // 224/4 multicast through 255/8 reserved, including the broadcast address.
    if (a >= 224) return true
    return false
  }
  if (family === 6) {
    const lower = address.toLowerCase().replace(/%.*$/u, '')
    // An IPv4-mapped address reaches the same host as its embedded IPv4 one.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower)
    if (mapped?.[1] !== undefined) return isBlockedAddress(mapped[1])
    if (lower === '::' || lower === '::1') return true
    if (/^f[cd][0-9a-f]{2}:/u.test(lower)) return true
    if (/^fe[89ab][0-9a-f]:/u.test(lower)) return true
    return false
  }
  // Not an address at all; nothing here can vouch for it.
  return true
}

/**
 * Accept a model-supplied absolute URL only when it names a public host over
 * HTTP or HTTPS.
 *
 * The hostname is resolved and every returned address is checked, so a public
 * name pointing at `127.0.0.1` is refused too. The check is of the resolution
 * taken here, not of the one the later `fetch` performs, so a name that changes
 * answers between the two calls can still slip past; the request that follows
 * is a `HEAD` with redirects unfollowed, which bounds what that buys an
 * attacker to one response's headers.
 *
 * @param raw - the URL as the model supplied it.
 * @returns the parsed URL.
 * @throws when the URL is unparseable, not `http`/`https`, or resolves to any
 * loopback, private, link-local, CGNAT, multicast, or reserved address.
 */
async function requirePublicUrl(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Not an absolute URL: ${JSON.stringify(raw)}. Pass a full URL, for example https://example.com/app.js.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Refusing ${url.protocol} — cloudflare_cache_status only reads http and https URLs.`)
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '')
  const addresses = isIP(hostname) !== 0
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true }).catch((error: unknown) => {
      throw new Error(`Could not resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`)
    })
  if (addresses.length === 0) throw new Error(`Could not resolve ${hostname}.`)
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(`Refusing ${hostname}: it resolves to ${address}, a private or loopback address. cloudflare_cache_status reads public URLs only.`)
    }
  }
  return url
}

/**
 * Register the Cloudflare tools on one agent's context.
 * @param ctx - the agent's context, carrying its tool registry.
 * @param readZones - live reader of the configured roster.
 * @param config - composition config supplying the API root and the timeout.
 */
function registerCloudflareTools(ctx: Context, readZones: ReadZones, readAccount: ReadAccount, config: Config): void {
  for (const tool of buildCloudflareTools(readZones, readAccount, config)) {
    ctx.effect(() => ctx.tools.register(tool), `cloudflare: ${tool.name}`)
  }
}

/**
 * Build the Cloudflare tools without registering them, so one definition serves
 * both the per-agent registry and the MCP command route.
 * @param readZones - live reader of the configured roster.
 * @param config - composition config supplying the API root and the timeout.
 * @returns the tool definitions.
 */
export function buildCloudflareTools(readZones: ReadZones, readAccount: ReadAccount, config: Config): ToolDefinition[] {
  const zoneParameter = {
    type: 'string',
    description: 'Which configured Cloudflare zone to act on, by its name. Omit when only one is configured; use cloudflare_zones to see the names.',
  } as const

  const reply = (text: string): { text: string } => ({ text })
  const call = (
    zone: CloudflareZone,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<unknown> => callCloudflare(config.apiBase, { name: zone.name, token: resolveToken(zone) }, path, init, config.timeoutMs)

  /** The same call, against the account credential rather than a zone's. */
  const callAccount = (
    credential: Credential,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<unknown> => callCloudflare(config.apiBase, credential, path, init, config.timeoutMs)

  return [
    defineTool({
      name: 'cloudflare_zones',
      description: 'List the Cloudflare zones this harness is configured to manage, by name and zone id. API tokens are never shown.',
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: (_args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const zones = readZones()
        const text = zones.length === 0
          ? 'No Cloudflare zones are configured. Add one under Settings → cloudflare.'
          : `Configured Cloudflare zones:\n${zones.map(zone => `- ${zone.name} (${zone.zoneId})`).join('\n')}`
        return Promise.resolve(reply(text))
      },
      presentCall: () => ({ card: 'generic', title: 'List Cloudflare zones', kind: 'other', rawInput: '' }),
    }),

    defineTool({
      name: 'cloudflare_purge',
      description: 'Purge Cloudflare\'s cache for a zone. Pass urls to drop only those absolute URLs (up to 30 per call, Cloudflare\'s cap) — that is the usual fix after a deploy served stale assets. Pass everything: true only when you mean a full purge: it empties the cache at every edge, so the next visitor to every page pays a cold cache and the origin takes the whole load.',
      parameters: {
        zone: zoneParameter,
        urls: {
          type: 'array',
          items: { type: 'string', description: 'One absolute URL, for example https://example.com/assets/app.js.' },
          description: 'The absolute URLs to purge, up to 30. Exactly the URLs a visitor requests, including scheme and query.',
        },
        everything: {
          type: 'boolean',
          description: 'Set true for a full purge of the zone. Destructive to cache warmth; never a substitute for listing the URLs you changed.',
        },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: async (args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const zone = resolveZone(readZones(), args.zone)
        const urls = args.urls ?? []
        const everything = args.everything === true
        // An empty urls array must never fall through to a full purge: the cost
        // of a wrong full purge is paid by every visitor of the site.
        if (everything && urls.length > 0) {
          throw new Error('Pass either urls or everything: true, not both; a full purge already covers every URL.')
        }
        if (!everything) {
          if (urls.length === 0) {
            throw new Error('Nothing to purge: pass urls with the absolute URLs to drop, or everything: true for a full purge of the zone.')
          }
          if (urls.length > MAX_PURGE_URLS) {
            throw new Error(`Cloudflare purges at most ${String(MAX_PURGE_URLS)} URLs per call; ${String(urls.length)} were given. Split them across calls.`)
          }
          for (const url of urls) {
            if (!/^https?:\/\//u.test(url)) {
              throw new Error(`Not an absolute http(s) URL: ${JSON.stringify(url)}. Purge by full URL, for example https://example.com/assets/app.js.`)
            }
          }
        }
        await call(zone, `/zones/${encodeURIComponent(zone.zoneId)}/purge_cache`, {
          method: 'POST',
          body: everything ? { purge_everything: true } : { files: urls },
        })
        return reply(everything
          ? `Purged the entire cache of ${zone.name}. Every edge now misses until it refills from the origin.`
          : `Purged ${String(urls.length)} URL(s) from ${zone.name}:\n${urls.map(url => `- ${url}`).join('\n')}`)
      },
      presentCall: args => ({
        card: 'generic',
        title: args.everything === true ? 'Purge the entire Cloudflare cache' : `Purge ${String((args.urls ?? []).length)} URL(s) from Cloudflare`,
        kind: 'other',
        rawInput: (args.urls ?? []).join('\n'),
      }),
    }),

    defineTool({
      name: 'cloudflare_dns_list',
      description: 'List the DNS records of a zone, optionally narrowed to one record type or one exact name. Use it to see what a name currently points at before changing it.',
      parameters: {
        zone: zoneParameter,
        type: { type: 'string', description: 'Only records of this type, for example A, AAAA, CNAME, TXT.' },
        name: { type: 'string', description: 'Only the record with this exact fully-qualified name, for example app.example.com.' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: async (args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const zone = resolveZone(readZones(), args.zone)
        const query = new URLSearchParams()
        if (args.type !== undefined && args.type !== '') query.set('type', args.type)
        if (args.name !== undefined && args.name !== '') query.set('name', args.name)
        const search = query.toString()
        const suffix = search === '' ? '' : `?${search}`
        const result = await call(zone, `/zones/${encodeURIComponent(zone.zoneId)}/dns_records${suffix}`)
        const records = rows(result)
        if (records.length === 0) return reply(`No DNS records match on ${zone.name}.`)
        const lines = records.map((record) => {
          const proxied = record['proxied'] === true ? ' proxied' : ''
          const ttl = typeof record['ttl'] === 'number' ? ` ttl=${String(record['ttl'])}` : ''
          return `- ${str(record['type'])} ${str(record['name'])} -> ${str(record['content'])}${ttl}${proxied} [${str(record['id'])}]`
        })
        return reply(`DNS records on ${zone.name}:\n${lines.join('\n')}`)
      },
      presentCall: args => ({ card: 'generic', title: 'List Cloudflare DNS records', kind: 'other', rawInput: args.name ?? '' }),
    }),

    defineTool({
      name: 'cloudflare_dns_set',
      description: 'Point one DNS name at one value. The record is looked up by name and type: an existing one is replaced, and a missing one is created. This changes live DNS for the zone.',
      parameters: {
        zone: zoneParameter,
        type: { type: 'string', required: true, description: 'The record type, for example A, AAAA, CNAME, TXT.' },
        name: { type: 'string', required: true, description: 'The fully-qualified record name, for example app.example.com.' },
        content: { type: 'string', required: true, description: 'What the record points at: an IP for A/AAAA, a hostname for CNAME, the text for TXT.' },
        ttl: { type: 'integer', description: 'Time to live in seconds; 1 means automatic. Omit to let Cloudflare choose.' },
        proxied: { type: 'boolean', description: 'Whether Cloudflare proxies this record (the orange cloud). Only valid for record types Cloudflare can proxy.' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: async (args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const zone = resolveZone(readZones(), args.zone)
        const zonePath = `/zones/${encodeURIComponent(zone.zoneId)}/dns_records`
        const query = new URLSearchParams({ type: args.type, name: args.name })
        const existing = rows(await call(zone, `${zonePath}?${query.toString()}`))
        const body = {
          type: args.type,
          name: args.name,
          content: args.content,
          ...(args.ttl === undefined ? {} : { ttl: args.ttl }),
          ...(args.proxied === undefined ? {} : { proxied: args.proxied }),
        }
        const current = existing[0]
        const recordId = current === undefined ? '' : str(current['id'])
        if (recordId !== '') {
          const previous = str(current?.['content'])
          await call(zone, `${zonePath}/${encodeURIComponent(recordId)}`, { method: 'PUT', body })
          return reply(`Replaced the ${args.type} record for ${args.name} on ${zone.name}: ${previous || '(unknown)'} -> ${args.content}.`)
        }
        await call(zone, zonePath, { method: 'POST', body })
        return reply(`Created a ${args.type} record for ${args.name} on ${zone.name} pointing at ${args.content}.`)
      },
      presentCall: args => ({ card: 'generic', title: `Set DNS ${args.type} ${args.name}`, kind: 'other', rawInput: args.content }),
    }),

    defineTool({
      name: 'cloudflare_account_zones',
      description: 'List every zone on the Cloudflare account, including ones not configured in this harness, with the status of each. Needs an account id and an account token in settings.',
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: async (_args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const { id, credential } = resolveAccount(readAccount())
        const query = new URLSearchParams({ 'account.id': id, per_page: '50' })
        const found = rows(await callAccount(credential, `/zones?${query.toString()}`))
        if (found.length === 0) return reply('The Cloudflare account has no zones.')
        const lines = found.map((row) => {
          const status = str(row['status'])
          return `- ${str(row['name'])} (${str(row['id'])})${status === '' ? '' : ` — ${status}`}`
        })
        return reply(`Zones on the Cloudflare account:\n${lines.join('\n')}`)
      },
      presentCall: () => ({ card: 'generic', title: 'List account zones', kind: 'other', rawInput: '' }),
    }),

    defineTool({
      name: 'cloudflare_zone_add',
      description: 'Add a domain to the Cloudflare account and report the nameservers it was assigned. This does NOT finish the move: the domain stays pending until its nameservers are changed at the registrar, which is done outside Cloudflare. Needs an account id and an account token in settings.',
      parameters: {
        domain: { type: 'string', required: true, description: 'The apex domain to add, for example example.com — not a subdomain and not a URL.' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: async (args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const domain = args.domain.trim().toLowerCase().replace(/^https?:\/\//u, '').replace(/\/.*$/u, '')
        // An apex, not a host under one: Cloudflare takes a zone, and adding
        // "app.example.com" quietly creates a separate zone that will never
        // receive traffic while example.com is delegated elsewhere.
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/u.test(domain)) {
          throw new Error(`${JSON.stringify(args.domain)} is not a domain name. Pass an apex domain such as example.com.`)
        }
        const { id, credential } = resolveAccount(readAccount())
        const created = await callAccount(credential, '/zones', { method: 'POST', body: { name: domain, account: { id } } })
        const row = (typeof created === 'object' && created !== null ? created : {}) as Json
        const servers = Array.isArray(row['name_servers'])
          ? (row['name_servers'] as unknown[]).map(value => str(value)).filter(value => value !== '')
          : []
        const zoneId = str(row['id'])
        const lines = [
          `Added ${domain} to the Cloudflare account. Zone id: ${zoneId === '' ? '(not reported)' : zoneId}`,
          `Status: ${str(row['status']) || 'pending'}.`,
        ]
        if (servers.length > 0) {
          lines.push('', 'Set these nameservers at the registrar — until that is done the zone stays pending and Cloudflare serves nothing for it:')
          for (const server of servers) lines.push(`  ${server}`)
        }
        lines.push('', `To manage DNS on it from here, add it under Settings → cloudflare with zoneId ${zoneId === '' ? '(above)' : zoneId} and a token scoped to it.`)
        return reply(lines.join('\n'))
      },
      presentCall: args => ({ card: 'generic', title: `Add ${args.domain} to Cloudflare`, kind: 'other', rawInput: args.domain }),
    }),

    defineTool({
      name: 'cloudflare_zone_status',
      description: 'Report whether a domain on the account is active or still pending its nameserver change at the registrar, and which nameservers it expects. Needs an account id and an account token in settings.',
      parameters: {
        domain: { type: 'string', required: true, description: 'The apex domain to check, for example example.com.' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: async (args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const domain = args.domain.trim().toLowerCase()
        const { id, credential } = resolveAccount(readAccount())
        const query = new URLSearchParams({ 'account.id': id, name: domain })
        const found = rows(await callAccount(credential, `/zones?${query.toString()}`))
        const row = found[0]
        if (row === undefined) {
          throw new Error(`No zone named ${domain} on this Cloudflare account. Add it with cloudflare_zone_add, or check the spelling.`)
        }
        const status = str(row['status']) || 'unknown'
        const servers = Array.isArray(row['name_servers'])
          ? (row['name_servers'] as unknown[]).map(value => str(value)).filter(value => value !== '')
          : []
        const lines = [`${domain} is ${status} (zone id ${str(row['id'])}).`]
        if (status !== 'active' && servers.length > 0) {
          lines.push('', 'It is waiting on the registrar to point at:')
          for (const server of servers) lines.push(`  ${server}`)
        }
        return reply(lines.join('\n'))
      },
      presentCall: args => ({ card: 'generic', title: `Check ${args.domain}`, kind: 'other', rawInput: args.domain }),
    }),

    defineTool({
      name: 'cloudflare_cache_status',
      description: 'Fetch one absolute URL\'s response headers and report whether an edge is serving it from cache: cf-cache-status, age, etag, last-modified and content-length. Needs no zone and no token. Use it to tell a stale edge from a wrong origin before purging anything, and again afterwards to confirm the purge took.',
      parameters: {
        url: { type: 'string', required: true, description: 'The absolute public URL to check, for example https://example.com/assets/app.js.' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: async (args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const url = await requirePublicUrl(args.url)
        const controller = new AbortController()
        const timer = setTimeout(() => { controller.abort() }, config.timeoutMs)
        try {
          const response = await fetch(url, {
            method: 'HEAD',
            // Unfollowed, so a redirect cannot carry the request to a host the
            // resolution check above never saw.
            redirect: 'manual',
            signal: controller.signal,
          })
          const header = (key: string): string => response.headers.get(key) ?? '(absent)'
          const lines = [
            `HTTP ${String(response.status)} for ${url.toString()}`,
            `cf-cache-status: ${header('cf-cache-status')}`,
            `age: ${header('age')}`,
            `etag: ${header('etag')}`,
            `last-modified: ${header('last-modified')}`,
            `content-length: ${header('content-length')}`,
          ]
          return reply(lines.join('\n'))
        } catch (error) {
          if (controller.signal.aborted) throw new Error(`${url.toString()} did not answer within ${String(config.timeoutMs)}ms`)
          throw error instanceof Error ? error : new Error(String(error))
        } finally {
          clearTimeout(timer)
        }
      },
      presentCall: args => ({ card: 'generic', title: 'Check Cloudflare cache status', kind: 'other', rawInput: args.url }),
    }),
  ]
}

/**
 * Answer one MCP command request: the catalogue on GET, one tool call on POST.
 * @param req - the request, carrying the token.
 * @param res - the response to complete.
 * @param tools - the built tool definitions.
 * @param token - the shared secret the route requires.
 */
async function handleCommand(req: IncomingMessage, res: ServerResponse, tools: ToolDefinition[], token: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  const header = req.headers.authorization ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : url.searchParams.get('token') ?? ''
  if (token === '' || !secretEquals(presented, token)) {
    res.writeHead(404)
    res.end()
    return
  }
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ tools: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }))
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Allow': 'GET, POST' })
    res.end()
    return
  }
  const body = await readBody(req, MAX_COMMAND_BODY_BYTES)
  if (body === undefined) {
    res.writeHead(413, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'the command body is too large' }))
    return
  }
  let request: { name?: unknown; args?: unknown }
  try {
    request = JSON.parse(body) as typeof request
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'the command body is not JSON' }))
    return
  }
  const tool = tools.find(t => t.name === request.name)
  if (tool === undefined) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `no such tool: ${String(request.name)}` }))
    return
  }
  try {
    const args = (typeof request.args === 'object' && request.args !== null ? request.args : {}) as Record<string, unknown>
    const result = await tool.execute(args, { signal: new AbortController().signal } as ToolRunContext)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ result }))
  } catch (error) {
    // The caller's failure — an unknown zone, an unset token, a refused purge —
    // is the answer.
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  }
}

/**
 * Mount the Cloudflare zone roster and tools.
 * @param ctx - the plugin context, injecting `settings`, `agents` and `webServer`.
 * @param config - validated composition config.
 */
export function apply(ctx: Context, config: Config): void {
  const scope = ctx.settings.register(NS, CONFIG_SCHEMA, { base: { zones: [] } })
  const readZones: ReadZones = () => scope.get().zones
  const readAccount: ReadAccount = () => scope.get().account

  // A token-guarded command route, so a CLI's MCP client (agy, opencode) can
  // reach the same tools a direct-provider agent gets natively. The token is
  // the route's whole authentication; an empty one leaves it unmounted.
  if (config.token !== '') {
    const routeTools = buildCloudflareTools(readZones, readAccount, config)
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${config.path}/command`,
      authenticate: false,
      handler: (req: IncomingMessage, res: ServerResponse) => handleCommand(req, res, routeTools, config.token),
    }), `cloudflare: ${config.path}/command`)
  }

  const installed = new Map<Agent, { dispose: () => Promise<void> }>()
  const install = (agent: Agent): void => {
    if (installed.has(agent)) return
    installed.set(agent, agent.ctx.inject(['tools'], (scope2) => {
      registerCloudflareTools(scope2, readZones, readAccount, config)
    }))
  }
  const remove = (agent: Agent): void => {
    const fiber = installed.get(agent)
    if (fiber === undefined) return
    installed.delete(agent)
    void fiber.dispose().catch(() => {
      // The agent is gone; its registry went with it.
    })
  }
  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => { remove(agent) })
}
