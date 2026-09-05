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
 * The `servers` field, edited as a JSON array of `{name, url, apiKeyEnv}`. The
 * whole list round-trips as text because no field is secret — the API key lives
 * in the environment variable each entry names, never in this document — so
 * there is nothing to redact and the text is exactly what is stored.
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
        if (typeof record['name'] !== 'string' || typeof record['url'] !== 'string' || typeof record['apiKeyEnv'] !== 'string') {
          return undefined
        }
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
