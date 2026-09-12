/**
 * Postgres access for the harness: a settings-configured roster of databases,
 * and the agent tools that read from them — read-only unless an entry says
 * otherwise.
 *
 * An agent that can deploy an app, read its logs and edit its code still cannot
 * answer "how many rows are in that table" or "why is that job stuck".
 * Repeatedly the answer has been a SQL statement handed to a human to paste into
 * a terminal. This plugin closes that gap without handing the model a connection
 * string: databases live in the `postgres` user-settings namespace, the model
 * picks one by its short name, and the DSN never appears in a tool argument or
 * in any tool output.
 *
 * Read-only is enforced by the server, not by inspecting the statement. Every
 * `postgres_query` runs inside `BEGIN READ ONLY` … `ROLLBACK`, so a write fails
 * in the backend. A statement allowlist parsed in JavaScript would be defeated
 * by a CTE carrying a `DELETE`, so none is used.
 *
 * @module @deepseek-ai/dsh-host-postgres
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** The settings namespace holding the database roster. */
const NS = 'postgres'

/** One configured database, as stored in settings. */
export interface PostgresDatabase {
  /** The short label the model uses to pick this database. */
  name: string
  /** Name of the environment variable holding this database's DSN (preferred). */
  dsnEnv?: string
  /** The connection string inline — simpler, but stored in settings and shown in the card. */
  dsn?: string
  /** Whether tools may only read from this database. Absent means read-only. */
  readOnly?: boolean
  /** Server-side `statement_timeout` for this database's statements. Absent means {@link DEFAULT_STATEMENT_TIMEOUT_MS}. */
  statementTimeoutMs?: number
}

/** The resolved `postgres` settings section. */
export interface PostgresSettings {
  databases: PostgresDatabase[]
}

/** Server-side statement timeout applied when an entry does not choose one. */
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000

/** Schema for the settings namespace; a DSN is a credential, so `dsnEnv` is the documented preference. */
const CONFIG_SCHEMA: z<PostgresSettings> = z.object({
  databases: z.array(z.object({
    name: z.string().required().description('A short label you choose for this database, used when asking a tool to act on it.'),
    dsnEnv: z.string().description('Preferred: name of the environment variable holding this database connection string (e.g. PG_DSN_MAIN), so the DSN stays out of settings. Requires that variable to be set on the harness.'),
    dsn: z.string().description('Alternative to dsnEnv: the connection string itself, for example postgres://user:pass@host:5432/db. Simpler, but it is stored here in settings and shown in this form.'),
    readOnly: z.boolean().default(true).description('Leave on so tools may only read. Turn it off to let postgres_execute write to, and delete from, this database.'),
    statementTimeoutMs: z.natural().min(100).default(DEFAULT_STATEMENT_TIMEOUT_MS).description('Server-side statement timeout, so a careless query cannot hold a connection open.'),
  })).default([]).description('Postgres databases this harness may query. Give each database either dsnEnv or dsn.'),
})

/** The plugin name, for the Loader. */
export const name = 'postgres'

/** The services this plugin reads. */
export const inject = ['settings', 'agents', 'webServer']

/** Composition config; the roster lives in settings, so nothing is required here. */
export interface Config {
  /** Most rows one query renders into the model's context, however many matched. */
  maxRows: number
  /** Byte budget for one query's rendered table, so a wide result cannot flood the context. */
  maxOutputBytes: number
  /** Absolute path of the token-guarded command route MCP clients reach. */
  path: string
  /** Shared secret the command route requires; empty leaves the route unmounted. */
  token: string
}

/** Composition config; the roster lives in settings, so nothing is required here. */
export const Config: z<Config> = z.object({
  maxRows: z.natural().min(1).max(1000).default(200),
  maxOutputBytes: z.natural().min(1024).default(64_000),
  path: z.string().default('/postgres'),
  token: z.string().default(''),
})

/** Largest command body accepted on the MCP route. */
const MAX_COMMAND_BODY_BYTES = 64 * 1024

/** Longest a single rendered cell may be before it is elided, so one wide column cannot own the table. */
const MAX_CELL_CHARS = 200

// ---------------------------------------------------------------------------
// Driver seam
// ---------------------------------------------------------------------------

