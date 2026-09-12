/**
 * Address screening for the URL a model hands `capture_page`.
 *
 * The harness runs its own web server, the browser bridge, and several CLI
 * bridges on loopback, and container networks put unauthenticated services on
 * RFC1918 addresses. A screenshot tool that can reach those is a
 * credential-reading tool: it renders the page and hands the picture back. So
 * the hostname is resolved first and every address it resolves to is screened,
 * which is why `http://elsewhere.example` pointing at `127.0.0.1` is refused
 * even though the string looks public.
 *
 * @module @deepseek-ai/dsh-host-capture/src/ssrf
 */

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

/** One address a hostname resolved to. */
export interface ResolvedAddress {
  /** The numeric address, in IPv4 dotted-quad or IPv6 hexadecimal form. */
  address: string
  /** Address family, 4 or 6. */
  family: number
}

/**
 * Hostname resolver used before a capture. Tests substitute one so a name can
 * be made to resolve to loopback without owning a domain.
 * @param hostname - the name to resolve.
 * @returns every address the name resolves to.
 */
export type HostLookup = (hostname: string) => Promise<ResolvedAddress[]>

/** The system resolver, which reads `/etc/hosts` the same way Chromium does. */
export const systemLookup: HostLookup = async (hostname: string): Promise<ResolvedAddress[]> => {
  const entries = await lookup(hostname, { all: true, order: 'verbatim' })
  return entries.map(entry => ({ address: entry.address, family: entry.family }))
}

/** A screened URL, with the addresses it resolved to at screening time. */
export interface ScreenedUrl {
  /** The parsed URL, normalized by `URL`. */
  url: URL
  /**
   * Every address the hostname resolved to, all of them screened. The first is
   * pinned into Chromium's resolver so the browser cannot be handed a
   * different answer than the one screened here.
   */
  addresses: string[]
  /** True when the URL named a numeric address directly, so nothing was resolved. */
  literal: boolean
}

/** Raised when a URL is refused; the message names the reason for the model. */
export class BlockedUrlError extends Error {
  /**
   * @param message - what was refused and why.
   */
  constructor(message: string) {
    super(message)
    this.name = 'BlockedUrlError'
  }
}

/** Parse a dotted-quad into its four octets, or undefined when it is not one. */
function ipv4Octets(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined
  return address.split('.').map(part => Number(part))
}

/**
 * Name the reason an IPv4 address is not publicly routable.
 * @param address - a dotted-quad address.
 * @returns the reason to refuse it, or undefined when it is routable.
 */
function refuseIpv4(address: string): string | undefined {
  const octets = ipv4Octets(address)
  if (octets === undefined) return `${address} is not a valid IPv4 address`
  const [a = 0, b = 0, c = 0] = octets
  if (a === 0) return 'the unspecified "this network" range 0.0.0.0/8'
  if (a === 10) return 'the private range 10.0.0.0/8'
  if (a === 127) return 'the loopback range 127.0.0.0/8'
  if (a === 100 && b >= 64 && b <= 127) return 'the carrier-grade NAT range 100.64.0.0/10'
  if (a === 169 && b === 254) return 'the link-local range 169.254.0.0/16, which carries cloud instance metadata'
  if (a === 172 && b >= 16 && b <= 31) return 'the private range 172.16.0.0/12'
  if (a === 192 && b === 168) return 'the private range 192.168.0.0/16'
  if (a === 192 && b === 0 && c === 0) return 'the IETF protocol assignment range 192.0.0.0/24'
  if (a === 192 && b === 0 && c === 2) return 'the documentation range 192.0.2.0/24'
  if (a === 198 && (b === 18 || b === 19)) return 'the benchmarking range 198.18.0.0/15'
  if (a === 198 && b === 51 && c === 100) return 'the documentation range 198.51.100.0/24'
  if (a === 203 && b === 0 && c === 113) return 'the documentation range 203.0.113.0/24'
  if (a >= 224 && a <= 239) return 'the multicast range 224.0.0.0/4'
  if (a >= 240) return 'the reserved range 240.0.0.0/4'
  return undefined
}

/**
 * Expand an IPv6 address into its eight 16-bit groups.
 * @param address - an IPv6 address, possibly compressed and possibly ending in
 * a dotted quad.
 * @returns the eight groups, or undefined when the address does not parse.
 */
function ipv6Groups(address: string): number[] | undefined {
  if (isIP(address) !== 6) return undefined
  let text = address
  // A trailing dotted quad (::ffff:127.0.0.1) becomes two hexadecimal groups so
  // the rest of the function only ever sees 16-bit words.
  const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(text)
  if (dotted !== null) {
    const quad = dotted[1] as string
    const octets = ipv4Octets(quad)
    if (octets === undefined) return undefined
    const [a = 0, b = 0, c = 0, d = 0] = octets
    const high = ((a << 8) | b).toString(16)
    const low = ((c << 8) | d).toString(16)
    text = `${text.slice(0, dotted.index)}:${high}:${low}`
  }
  const [head, tail, ...rest] = text.split('::')
  if (rest.length > 0) return undefined
  const parse = (part: string | undefined): number[] =>
    part === undefined || part === '' ? [] : part.split(':').map(group => Number.parseInt(group, 16))
  const left = parse(head)
  const right = parse(tail)
  if (tail === undefined) return left.length === 8 ? left : undefined
  const filler = 8 - left.length - right.length
  if (filler < 0) return undefined
  return [...left, ...Array.from({ length: filler }, () => 0), ...right]
}

