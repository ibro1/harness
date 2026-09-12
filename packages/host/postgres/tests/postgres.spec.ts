/**
 * The Postgres tools, driven against a stand-in driver: tool registration on an
 * agent, database resolution by name, the read-only transaction every query
 * runs inside, the write refusal, and the shaping of results. No server is
 * involved — the pool factory is a seam, so the assertions are on the SQL that
 * was issued and on the rendered text. The settings service and the agent
 * roster are stubbed, because this package owns the tools, not the settings
 * store or the agent lifecycle.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  apply, buildPostgresTools, PoolRegistry, renderCell, renderRows, setPoolFactory,
  type Config, type PostgresDatabase, type SqlPool, type SqlPoolFactory, type SqlRows,
} from '../src/index.ts'

/** A tool as the stub registry recorded it. */
interface RecordedTool {
  name: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<{ text: string }>
}

/** One statement the stand-in driver saw. */
interface Issued {
  statement: string
  parameters: readonly unknown[] | undefined
}

/** Build a result set with the decorations the real driver adds. */
function makeRows(list: Record<string, unknown>[], columns?: string[], count?: number): SqlRows {
  const rows = list as SqlRows
  if (columns !== undefined) rows.columns = columns.map(name => ({ name }))
  if (count !== undefined) rows.count = count
  return rows
}

/** A driver stand-in that records every statement and answers from one callback. */
function stubDriver(answer: (statement: string) => SqlRows = () => makeRows([])) {
  const issued: Issued[] = []
  const opened: string[] = []
  const ended: string[] = []
  let released = 0
  const factory: SqlPoolFactory = (dsn: string): SqlPool => {
    opened.push(dsn)
    return {
      reserve: () => Promise.resolve({
        unsafe: (statement: string, parameters?: readonly unknown[]) => {
          issued.push({ statement, parameters })
          return Promise.resolve(answer(statement))
        },
        release: () => { released += 1 },
      }),
      end: () => { ended.push(dsn); return Promise.resolve() },
    }
  }
  return { factory, issued, opened, ended, releases: () => released }
}

let restore: SqlPoolFactory | undefined

afterEach(() => {
  if (restore !== undefined) {
    setPoolFactory(restore)
    restore = undefined
  }
  delete process.env['PG_DSN_TEST']
})

/**
 * Mount the plugin against a stub settings roster and a single stub agent, and
 * return that agent's registered tools by name. The roster array is held by
 * reference, so a test may edit it between calls the way settings would.
 */
function mount(databases: PostgresDatabase[], overrides: Partial<Config> = {}): Map<string, RecordedTool> {
  const tools = new Map<string, RecordedTool>()
  const agentCtx = {
    inject(_names: string[], fn: (scope: unknown) => void) {
      fn({
        effect(effectFn: () => unknown) { return effectFn() },
        tools: {
          register(tool: RecordedTool) { tools.set(tool.name, tool); return () => {} },
        },
      })
      return { dispose: () => Promise.resolve() }
    },
  }
  const ctx = {
    settings: {
      register() {
        return { get: () => ({ databases }), watch: () => () => {}, update: () => Promise.resolve() }
      },
    },
    agents: { list: () => [{ ctx: agentCtx }] },
    on() {},
    effect(fn: () => unknown) { fn() },
  }
  apply(ctx as unknown as Context, {
    maxRows: 200, maxOutputBytes: 64_000, path: '/postgres', token: '', ...overrides,
  })
  return tools
}

const exec = { signal: new AbortController().signal }