/**
 * One result set as the driver returns it: the rows, plus the column order and
 * the affected-row count the protocol reports. `postgres` (porsager/postgres)
 * decorates its row array with exactly these, and the tests stand in for it.
 */
export interface SqlRows extends Array<Record<string, unknown>> {
  /** Columns in the order the server sent them; absent for a statement that returned none. */
  columns?: readonly { name: string }[]
  /** Rows the command affected, as reported in the command tag. */
  count?: number
}

/**
 * One reserved connection. Every statement this plugin issues goes through
 * `unsafe`, because the statements are composed here rather than tagged, and
 * the transaction control around them must land on this same connection.
 */
export interface SqlSession {
  /**
   * Run one statement on this connection.
   * @param statement - the SQL text, with `$1`-style placeholders for `parameters`.
   * @param parameters - values bound to the placeholders.
   * @returns the result set.
   * @throws whatever the server reported, including a statement timeout.
   */
  unsafe(statement: string, parameters?: readonly unknown[]): Promise<SqlRows>
  /**
   * Run one statement and stop reading once `limit` rows have arrived.
   *
   * Optional because the seam is also implemented by test doubles. Where a
   * driver provides it, it is strongly preferred for reads: without it, the
   * row cap is applied after every matching row has already crossed the wire,
   * so `select * from a big table` costs the harness the whole table in memory
   * to print two hundred lines of it. An arbitrary statement cannot be wrapped
   * in `LIMIT` without changing what it means — `explain`, a set-returning
   * call, several statements in one string — so the limit belongs in the
   * fetch, not in the SQL.
   * @param statement - the SQL text.
   * @param limit - stop after this many rows have been collected.
   * @param parameters - values bound to the statement's placeholders.
   * @returns the rows read, never more than `limit`.
   */
  stream?(statement: string, limit: number, parameters?: readonly unknown[]): Promise<SqlRows>
  /** Return this connection to the pool. */
  release(): void
}

/** One database's connection pool. */
export interface SqlPool {
  /**
   * Take a connection out of the pool for a sequence of statements.
   * @returns the reserved connection, which the caller releases.
   * @throws when the pool cannot connect.
   */
  reserve(): Promise<SqlSession>
  /**
   * Close every connection this pool holds.
   * @returns when the pool is closed.
   */
  end(): Promise<void>
}

/**
 * Builds a pool for one DSN. The seam exists so tests drive the tools without a
 * server; {@link createDriverPool} is the only implementation that speaks to a
 * real Postgres.
 */
export type SqlPoolFactory = (dsn: string) => SqlPool

/** The part of the `postgres` package this plugin calls, named locally so its types are not load-bearing. */
interface DriverFactory {
  (dsn: string, options: Record<string, unknown>): {
    reserve(): Promise<{
      unsafe(statement: string, parameters?: readonly unknown[]): {
        then(onfulfilled: (rows: SqlRows) => unknown): Promise<unknown>
        cursor(rows: number, handler: (batch: SqlRows) => void | Promise<void>): Promise<void>
      }
      release(): void
    }>
    end(options: Record<string, unknown>): Promise<void>
  }
}

/**
 * Thrown to stop a cursor once enough rows are in hand.
 *
 * Not a failure: it is how the driver is told the caller is done, and it never
 * escapes {@link createDriverPool}.
 */
class EnoughRows extends Error {
  constructor() {
    super('enough rows')
    this.name = 'EnoughRows'
  }
}

/**
 * Build a pool backed by the `postgres` driver, loaded on first use.
 *
 * The import is deferred so that mounting the plugin — or listing the
 * configured databases — costs nothing and works even where the driver is not
 * reachable; only an actual statement pays for it.
 * @param dsn - the resolved connection string.
 * @returns the pool.
 */