/** Render four octets carried inside an IPv6 address as a dotted quad. */
function embeddedIpv4(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

/**
 * Name the reason an IPv6 address is not publicly routable, following every
 * IPv4-carrying form back to the IPv4 rules — an IPv4-mapped `::ffff:127.0.0.1`
 * is loopback however it is spelled.
 * @param address - an IPv6 address.
 * @returns the reason to refuse it, or undefined when it is routable.
 */
function refuseIpv6(address: string): string | undefined {
  const groups = ipv6Groups(address)
  if (groups === undefined) return `${address} is not a valid IPv6 address`
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups
  const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0
  if (leadingZero && g5 === 0 && g6 === 0 && g7 === 0) return 'the unspecified address ::'
  if (leadingZero && g5 === 0 && g6 === 0 && g7 === 1) return 'the loopback address ::1'
  if (leadingZero && g5 === 0xffff) {
    const mapped = embeddedIpv4(g6, g7)
    const reason = refuseIpv4(mapped)
    return reason === undefined ? undefined : `the IPv4-mapped form of ${mapped}, in ${reason}`
  }
  if (leadingZero && g5 === 0) {
    const compat = embeddedIpv4(g6, g7)
    const reason = refuseIpv4(compat)
    return reason === undefined ? undefined : `the IPv4-compatible form of ${compat}, in ${reason}`
  }
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    const nat64 = embeddedIpv4(g6, g7)
    const reason = refuseIpv4(nat64)
    return reason === undefined ? undefined : `the NAT64 form of ${nat64}, in ${reason}`
  }
  if (g0 === 0x2002) {
    const sixToFour = embeddedIpv4(g1, g2)
    const reason = refuseIpv4(sixToFour)
    return reason === undefined ? undefined : `the 6to4 form of ${sixToFour}, in ${reason}`
  }
  if ((g0 & 0xfe00) === 0xfc00) return 'the unique-local range fc00::/7'
  if ((g0 & 0xffc0) === 0xfe80) return 'the link-local range fe80::/10'
  if ((g0 & 0xff00) === 0xff00) return 'the multicast range ff00::/8'
  return undefined
}

/**
 * Name the reason one resolved address must not be captured.
 * @param address - an IPv4 or IPv6 address.
 * @returns the reason to refuse it, or undefined when it is publicly routable.
 */
export function refuseAddress(address: string): string | undefined {
  const family = isIP(address)
  if (family === 4) return refuseIpv4(address)
  if (family === 6) return refuseIpv6(address)
  return `${address} is not a numeric address`
}

/**
 * Screen a model-supplied URL before any browser is launched: the scheme, the
 * absence of embedded credentials, and every address the hostname resolves to.
 *
 * Resolution happens here and the answer is pinned into the browser's resolver
 * by the caller, so a name that answers differently on a second lookup cannot
 * move the capture to a private address after this check passed.
 *
 * @param raw - the URL exactly as the model wrote it.
 * @param hostLookup - resolver to screen against; defaults to the system one.
 * @returns the parsed URL and the screened addresses.
 * @throws BlockedUrlError when the URL does not parse, uses a scheme other than
 * http/https, carries credentials, or resolves to any non-public address.
 */
export async function screenUrl(raw: string, hostLookup: HostLookup = systemLookup): Promise<ScreenedUrl> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BlockedUrlError(`capture_page: ${JSON.stringify(raw)} is not an absolute URL; pass a full http:// or https:// address.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`capture_page refuses the ${url.protocol} scheme; only http and https are allowed.`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new BlockedUrlError('capture_page refuses a URL carrying credentials; remove the user:password@ part.')
  }
  // URL keeps an IPv6 literal in brackets; the address checks want it bare.
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname
  if (hostname === '') {
    throw new BlockedUrlError(`capture_page: ${JSON.stringify(raw)} has no hostname.`)
  }
  if (isIP(hostname) !== 0) {
    const reason = refuseAddress(hostname)
    if (reason !== undefined) {
      throw new BlockedUrlError(`capture_page refuses ${hostname}: it is in ${reason}. This tool only reaches public addresses.`)
    }
    return { url, addresses: [hostname], literal: true }
  }
  let resolved: ResolvedAddress[]
  try {
    resolved = await hostLookup(hostname)
  } catch (error) {
    throw new BlockedUrlError(`capture_page could not resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (resolved.length === 0) {
    throw new BlockedUrlError(`capture_page could not resolve ${hostname} to any address.`)
  }
  for (const entry of resolved) {
    const reason = refuseAddress(entry.address)
    if (reason !== undefined) {
      throw new BlockedUrlError(`capture_page refuses ${hostname}: it resolves to ${entry.address}, in ${reason}. This tool only reaches public addresses.`)
    }
  }
  return { url, addresses: resolved.map(entry => entry.address), literal: false }
}