describe('postgres tools', () => {
  it('registers the four tools on an agent', () => {
    restore = setPoolFactory(stubDriver().factory)
    const tools = mount([])
    expect([...tools.keys()].sort())
      .toEqual(['postgres_databases', 'postgres_execute', 'postgres_query', 'postgres_tables'])
  })

  it('lists configured databases with their read-only flag and never a DSN', async () => {
    restore = setPoolFactory(stubDriver().factory)
    const tools = mount([
      { name: 'main', dsn: 'postgres://someone:hunter2@db.internal:5432/app' },
      { name: 'scratch', dsn: 'postgres://someone:hunter2@db.internal:5432/scratch', readOnly: false },
    ])
    const out = await tools.get('postgres_databases')!.execute({}, exec)
    expect(out.text).toContain('- main (read-only)')
    expect(out.text).toContain('- scratch (writes allowed)')
    expect(out.text).not.toContain('hunter2')
    expect(out.text).not.toContain('db.internal')
    expect(out.text).not.toContain('postgres://')
  })

  it('resolves a database by name', async () => {
    const driver = stubDriver(statement => (statement === 'select 1' ? makeRows([{ n: 1 }], ['n']) : makeRows([])))
    restore = setPoolFactory(driver.factory)
    const tools = mount([
      { name: 'main', dsn: 'postgres://main' },
      { name: 'reports', dsn: 'postgres://reports' },
    ])
    await tools.get('postgres_query')!.execute({ database: 'reports', statement: 'select 1' }, exec)
    expect(driver.opened).toEqual(['postgres://reports'])
  })

  it('refuses to guess when several databases are configured and none was named', async () => {
    restore = setPoolFactory(stubDriver().factory)
    const tools = mount([
      { name: 'main', dsn: 'postgres://main' },
      { name: 'reports', dsn: 'postgres://reports' },
    ])
    await expect(tools.get('postgres_query')!.execute({ statement: 'select 1' }, exec))
      .rejects.toThrow('Several Postgres databases are configured (main, reports); pass database to choose one')
  })

  it('reports an unknown database name with the ones that exist', async () => {
    restore = setPoolFactory(stubDriver().factory)
    const tools = mount([{ name: 'main', dsn: 'postgres://main' }])
    await expect(tools.get('postgres_query')!.execute({ database: 'nope', statement: 'select 1' }, exec))
      .rejects.toThrow('No Postgres database named "nope"; configured: main')
  })

  it('says what to set when a database has neither dsn nor dsnEnv', async () => {
    restore = setPoolFactory(stubDriver().factory)
    const tools = mount([{ name: 'main' }])
    await expect(tools.get('postgres_query')!.execute({ statement: 'select 1' }, exec))
      .rejects.toThrow('Postgres main has no connection string: give this database a dsn, or a dsnEnv naming a set environment variable.')
  })

  it('names the unset variable when dsnEnv points at nothing', async () => {
    restore = setPoolFactory(stubDriver().factory)
    const tools = mount([{ name: 'main', dsnEnv: 'PG_DSN_TEST' }])
    await expect(tools.get('postgres_query')!.execute({ statement: 'select 1' }, exec))
      .rejects.toThrow('set the PG_DSN_TEST environment variable')
  })

  it('prefers the environment variable over an inline dsn', async () => {
    process.env['PG_DSN_TEST'] = 'postgres://from-env'
    const driver = stubDriver()
    restore = setPoolFactory(driver.factory)
    const tools = mount([{ name: 'main', dsnEnv: 'PG_DSN_TEST', dsn: 'postgres://inline' }])
    await tools.get('postgres_query')!.execute({ statement: 'select 1' }, exec)
    expect(driver.opened).toEqual(['postgres://from-env'])
  })
})

