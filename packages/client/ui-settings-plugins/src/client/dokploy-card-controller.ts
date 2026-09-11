/** The Dokploy card's staged form over the `dokploy` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  CardForm, type CardActions, type CardFieldSpec, type CardFieldState, type CardShell,
} from './card-form.ts'

/**
 * Namespace of the Dokploy capability. Spelled here rather than imported: a
 * client package must not depend on a Host package, and the plugin that owns it
 * spells the same value.
 */
export const DOKPLOY_NS = 'dokploy'

/** The Dokploy fields this card edits. */
export interface DokploySettings {
  /** The configured servers, edited as one JSON block. */
  servers?: unknown
}

/** What the Dokploy card renders. */
export interface DokployCardState extends CardShell {
  /** The servers list, staged as JSON text. */
  servers: CardFieldState
}

/** The registration-side face the Dokploy card's slot entry injects. */
export interface DokployCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useDokployCard. */
    dokployCard: SnapshotStore<DokployCardState>
  }
}

/**
 * The `servers` field, edited as a JSON array of `{name, url}` plus a key.
 *
 * A row supplies its key one of two ways, and the plugin accepts either:
 * `apiKeyEnv` names an environment variable and keeps the key out of this
 * document, or `apiKey` carries the key itself. The list round-trips as text,
 * so with `apiKey` the key is visible in the form — which is the trade the
 * field's own hint describes.
 *
 * This used to require `apiKeyEnv` on every row and reject anything else. The
 * host plugin has always treated both as optional and preferred whichever is
 * present, and the placeholder this very field shows uses `apiKey` — so typing
 * exactly what the form suggested left Save disabled with no way to find out
 * why. Validate what the backend accepts, not a stricter shape.
 * @returns the field spec.
 */
function serversField(): CardFieldSpec {
  return {
    field: 'servers',
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
        if (typeof record['name'] !== 'string' || typeof record['url'] !== 'string') return undefined
        // Either key form, but one of them, and non-empty: a row with neither
        // cannot authenticate and fails later at the request instead of here.
        const env = record['apiKeyEnv']
        const key = record['apiKey']
        const hasEnv = typeof env === 'string' && env.trim() !== ''
        const hasKey = typeof key === 'string' && key.trim() !== ''
        if (!hasEnv && !hasKey) return undefined
        if (env !== undefined && typeof env !== 'string') return undefined
        if (key !== undefined && typeof key !== 'string') return undefined
      }
      return { kind: 'set', value: parsed }
    },
  }
}

/** Bridges the `dokploy` scope onto the card's staged form. */
export class DokployCardController {
  private readonly form: CardForm<DokploySettings>
  private readonly store: SnapshotStore<DokployCardState>

  /** @param scope - the bound settings scope for the `dokploy` namespace. */
  constructor(scope: SettingsScope<DokploySettings>) {
    this.form = new CardForm(scope, [serversField()])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): DokployCardState {
    return {
      ...this.form.shell(),
      servers: this.form.field('servers'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): DokployCardFace {
    return { hooks: { dokployCard: this.store }, ...this.form.actions() }
  }
}
