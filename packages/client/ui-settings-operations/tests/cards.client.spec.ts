/** The operations pages' staged forms: which drafts each field accepts. */

import { describe, expect, it } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { CloudflareCardController, type CloudflareSettings } from '../src/client/cloudflare-card-controller.ts'
import { DokployCardController, type DokploySettings } from '../src/client/dokploy-card-controller.ts'
import { PostgresCardController, type PostgresSettings } from '../src/client/postgres-card-controller.ts'

describe('the Dokploy card', () => {
  /** A ready, writable `dokploy` scope with no servers configured. */
  function card() {
    const host = stubConfigForm<DokploySettings>()
    const controller = new DokployCardController(host.scope)
    const face = controller.inject()
    host.publish({ status: 'ready', writable: true, value: { servers: [] }, base: { servers: [] }, user: {} })
    return { host, face, state: () => face.hooks.dokployCard.getSnapshot() }
  }

  it('accepts a row that carries the key inline, which is what the placeholder shows', () => {
    const { face, state } = card()

    face.edit('servers', '[{"name":"main","url":"https://server.example.com","apiKey":"dk-live"}]')

    // The field used to demand `apiKeyEnv` on every row, so typing the form's
    // own placeholder left Save disabled and said only that the list was
    // invalid. The Host has always accepted either key form.
    expect(state().servers.invalid).toBe(false)
    expect(state()).toMatchObject({ dirty: true, invalid: false })
  })

  it('accepts a row that names an environment variable instead', () => {
    const { face, state } = card()

    face.edit('servers', '[{"name":"main","url":"https://server.example.com","apiKeyEnv":"DOKPLOY_KEY_MAIN"}]')

    expect(state().servers.invalid).toBe(false)
  })

  it('refuses a row with neither key form, which could never authenticate', () => {
    const { face, state } = card()

    face.edit('servers', '[{"name":"main","url":"https://server.example.com"}]')

    expect(state().servers.invalid).toBe(true)
  })

  it('refuses a bare object, an empty key and a missing url', () => {
    const { face, state } = card()

    // A single server pasted without the enclosing array — the first thing
    // anyone types, and worth failing on rather than silently coercing.
    face.edit('servers', '{"name":"main","url":"https://x","apiKey":"dk-live"}')
    expect(state().servers.invalid).toBe(true)

    face.edit('servers', '[{"name":"main","url":"https://x","apiKey":"   "}]')
    expect(state().servers.invalid).toBe(true)

    face.edit('servers', '[{"name":"main","apiKey":"dk-live"}]')
    expect(state().servers.invalid).toBe(true)
  })

  it('reads an empty list as clearing the field, not as a parse failure', () => {
    const { face, state } = card()

    face.edit('servers', '   ')

    expect(state().servers.invalid).toBe(false)
  })
})

describe('the Cloudflare card', () => {
  /** A ready, writable `cloudflare` scope with no zones configured. */
  function card() {
    const host = stubConfigForm<CloudflareSettings>()
    const controller = new CloudflareCardController(host.scope)
    const face = controller.inject()
    host.publish({ status: 'ready', writable: true, value: { zones: [] }, base: { zones: [] }, user: {} })
    return { host, face, state: () => face.hooks.cloudflareCard.getSnapshot() }
  }

  it('accepts a row that carries the token inline, which is what the placeholder shows', () => {
    const { face, state } = card()

    face.edit('zones', '[{"name":"site","zoneId":"z1","apiToken":"cf-live"}]')

    expect(state().zones.invalid).toBe(false)
    expect(state()).toMatchObject({ dirty: true, invalid: false })
  })

  it('accepts a row that names an environment variable instead', () => {
    const { face, state } = card()

    face.edit('zones', '[{"name":"site","zoneId":"z1","apiTokenEnv":"CLOUDFLARE_TOKEN_SITE"}]')

    expect(state().zones.invalid).toBe(false)
  })

  it('refuses a row with neither token form, which could never authenticate', () => {
    const { face, state } = card()

    face.edit('zones', '[{"name":"site","zoneId":"z1"}]')

    expect(state().zones.invalid).toBe(true)
  })

  it('refuses malformed JSON, a bare object, an empty token and a missing zoneId', () => {
    const { face, state } = card()

    face.edit('zones', '[{"name":')
    expect(state().zones.invalid).toBe(true)

    // A single zone pasted without the enclosing array.
    face.edit('zones', '{"name":"site","zoneId":"z1","apiToken":"cf-live"}')
    expect(state().zones.invalid).toBe(true)

    face.edit('zones', '[{"name":"site","zoneId":"z1","apiToken":"   "}]')
    expect(state().zones.invalid).toBe(true)

    face.edit('zones', '[{"name":"site","apiToken":"cf-live"}]')
    expect(state().zones.invalid).toBe(true)
  })

  it('reads an empty list as clearing the field, not as a parse failure', () => {
    const { face, state } = card()

    face.edit('zones', '   ')

    expect(state().zones.invalid).toBe(false)
  })
})

