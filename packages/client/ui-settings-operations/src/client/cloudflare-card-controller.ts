/** The Cloudflare card's staged form over the `cloudflare` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Namespace of the Cloudflare capability. Spelled here rather than imported: a
 * client package must not depend on a Host package, and the plugin that owns it
 * spells the same value.
 */
export const CLOUDFLARE_NS = 'cloudflare'

/** The Cloudflare fields this card edits. */
export interface CloudflareSettings {
  /** The configured zones, edited as one JSON block. */
  zones?: unknown
  /** The optional account credentials, edited as one JSON block. */
  accounts?: unknown
}

/** What the Cloudflare card renders. */
export interface CloudflareCardState extends SettingsFormShell {
  /** The zones list, staged as JSON text. */
  zones: SettingsFieldState
  /** The account credentials, staged as JSON text. */
  accounts: SettingsFieldState
}

/** The registration-side face the Cloudflare card's slot entry injects. */
export interface CloudflareCardFace extends SettingsFormActions {
  hooks: {
    /** Card snapshot bound by the renderer as useCloudflareCard. */
    cloudflareCard: SnapshotStore<CloudflareCardState>
  }
}

/**
 * The `zones` field, edited as a JSON array of `{name, zoneId}` plus a token.
 *
 * A row supplies its token one of two ways, and the plugin accepts either:
 * `apiTokenEnv` names an environment variable and keeps the token out of this
 * document, or `apiToken` carries the token itself. The list round-trips as
 * text, so with `apiToken` the token is visible in the form — which is the
 * trade the field's own hint describes. A row with neither cannot
 * authenticate, so it is rejected here rather than at its first API call.
 * @returns the field spec.
 */
function zonesField(): SettingsFieldSpec {
  return {
    field: 'zones',
    format: value => JSON.stringify(Array.isArray(value) ? value : [], null, 2),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'set', value: [] }
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return undefined
      }
      if (!Array.isArray(parsed)) return undefined
      for (const row of parsed) {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined
        const record = row as Record<string, unknown>
        if (typeof record['name'] !== 'string' || typeof record['zoneId'] !== 'string') return undefined
        const env = record['apiTokenEnv']
        const token = record['apiToken']
        const hasEnv = typeof env === 'string' && env.trim() !== ''
        const hasToken = typeof token === 'string' && token.trim() !== ''
        if (!hasEnv && !hasToken) return undefined
        if (env !== undefined && typeof env !== 'string') return undefined
        if (token !== undefined && typeof token !== 'string') return undefined
      }
      return { kind: 'set', value: parsed }
    },
  }
}

/**
 * The `accounts` field, edited as a JSON array of `{name, id}` plus a token —
 * the same shape as `zones`, one entry per Cloudflare account.
 *
 * Separate from the zones because it is a different kind of credential, not a
 * bigger one. Creating a zone needs Zone → Zone → Edit across the account,
 * which reaches every domain on it, while a zone token reaches one — so the
 * narrow tokens stay narrow and this stays empty for anyone who never creates
 * a zone. Empty text clears it. A row with no token is rejected here, because
 * the alternative is discovering it at the first call as a Cloudflare 403.
 * @returns the field spec.
 */
function accountsField(): SettingsFieldSpec {
  return {
    field: 'accounts',
    format: value => (Array.isArray(value) && value.length > 0 ? JSON.stringify(value, null, 2) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return undefined
      }
      if (!Array.isArray(parsed)) return undefined
      for (const row of parsed) {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined
        const record = row as Record<string, unknown>
        if (typeof record['name'] !== 'string' || record['name'].trim() === '') return undefined
        if (typeof record['id'] !== 'string' || record['id'].trim() === '') return undefined
        const env = record['apiTokenEnv']
        const token = record['apiToken']
        const hasEnv = typeof env === 'string' && env.trim() !== ''
        const hasToken = typeof token === 'string' && token.trim() !== ''
        if (!hasEnv && !hasToken) return undefined
        if (env !== undefined && typeof env !== 'string') return undefined
        if (token !== undefined && typeof token !== 'string') return undefined
      }
      return { kind: 'set', value: parsed }
    },
  }
}

/** Bridges the `cloudflare` scope onto the card's staged form. */
export class CloudflareCardController {
  private readonly form: SettingsFormModel<CloudflareSettings>
  private readonly store: SnapshotStore<CloudflareCardState>

  /** @param scope - the bound settings scope for the `cloudflare` namespace. */
  constructor(scope: SettingsFormScope<CloudflareSettings>) {
    this.form = new SettingsFormModel(scope, [zonesField(), accountsField()])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): CloudflareCardState {
    return {
      ...this.form.shell(),
      zones: this.form.field('zones'),
      accounts: this.form.field('accounts'),
    }
  }

  /** Stop following the settings scope; the page is gone. */
  dispose(): void { this.form.dispose() }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): CloudflareCardFace {
    return { hooks: { cloudflareCard: this.store }, ...this.form.actions() }
  }
}