export function createDriverPool(dsn: string): SqlPool {
  let driver: Promise<ReturnType<DriverFactory>> | undefined
  const load = (): Promise<ReturnType<DriverFactory>> => {
    driver ??= import('postgres')
      .then(module => ((module as unknown as { default: DriverFactory }).default)(dsn, {
        max: 4,
        // A NOTICE is not this plugin's output; the model reads rows.
        onnotice: () => {},
      }))
      .catch((error: unknown) => {
        // Do not cache the failure: a transient resolution error should not
        // poison every later call on this database.
        driver = undefined
        throw error instanceof Error ? error : new Error(String(error))
      })
    return driver
  }
  return {
    async reserve(): Promise<SqlSession> {
      const sql = await load()
      const reserved = await sql.reserve()
      return {
        unsafe: async (statement, parameters) => await reserved.unsafe(statement, parameters),
        /**
         * `cursor(n, …)` fetches in batches and stops when the handler throws,
         * so the server is told to stop sending rather than the rows being
         * counted after they have all arrived. `EnoughRows` is an Error rather
         * than a sentinel value because it travels out through the driver's own
         * error path, and anything that is not it is rethrown unchanged.
         */
        stream: async (statement, limit, parameters) => {
          const collected: unknown[] = []
          try {
            await reserved.unsafe(statement, parameters).cursor(Math.max(1, Math.min(limit, 500)), (batch) => {
              for (const row of batch) {
                collected.push(row)
                if (collected.length >= limit) throw new EnoughRows()
              }
            })
          } catch (error) {
            if (!(error instanceof EnoughRows)) throw error instanceof Error ? error : new Error(String(error))
          }
          return collected as SqlRows
        },
        release: () => { reserved.release() },
      }
    },
    async end(): Promise<void> {
      if (driver === undefined) return
      const sql = await driver
      await sql.end({ timeout: 5 })
    },
  }
}

// ---------------------------------------------------------------------------
// Roster resolution
// ---------------------------------------------------------------------------

/**
 * Table sizes without a scan.
 *
 * `reltuples` is the planner's estimate and is -1 on a table that has never
 * been analysed, which is reported as unknown rather than as zero; `count(*)`
 * on every table in a schema is not a thing to do to answer "what is in here".
 */
const TABLE_LISTING_SQL = `select c.relname as table,
       case when c.reltuples < 0 then null else c.reltuples::bigint end as row_estimate,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total_size
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = $1 and c.relkind in ('r', 'p')
 order by c.relname`

/** Read the database roster live from settings each call, so edits take effect at once. */
export type ReadDatabases = () => readonly PostgresDatabase[]

/** One roster entry with every default applied and its DSN resolved. */
export interface ResolvedDatabase {
  /** The configured label. */
  name: string
  /** The connection string, from the environment or from settings. */
  dsn: string
  /** Whether tools may only read from this database. */
  readOnly: boolean
  /** Server-side statement timeout in milliseconds. */
  statementTimeoutMs: number
}

/**
 * Resolve a database by name, or explain which names exist.
 * @param databases - the current roster.
 * @param requested - the name the model asked for, if any.
 * @returns the matched entry, still unresolved.
 * @throws when none are configured, the name is unknown, or several exist and
 * the caller named none — never guessing, since reading the wrong database
 * answers a question nobody asked.
 */
export function selectDatabase(databases: readonly PostgresDatabase[], requested: string | undefined): PostgresDatabase {
  if (databases.length === 0) {
    throw new Error('No Postgres databases are configured; add one under Settings → postgres.')
  }
  if (requested !== undefined && requested !== '') {
    const match = databases.find(database => database.name === requested)
    if (match === undefined) {
      throw new Error(`No Postgres database named ${JSON.stringify(requested)}; configured: ${databases.map(d => d.name).join(', ')}.`)
    }
    return match
  }
  if (databases.length > 1) {
    throw new Error(`Several Postgres databases are configured (${databases.map(d => d.name).join(', ')}); pass database to choose one.`)
  }
  return databases[0] as PostgresDatabase
}

/**
 * Apply the roster entry's defaults and resolve its DSN.
 *
 * Defaulting happens here rather than at each use, so the answer to "is this
 * read-only" has one home: an entry that says nothing is read-only, which is
 * the safe reading of an incomplete configuration.
 * @param database - the matched roster entry.
 * @returns the entry with its DSN, read-only flag and timeout settled.
 * @throws when neither `dsnEnv` nor `dsn` yields a connection string.
 */
