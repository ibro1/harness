/**
 * The credential record this package holds: reading it back from the credential
 * seam, writing it through the seam's one write path, and the local expiry
 * facts a target list is built from.
 *
 * Token lifetimes are the reason expiry is stored rather than discovered. A
 * long-lived user token lasts about sixty days; the Page tokens derived from it
 * do not expire on their own but stop working the moment it does. So the only
 * warning anyone gets is the one computed from `expires_in` at exchange time,
 * and it has to survive in the record to be worth anything.
 *
 * @module @deepseek-ai/dsh-social-meta/grant
 */

import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { MetaGrant } from './types.ts'

/** Milliseconds in one day, for the human-facing countdown. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Read this package's stored grant.
 *
 * The payload crosses a durable boundary, so it is checked rather than trusted:
 * a record written by a future format version, or hand-edited into something
 * without a token, reads as "not authorized" instead of failing later inside a
 * Graph call.
 * @param credentials - the credential seam.
 * @param key - this plugin's record key.
 * @returns the grant, or `undefined` when none is stored or the stored one is unusable.
 */
export async function readGrant(
  credentials: CredentialProvider,
  key: CredentialKey,
): Promise<MetaGrant | undefined> {
  const record = await credentials.readRecord(key)
  if (record?.kind !== 'grant') return undefined
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const candidate = payload as Record<string, unknown>
  const userToken = candidate['userToken']
  if (candidate['version'] !== 1 || typeof userToken !== 'string' || userToken === '') return undefined
  const expiresAt = candidate['expiresAt']
  const obtainedAt = candidate['obtainedAt']
  const grantedScopes = candidate['grantedScopes']
  return {
    version: 1,
    userToken,
    ...typeof expiresAt === 'number' ? { expiresAt } : {},
    obtainedAt: typeof obtainedAt === 'number' ? obtainedAt : 0,
    grantedScopes: Array.isArray(grantedScopes) ? grantedScopes.filter((scope): scope is string => typeof scope === 'string') : [],
  }
}

/**
 * Store this package's grant, replacing whatever was there.
 *
 * A fresh authorization replaces rather than merges: the new token's Pages,
 * scopes, and expiry all belong to that grant, and half of an old one beside
 * them would describe access nobody has.
 * @param credentials - the credential seam.
 * @param key - this plugin's record key.
 * @param grant - the grant to store.
 */
export async function writeGrant(
  credentials: CredentialProvider,
  key: CredentialKey,
  grant: MetaGrant,
): Promise<void> {
  await credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: grant }))
}

/** What the stored expiry says about a token right now. */
export interface GrantLifetime {
  /** Whether the user token has already lapsed, so no call is worth making. */
  expired: boolean
  /** Whole days left before it lapses; absent when Meta gave no expiry. */
  daysLeft?: number
  /** The sentence to show a human about this token's remaining life, when there is one worth showing. */
  notice?: string
}

/**
 * Describe a stored token's remaining life, locally.
 *
 * Locally is the point: the alternative is learning that a token died by making
 * a call that fails, which is both slower and only available at the moment
 * someone is trying to publish.
 * @param grant - the stored grant.
 * @param now - epoch milliseconds to judge against.
 * @param warnWithinDays - how long before expiry a ready target should start saying so.
 * @returns whether the token has lapsed, how long it has left, and the sentence to show.
 */
export function grantLifetime(grant: MetaGrant, now: number, warnWithinDays: number): GrantLifetime {
  const { expiresAt } = grant
  if (expiresAt === undefined) return { expired: false }
  const remaining = expiresAt - now
  const when = new Date(expiresAt).toISOString().slice(0, 10)
  if (remaining <= 0) {
    return {
      expired: true,
      daysLeft: 0,
      notice: `the Meta user token expired on ${when}; authorize this account again to restore access`,
    }
  }
  const daysLeft = Math.floor(remaining / DAY_MS)
  if (daysLeft > warnWithinDays) return { expired: false, daysLeft }
  return {
    expired: false,
    daysLeft,
    notice: `the Meta user token expires on ${when} (${String(daysLeft)} days left); authorize this account again before then`,
  }
}