describe('postgres_query', () => {
  it('runs the statement inside a read-only transaction it rolls back', async () => {
    const driver = stubDriver(statement => (
      statement === 'select id from orders' ? makeRows([{ id: 7 }], ['id']) : makeRows([])
    ))
    restore = setPoolFactory(driver.factory)
    const tools = mount([{ name: 'main', dsn: 'postgres://main' }])
    await tools.get('postgres_query')!.execute({ statement: 'select id from orders' }, exec)
    expect(driver.issued.map(entry => entry.statement)).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 15000',
      'select id from orders',
      'ROLLBACK',
    ])
    expect(driver.releases()).toBe(1)
  })

  it('takes the statement timeout from the database entry', async () => {
    const driver = stubDriver()
    restore = setPoolFactory(driver.factory)
    const tools = mount([{ name: 'main', dsn: 'postgres://main', statementTimeoutMs: 2500 }])
    await tools.get('postgres_query')!.execute({ statement: 'select 1' }, exec)
    expect(driver.issued.map(entry => entry.statement)).toContain('SET LOCAL statement_timeout = 2500')
  })

  it('rolls back and surfaces the server error when the statement fails', async () => {
    const driver = stubDriver((statement) => {
      if (statement === 'delete from orders') throw new Error('cannot execute DELETE in a read-only transaction')
      return makeRows([])
    })
    restore = setPoolFactory(driver.factory)
    const tools = mount([{ name: 'main', dsn: 'postgres://main' }])
    await expect(tools.get('postgres_query')!.execute({ statement: 'delete from orders' }, exec))
      .rejects.toThrow('cannot execute DELETE in a read-only transaction')
    expect(driver.issued.map(entry => entry.statement).filter(s => s === 'ROLLBACK')).toHaveLength(1)
    expect(driver.releases()).toBe(1)
  })

  it('caps the rendered rows and says how many matched', async () => {
    const many = Array.from({ length: 250 }, (_value, index) => ({ id: index }))
    const driver = stubDriver(statement => (statement === 'select id from big' ? makeRows(many, ['id']) : makeRows([])))
    restore = setPoolFactory(driver.factory)
    const tools = mount([{ name: 'main', dsn: 'postgres://main' }])
    const out = await tools.get('postgres_query')!.execute({ statement: 'select id from big' }, exec)
    expect(out.text).toContain('showing the first 200 of 250 matching rows')
    expect(out.text.split('\n').filter(line => /^\d+$/u.test(line.trim()))).toHaveLength(200)
  })

  it('stops at the byte budget and says the budget was the reason', async () => {
    const many = Array.from({ length: 50 }, (_value, index) => ({ id: index, note: 'x'.repeat(80) }))
    const driver = stubDriver(statement => (statement === 'select * from wide' ? makeRows(many, ['id', 'note']) : makeRows([])))
    restore = setPoolFactory(driver.factory)
    const tools = mount([{ name: 'main', dsn: 'postgres://main' }], { maxOutputBytes: 1024 })
    const out = await tools.get('postgres_query')!.execute({ statement: 'select * from wide' }, exec)
    expect(out.text).toContain('of 50 matching rows')
    expect(out.text).toContain('1024-byte output budget was reached')
  })

  it('renders NULL so it is distinguishable from an empty string', async () => {
    const driver = stubDriver(statement => (
      statement === 'select a, b from t'
        ? makeRows([{ a: null, b: '' }, { a: '', b: 'z' }], ['a', 'b'])
        : makeRows([])
    ))
    restore = setPoolFactory(driver.factory)
    const tools = mount([{ name: 'main', dsn: 'postgres://main' }])
    const out = await tools.get('postgres_query')!.execute({ statement: 'select a, b from t' }, exec)
    const lines = out.text.split('\n')
    expect(lines).toContain('NULL |')
    expect(lines).toContain('     | z')
    expect(out.text).not.toContain('NULL | z')
  })

  it('says plainly when nothing matched', async () => {
    restore = setPoolFactory(stubDriver().factory)
    const tools = mount([{ name: 'main', dsn: 'postgres://main' }])
    const out = await tools.get('postgres_query')!.execute({ statement: 'select 1 where false' }, exec)
    expect(out.text).toBe('No rows.')
  })
})

describe('postgres_execute', () => {
  it('refuses on a read-only database and names the setting to change', async () => {
    const driver = stubDriver()
    restore = setPoolFactory(driver.factory)
    const tools = mount([{ name: 'main', dsn: 'postgres://main' }])
    await expect(tools.get('postgres_execute')!.execute({ statement: 'delete from orders' }, exec))
      .rejects.toThrow('Postgres main is read-only, so postgres_execute will not run. To allow writes, set readOnly to false on the "main" entry under Settings → postgres.')
    expect(driver.issued).toEqual([])
  })

  it('refuses on an entry that states readOnly explicitly', async () => {
    restore = setPoolFactory(stubDriver().factory)
    const tools = mount([{ name: 'main', dsn: 'postgres://main', readOnly: true }])
    await expect(tools.get('postgres_execute')!.execute({ statement: 'delete from orders' }, exec))
      .rejects.toThrow('is read-only')
  })

  it('commits and reports the affected row count when writes are allowed', async () => {
    const driver = stubDriver(statement => (
      statement === 'delete from orders where id = 1' ? makeRows([], [], 1) : makeRows([])
    ))
    restore = setPoolFactory(driver.factory)
    const tools = mount([{ name: 'scratch', dsn: 'postgres://scratch', readOnly: false }])
    const out = await tools.get('postgres_execute')!.execute({ statement: 'delete from orders where id = 1' }, exec)
    expect(driver.issued.map(entry => entry.statement)).toEqual([
      'BEGIN',
      'SET LOCAL statement_timeout = 15000',
      'delete from orders where id = 1',
      'COMMIT',
    ])
    expect(out.text).toBe('Committed on scratch: 1 row affected.')
  })

  it('warns in its description that it can destroy data', () => {
    restore = setPoolFactory(stubDriver().factory)
    const tools = mount([{ name: 'scratch', dsn: 'postgres://scratch', readOnly: false }])
    const definition = tools.get('postgres_execute') as unknown as { description: string }
    expect(definition.description).toContain('destroy data')
  })
})