export function resolveDatabase(database: PostgresDatabase): ResolvedDatabase {
  const fromEnv = database.dsnEnv !== undefined && database.dsnEnv !== ''
    ? process.env[database.dsnEnv]?.trim()
    : undefined
  const inline = database.dsn !== undefined && database.dsn.trim() !== '' ? database.dsn.trim() : undefined
  const dsn = fromEnv ?? inline
  if (dsn === undefined || dsn === '') {
    const hint = database.dsnEnv !== undefined && database.dsnEnv !== ''
      ? `set the ${database.dsnEnv} environment variable, or put the connection string in this database's dsn field`
      : 'give this database a dsn, or a dsnEnv naming a set environment variable'
    throw new Error(`Postgres ${database.name} has no connection string: ${hint}.`)
  }
  return {
    name: database.name,
    dsn,
    readOnly: database.readOnly !== false,
    statementTimeoutMs: database.statementTimeoutMs === undefined || database.statementTimeoutMs <= 0
      ? DEFAULT_STATEMENT_TIMEOUT_MS
      : Math.trunc(database.statementTimeoutMs),
  }
}

/**
 * One pool per configured database, kept across calls.
 *
 * Opening a connection per tool call would pay the TLS and authentication cost
 * every time; holding a pool forever would keep a stale one after the DSN is
 * edited. So a pool is keyed by name and replaced — the old one ended — as soon
 * as that name's DSN changes.
 */
export class PoolRegistry {
  private readonly pools = new Map<string, { dsn: string; pool: SqlPool }>()

  /** @param factory - builds a pool for one DSN. */
  constructor(private readonly factory: SqlPoolFactory) {}

  /**
   * The pool for one resolved database, created on first use.
   * @param database - the resolved entry, carrying the current DSN.
   * @returns the pool for that database.
   */
  acquire(database: ResolvedDatabase): SqlPool {
    const existing = this.pools.get(database.name)
    if (existing !== undefined) {
      if (existing.dsn === database.dsn) return existing.pool
      this.pools.delete(database.name)
      void existing.pool.end().catch(() => {
        // The DSN changed under us; the replaced pool's connections are already
        // pointed at a server nobody will ask for again.
      })
    }
    const pool = this.factory(database.dsn)
    this.pools.set(database.name, { dsn: database.dsn, pool })
    return pool
  }

  /**
   * Close every pool, for the plugin's teardown.
   * @returns when every pool has been asked to close.
   */
  async dispose(): Promise<void> {
    const open = [...this.pools.values()]
    this.pools.clear()
    await Promise.all(open.map(entry => entry.pool.end().catch(() => {
      // Teardown: a pool that cannot close cleanly must not block the others.
    })))
  }
}

// ---------------------------------------------------------------------------
// Statement execution
// ---------------------------------------------------------------------------

/**
 * Run one read-only statement inside its own aborted transaction.
 *
 * `BEGIN READ ONLY` makes the server reject every write in the statement,
 * including one hidden inside a CTE, and the closing `ROLLBACK` discards the
 * transaction whatever happened. `statement_timeout` is `SET LOCAL`, so it dies
 * with the transaction rather than leaking into the pooled connection.
 * @param pool - the database's pool.
 * @param statement - the SQL the model supplied, or one this plugin composed.
 * @param statementTimeoutMs - server-side timeout for this statement.
 * @param parameters - values bound to the statement's `$1`-style placeholders.
 * @param rowLimit - when set and the driver can stream, stop reading this many
 * rows past nothing — the caller passes its render cap plus one, so "there are
 * more" is knowable without dragging the rest of the table across the wire.
 * @returns the result set.
 * @throws whatever the server reported, including the read-only refusal.
 */
export async function runReadOnly(
  pool: SqlPool,
  statement: string,
  statementTimeoutMs: number,
  parameters?: readonly unknown[],
  rowLimit?: number,
): Promise<SqlRows> {
  const session = await pool.reserve()
  try {
    await session.unsafe('BEGIN READ ONLY')
    // A GUC value cannot be a bind parameter, so it is interpolated; the value
    // is an integer taken from settings, never from the model.
    await session.unsafe(`SET LOCAL statement_timeout = ${String(Math.trunc(statementTimeoutMs))}`)
    // One row past the cap, so the renderer can say "there are more" without a
    // second query and without reading the rest of the table to find out.
    const rows = rowLimit !== undefined && session.stream !== undefined
      ? await session.stream(statement, rowLimit + 1, parameters)
      : await session.unsafe(statement, parameters)
    await session.unsafe('ROLLBACK')
    return rows
  } catch (error) {
    await session.unsafe('ROLLBACK').catch(() => {
      // The connection is already in a failed or closed state; releasing it
      // below returns it to the pool, which resets it.
    })
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    session.release()
  }
}

