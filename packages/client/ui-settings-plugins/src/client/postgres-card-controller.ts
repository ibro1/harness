/** The Postgres card's staged form over the `postgres` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  CardForm, type CardActions, type CardFieldSpec, type CardFieldState, type CardShell,
} from './card-form.ts'

/**
 * Namespace of the Postgres capability. Spelled here rather than imported: a
 * client package must not depend on a Host package, and the plugin that owns it
 * spells the same value.
 */
export const POSTGRES_NS = 'postgres'

/** The Postgres fields this card edits. */
export interface PostgresSettings {
  /** The configured databases, edited as one JSON block. */
  databases?: unknown
}

/** What the Postgres card renders. */
export interface PostgresCardState extends CardShell {
  /** The databases list, staged as JSON text. */
  databases: CardFieldState
}

/** The registration-side face the Postgres card's slot entry injects. */
export interface PostgresCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as usePostgresCard. */
    postgresCard: SnapshotStore<PostgresCardState>
  }
}

/**
 * The `databases` field, edited as a JSON array of `{name}` plus a DSN.
 *
 * A row supplies its connection string one of two ways, and the plugin accepts
 * either: `dsnEnv` names an environment variable and keeps the DSN out of this
 * document, or `dsn` carries the connection string itself. The list round-trips
 * as text, so with `dsn` the credential is visible in the form — which is the
 * trade the field's own hint describes. Validate exactly what the host plugin
 * accepts: a form that demands the environment-variable form while the plugin
 * takes both leaves Save disabled with no way to find out why.
 *
 * `readOnly` and `statementTimeoutMs` are optional here because the host
 * defaults them (read-only, 15000ms); a row that omits them is valid and safe.
 * @returns the field spec.
 */
function databasesField(): CardFieldSpec {
  return {
    field: 'databases',
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
        if (typeof record['name'] !== 'string' || record['name'].trim() === '') return undefined
        // Either DSN form, but one of them, and non-empty: a row with neither
        // cannot connect and fails later at the query instead of here.
        const env = record['dsnEnv']
        const dsn = record['dsn']
        const hasEnv = typeof env === 'string' && env.trim() !== ''
        const hasDsn = typeof dsn === 'string' && dsn.trim() !== ''
        if (!hasEnv && !hasDsn) return undefined
        if (env !== undefined && typeof env !== 'string') return undefined
        if (dsn !== undefined && typeof dsn !== 'string') return undefined
        const readOnly = record['readOnly']
        if (readOnly !== undefined && typeof readOnly !== 'boolean') return undefined
        const timeout = record['statementTimeoutMs']
        if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)) return undefined
      }
      return { kind: 'set', value: parsed }
    },
  }
}

/** Bridges the `postgres` scope onto the card's staged form. */
export class PostgresCardController {
  private readonly form: CardForm<PostgresSettings>
  private readonly store: SnapshotStore<PostgresCardState>

  /** @param scope - the bound settings scope for the `postgres` namespace. */
  constructor(scope: SettingsScope<PostgresSettings>) {
    this.form = new CardForm(scope, [databasesField()])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): PostgresCardState {
    return {
      ...this.form.shell(),
      databases: this.form.field('databases'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): PostgresCardFace {
    return { hooks: { postgresCard: this.store }, ...this.form.actions() }
  }
}