describe('postgres_tables', () => {
  it('reads reltuples and binds the schema as a parameter', async () => {
    const driver = stubDriver(statement => (
      statement.includes('reltuples')
        ? makeRows([{ table: 'orders', row_estimate: 1200, total_size: '3 MB' }], ['table', 'row_estimate', 'total_size'])
        : makeRows([])
    ))
    restore = setPoolFactory(driver.factory)
    const tools = mount([{ name: 'main', dsn: 'postgres://main' }])
    const out = await tools.get('postgres_tables')!.execute({}, exec)
    const query = driver.issued.find(entry => entry.statement.includes('reltuples'))
    expect(query?.parameters).toEqual(['public'])
    expect(query?.statement).not.toContain('count(*)')
    expect(driver.issued[0]?.statement).toBe('BEGIN READ ONLY')
    expect(out.text).toContain('orders')
    expect(out.text).toContain('1200')
  })

  it('passes a named schema through as a parameter, never interpolated', async () => {
    const driver = stubDriver(() => makeRows([]))
    restore = setPoolFactory(driver.factory)
    const tools = mount([{ name: 'main', dsn: 'postgres://main' }])
    const out = await tools.get('postgres_tables')!.execute({ schema: "x'; drop table t; --" }, exec)
    const query = driver.issued.find(entry => entry.statement.includes('reltuples'))
    expect(query?.parameters).toEqual(["x'; drop table t; --"])
    expect(query?.statement).not.toContain('drop table')
    expect(out.text).toContain('No tables in schema')
  })
})

describe('pool lifetime', () => {
  it('reuses one pool per database across calls', async () => {
    const driver = stubDriver()
    restore = setPoolFactory(driver.factory)
    const tools = mount([{ name: 'main', dsn: 'postgres://main' }])
    await tools.get('postgres_query')!.execute({ statement: 'select 1' }, exec)
    await tools.get('postgres_query')!.execute({ statement: 'select 2' }, exec)
    expect(driver.opened).toEqual(['postgres://main'])
  })

  it('ends the old pool when a database DSN changes in settings', async () => {
    const driver = stubDriver()
    restore = setPoolFactory(driver.factory)
    const roster: PostgresDatabase[] = [{ name: 'main', dsn: 'postgres://old' }]
    const tools = mount(roster)
    await tools.get('postgres_query')!.execute({ statement: 'select 1' }, exec)
    roster[0] = { name: 'main', dsn: 'postgres://new' }
    await tools.get('postgres_query')!.execute({ statement: 'select 1' }, exec)
    expect(driver.opened).toEqual(['postgres://old', 'postgres://new'])
    expect(driver.ended).toEqual(['postgres://old'])
  })

  it('ends every pool on dispose', async () => {
    const driver = stubDriver()
    const registry = new PoolRegistry(driver.factory)
    registry.acquire({ name: 'a', dsn: 'postgres://a', readOnly: true, statementTimeoutMs: 1000 })
    registry.acquire({ name: 'b', dsn: 'postgres://b', readOnly: true, statementTimeoutMs: 1000 })
    await registry.dispose()
    expect(driver.ended.sort()).toEqual(['postgres://a', 'postgres://b'])
  })
})

describe('rendering', () => {
  it('escapes newlines so one value cannot break the table', () => {
    expect(renderCell('a\nb')).toBe('a\\nb')
  })

  it('renders a timestamp and a buffer readably', () => {
    expect(renderCell(new Date(0))).toBe('1970-01-01T00:00:00.000Z')
    expect(renderCell(Buffer.from([0xde, 0xad]))).toBe('\\xdead')
  })

  it('aligns columns and closes with the row count', () => {
    const text = renderRows(makeRows([{ id: 1, name: 'alice' }, { id: 22, name: 'bo' }], ['id', 'name']), 200, 64_000)
    expect(text.split('\n')).toEqual([
      'id | name',
      // Ten characters, matching a data row ("1  | alice"), not the nine of the
      // header — the header loses its trailing pad to trimEnd, the rule spans
      // the full column width the way psql's does.
      '---+------',
      '1  | alice',
      '22 | bo',
      '',
      '(2 rows)',
    ])
  })
})

describe('postgres MCP surface', () => {
  it('builds a catalogue of the four tools with their parameters', () => {
    const driver = stubDriver()
    const tools = buildPostgresTools(
      () => [{ name: 'main', dsn: 'postgres://main' }],
      new PoolRegistry(driver.factory),
      { maxRows: 200, maxOutputBytes: 64_000, path: '/postgres', token: '' },
    )
    expect(tools.map(tool => tool.name))
      .toEqual(['postgres_databases', 'postgres_query', 'postgres_execute', 'postgres_tables'])
    const query = tools.find(tool => tool.name === 'postgres_query')
    expect((query?.parameters as { properties: object }).properties).toHaveProperty('statement')
  })
})