/**
 * Run one writing statement and commit it.
 * @param pool - the database's pool.
 * @param statement - the SQL the model supplied.
 * @param statementTimeoutMs - server-side timeout for this statement.
 * @returns the result set, carrying the affected-row count.
 * @throws whatever the server reported; the transaction is rolled back first.
 */
export async function runWrite(pool: SqlPool, statement: string, statementTimeoutMs: number): Promise<SqlRows> {
  const session = await pool.reserve()
  try {
    await session.unsafe('BEGIN')
    await session.unsafe(`SET LOCAL statement_timeout = ${String(Math.trunc(statementTimeoutMs))}`)
    const rows = await session.unsafe(statement)
    await session.unsafe('COMMIT')
    return rows
  } catch (error) {
    await session.unsafe('ROLLBACK').catch(() => {
      // Already failed or closed; the pool resets the connection on release.
    })
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    session.release()
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render one value so `NULL` is distinguishable from an empty string.
 *
 * A SQL NULL prints as the literal `NULL`; an empty string prints as nothing,
 * which in an aligned table reads as an empty cell. Newlines are escaped so one
 * multi-line value cannot break the alignment of every row below it.
 * @param value - the driver's value for one cell.
 * @returns the cell text.
 */
export function renderCell(value: unknown): string {
  const text = ((): string => {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value)
    if (value instanceof Date) return value.toISOString()
    if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`
    // The two values `JSON.stringify` cannot represent, named before it is
    // asked. A driver does not hand these back as column values, but `unknown`
    // admits them and `String(value)` on an object would print
    // "[object Object]" — a cell that says nothing while looking like data.
    if (typeof value === 'function' || typeof value === 'symbol') return `(${typeof value})`
    return JSON.stringify(value)
  })().replace(/\r?\n/gu, '\\n').replace(/\t/gu, '\\t')
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text
}

/** Column names for a result set, from the driver's metadata or the first row. */
function columnNames(rows: SqlRows): string[] {
  const declared = rows.columns
  if (declared !== undefined && declared.length > 0) return declared.map(column => column.name)
  const first = rows[0]
  return first === undefined ? [] : Object.keys(first)
}

/**
 * Render a result set as an aligned text table, within the row and byte caps.
 *
 * Both caps exist for the same reason: a model that reads forty thousand rows
 * into its context has cost more than it learned. Whenever anything is left
 * out, the text says so and says how many rows actually matched, so the model
 * knows to narrow the query rather than believing it saw everything.
 * @param rows - the result set.
 * @param maxRows - most rows to render.
 * @param maxOutputBytes - byte budget for the rendered table.
 * @returns the table text, including any truncation note.
 */
export function renderRows(rows: SqlRows, maxRows: number, maxOutputBytes: number): string {
  const matched = rows.length
  if (matched === 0) return 'No rows.'
  const columns = columnNames(rows)
  if (columns.length === 0) return `${String(matched)} rows, no columns.`

  const capped = Math.min(matched, maxRows)
  const cells = rows.slice(0, capped).map(row => columns.map(column => renderCell(row[column])))
  const widths = columns.map((column, index) => Math.max(
    column.length,
    ...cells.map(line => (line[index] ?? '').length),
  ))
  const join = (values: readonly string[]): string =>
    values.map((value, index) => value.padEnd(widths[index] ?? 0)).join(' | ').trimEnd()

  const header = join(columns)
  const rule = widths.map(width => '-'.repeat(width)).join('-+-')
  const lines = [header, rule]
  let budget = maxOutputBytes - Buffer.byteLength(header) - Buffer.byteLength(rule)
  let rendered = 0
  for (const line of cells) {
    const text = join(line)
    const cost = Buffer.byteLength(text) + 1
    if (cost > budget) break
    budget -= cost
    lines.push(text)
    rendered += 1
  }

  if (rendered < matched) {
    lines.push('')
    lines.push(rendered < capped
      ? `Output truncated: showing ${String(rendered)} of ${String(matched)} matching rows, because the ${String(maxOutputBytes)}-byte output budget was reached. Select fewer columns, or add a LIMIT.`
      : `Output truncated: showing the first ${String(rendered)} of ${String(matched)} matching rows, because this tool renders at most ${String(maxRows)}. Add a LIMIT or an aggregate to see the rest.`)
  } else {
    lines.push('')
    lines.push(`(${String(matched)} ${matched === 1 ? 'row' : 'rows'})`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** The canonical output of every Postgres tool: text for the model to read. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      required: true,
      description: 'What the database reported, as text.',
    },
  },
} as const satisfies ValueSchemaSpec

/**
 * Register the Postgres tools on one agent's context.
 * @param ctx - the agent's context, carrying its tool registry.
 * @param readDatabases - live reader of the configured roster.
 * @param pools - the shared pool registry.
 * @param config - validated composition config.
 */
function registerPostgresTools(ctx: Context, readDatabases: ReadDatabases, pools: PoolRegistry, config: Config): void {
  for (const tool of buildPostgresTools(readDatabases, pools, config)) {
    ctx.effect(() => ctx.tools.register(tool), `postgres: ${tool.name}`)
  }
}

/**
 * Build the Postgres tools without registering them, so one definition serves
 * both the per-agent registry and the MCP command route.
 * @param readDatabases - live reader of the configured roster.
 * @param pools - the shared pool registry.
 * @param config - validated composition config, carrying the output caps.
 * @returns the tool definitions.
 */
export function buildPostgresTools(readDatabases: ReadDatabases, pools: PoolRegistry, config: Config): ToolDefinition[] {
  const databaseParameter = {
    type: 'string',
    description: 'Which configured database to act on, by its name. Omit when only one is configured; use postgres_databases to see the names.',
  } as const

  const reply = (text: string): { text: string } => ({ text })

  /** Resolve the named database and its pool in one step, since every tool but the roster listing needs both. */
  const target = (requested: string | undefined): { database: ResolvedDatabase; pool: SqlPool } => {
    const database = resolveDatabase(selectDatabase(readDatabases(), requested))
    return { database, pool: pools.acquire(database) }
  }

  return [
    defineTool({
      name: 'postgres_databases',
      description: 'List the Postgres databases this harness is configured to reach, by name, and whether each is read-only. Connection strings are never shown.',
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: (_args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const databases = readDatabases()
        // Only the name and the read-only flag: no host, no user, no password,
        // and no environment-variable name that would narrow a guess at one.
        const text = databases.length === 0
          ? 'No Postgres databases are configured. Add one under Settings → postgres.'
          : `Configured Postgres databases:\n${databases.map(d => `- ${d.name} (${d.readOnly === false ? 'writes allowed' : 'read-only'})`).join('\n')}`
        return Promise.resolve(reply(text))
      },
      presentCall: () => ({ card: 'generic', title: 'List Postgres databases', kind: 'other', rawInput: '' }),
    }),

    defineTool({
      name: 'postgres_query',
      description: 'Run one read-only SQL statement against a configured database and read the rows back as a table. The statement runs inside a read-only transaction that is rolled back, so it cannot change anything even if it tries. Results are capped; add a LIMIT or an aggregate for large tables.',
      parameters: {
        database: databaseParameter,
        statement: { type: 'string', required: true, description: 'The SQL to run, for example: select count(*) from orders where status = \'stuck\'.' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: async (args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const { database, pool } = target(args.database)
        const rows = await runReadOnly(pool, args.statement, database.statementTimeoutMs, undefined, config.maxRows)
        return reply(renderRows(rows, config.maxRows, config.maxOutputBytes))
      },
      presentCall: args => ({ card: 'generic', title: 'Query Postgres', kind: 'other', rawInput: args.statement }),
    }),

    defineTool({
      name: 'postgres_execute',
      description: 'Run one writing SQL statement (INSERT, UPDATE, DELETE, or DDL) against a configured database and commit it. This can destroy data permanently and there is no undo. It is refused unless that database is configured with readOnly set to false.',
      parameters: {
        database: databaseParameter,
        statement: { type: 'string', required: true, description: 'The SQL to run. It is committed if it succeeds.' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: async (args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const { database, pool } = target(args.database)
        if (database.readOnly) {
          throw new Error(`Postgres ${database.name} is read-only, so postgres_execute will not run. To allow writes, set readOnly to false on the ${JSON.stringify(database.name)} entry under Settings → postgres.`)
        }
        const rows = await runWrite(pool, args.statement, database.statementTimeoutMs)
        const affected = rows.count ?? rows.length
        const tail = rows.length > 0 ? `\n${renderRows(rows, config.maxRows, config.maxOutputBytes)}` : ''
        return reply(`Committed on ${database.name}: ${String(affected)} ${affected === 1 ? 'row' : 'rows'} affected.${tail}`)
      },
      presentCall: args => ({ card: 'generic', title: 'Write to Postgres', kind: 'other', rawInput: args.statement }),
    }),

    defineTool({
      name: 'postgres_tables',
      description: 'List the tables in one schema with an estimated row count for each, so you can find the table you want without scanning anything. The estimates come from the planner statistics and are approximate.',
      parameters: {
        database: databaseParameter,
        schema: { type: 'string', description: 'Schema to list; defaults to public.' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: async (args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const { database, pool } = target(args.database)
        const schema = args.schema === undefined || args.schema === '' ? 'public' : args.schema
        // reltuples, not count(*): the point of this tool is to orient the
        // model without reading a single heap page. A table that has never
        // been analyzed reports -1, rendered below as unknown.
        const rows = await runReadOnly(pool, TABLE_LISTING_SQL, database.statementTimeoutMs, [schema])
        if (rows.length === 0) return reply(`No tables in schema ${schema} on ${database.name}.`)
        return reply(`Tables in ${schema} on ${database.name} (row counts are estimates):\n${renderRows(rows, config.maxRows, config.maxOutputBytes)}`)
      },
      presentCall: args => ({ card: 'generic', title: 'List Postgres tables', kind: 'other', rawInput: args.schema ?? 'public' }),
    }),
  ]
}

// ---------------------------------------------------------------------------
// MCP command route
// ---------------------------------------------------------------------------

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
    // The caller's failure — an unknown database, a refused write, a syntax
    // error — is the answer.
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * The pool factory this plugin uses. Overridable so a test drives the tools
 * against a stand-in driver; production never reassigns it.
 */
let poolFactory: SqlPoolFactory = createDriverPool

/**
 * Replace the pool factory for the lifetime of the caller's test.
 * @param factory - the stand-in factory, or `createDriverPool` to restore it.
 * @returns the factory that was installed before this call.
 */
export function setPoolFactory(factory: SqlPoolFactory): SqlPoolFactory {
  const previous = poolFactory
  poolFactory = factory
  return previous
}

/**
 * Mount the Postgres roster and tools.
 * @param ctx - the plugin context, injecting `settings`, `agents` and `webServer`.
 * @param config - validated composition config.
 */
export function apply(ctx: Context, config: Config): void {
  const scope = ctx.settings.register(NS, CONFIG_SCHEMA, { base: { databases: [] } })
  const readDatabases: ReadDatabases = () => scope.get().databases
  const pools = new PoolRegistry(dsn => poolFactory(dsn))
  ctx.effect(() => () => {
    void pools.dispose()
  }, 'postgres: connection pools')

  // A token-guarded command route, so a CLI's MCP client (agy, opencode) can
  // reach the same tools a direct-provider agent gets natively. The token is
  // the route's whole authentication; an empty one leaves it unmounted.
  if (config.token !== '') {
    const routeTools = buildPostgresTools(readDatabases, pools, config)
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${config.path}/command`,
      authenticate: false,
      handler: (req: IncomingMessage, res: ServerResponse) => handleCommand(req, res, routeTools, config.token),
    }), `postgres: ${config.path}/command`)
  }

  const installed = new Map<Agent, { dispose: () => Promise<void> }>()
  const install = (agent: Agent): void => {
    if (installed.has(agent)) return
    installed.set(agent, agent.ctx.inject(['tools'], (scope2) => {
      registerPostgresTools(scope2, readDatabases, pools, config)
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