describe('the Postgres card', () => {
  /** A ready, writable `postgres` scope with no databases configured. */
  function card() {
    const host = stubConfigForm<PostgresSettings>()
    const controller = new PostgresCardController(host.scope)
    const face = controller.inject()
    host.publish({ status: 'ready', writable: true, value: { databases: [] }, base: { databases: [] }, user: {} })
    return { host, face, state: () => face.hooks.postgresCard.getSnapshot() }
  }

  it('accepts a row that names an environment variable, which is what the placeholder shows', () => {
    const { face, state } = card()

    face.edit('databases', '[{"name":"main","dsnEnv":"PG_DSN_MAIN","readOnly":true}]')

    expect(state().databases.invalid).toBe(false)
    expect(state()).toMatchObject({ dirty: true, invalid: false })
  })

  it('accepts a row that carries the connection string inline', () => {
    const { face, state } = card()

    face.edit('databases', '[{"name":"main","dsn":"postgres://user:pass@host:5432/app"}]')

    expect(state().databases.invalid).toBe(false)
  })

  it('refuses a row with neither DSN form, which could never connect', () => {
    const { face, state } = card()

    face.edit('databases', '[{"name":"main"}]')

    expect(state().databases.invalid).toBe(true)
  })

  it('refuses a bare object, an empty name and an empty DSN', () => {
    const { face, state } = card()

    // A single database pasted without the enclosing array — the first thing
    // anyone types, and worth failing on rather than silently coercing.
    face.edit('databases', '{"name":"main","dsnEnv":"PG_DSN_MAIN"}')
    expect(state().databases.invalid).toBe(true)

    face.edit('databases', '[{"name":"   ","dsnEnv":"PG_DSN_MAIN"}]')
    expect(state().databases.invalid).toBe(true)

    face.edit('databases', '[{"name":"main","dsn":"   "}]')
    expect(state().databases.invalid).toBe(true)
  })

  it('refuses the optional fields when they are the wrong kind of value', () => {
    const { face, state } = card()

    // readOnly is what stands between the agent and a DELETE, so a string
    // "false" must not reach the Host and be read as a truthy setting.
    face.edit('databases', '[{"name":"main","dsnEnv":"PG_DSN_MAIN","readOnly":"false"}]')
    expect(state().databases.invalid).toBe(true)

    face.edit('databases', '[{"name":"main","dsnEnv":"PG_DSN_MAIN","statementTimeoutMs":0}]')
    expect(state().databases.invalid).toBe(true)

    face.edit('databases', '[{"name":"main","dsnEnv":"PG_DSN_MAIN","statementTimeoutMs":"2000"}]')
    expect(state().databases.invalid).toBe(true)
  })

  it('refuses text that is not JSON, and a list that is not of objects', () => {
    const { face, state } = card()

    face.edit('databases', 'not json at all')
    expect(state().databases.invalid).toBe(true)

    face.edit('databases', '["main"]')
    expect(state().databases.invalid).toBe(true)
  })

  it('reads an empty list as clearing the field, not as a parse failure', () => {
    const { face, state } = card()

    face.edit('databases', '   ')

    expect(state().databases.invalid).toBe(false)
  })
})

describe('the Cloudflare card accounts field', () => {
  /** A ready, writable `cloudflare` scope with no accounts configured. */
  function card() {
    const host = stubConfigForm<CloudflareSettings>()
    const controller = new CloudflareCardController(host.scope)
    const face = controller.inject()
    host.publish({ status: 'ready', writable: true, value: { zones: [], accounts: [] }, base: { zones: [], accounts: [] }, user: {} })
    return { face, state: () => face.hooks.cloudflareCard.getSnapshot() }
  }

  it('edits the accounts list the plugin reads, several accounts at once', () => {
    const { face, state } = card()

    // The plugin reads `accounts`; the card once edited a single `account`,
    // which the plugin never read, so an account saved here did nothing.
    face.edit('accounts', '[{"name":"main","id":"a1","apiToken":"cf-acct"},{"name":"tiuc","id":"a2","apiTokenEnv":"CF_ACCOUNT_TIUC"}]')

    expect(state().accounts.invalid).toBe(false)
    expect(state()).toMatchObject({ dirty: true, invalid: false })
  })

  it('refuses a bare object, a row without a name or id, and a row with no token', () => {
    const { face, state } = card()

    face.edit('accounts', '{"name":"main","id":"a1","apiToken":"cf-acct"}')
    expect(state().accounts.invalid).toBe(true)

    face.edit('accounts', '[{"id":"a1","apiToken":"cf-acct"}]')
    expect(state().accounts.invalid).toBe(true)

    face.edit('accounts', '[{"name":"main","apiToken":"cf-acct"}]')
    expect(state().accounts.invalid).toBe(true)

    face.edit('accounts', '[{"name":"main","id":"a1"}]')
    expect(state().accounts.invalid).toBe(true)
  })

  it('reads empty text as clearing the field, which turns the account tools off', () => {
    const { face, state } = card()

    face.edit('accounts', '  ')

    expect(state().accounts.invalid).toBe(false)
  })
})
