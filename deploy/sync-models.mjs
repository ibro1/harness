#!/usr/bin/env node
// Rewrite the agy and opencode model lists from what those CLIs actually serve.
//
// Both vendors retire and add model ids without notice, and the ids live in two
// hand-maintained places: the provider config the UI reads, and each bridge's
// own catalogue. A stale id fails only when someone selects it, and a stale id
// in `agent-default-model` fails on a fresh install with no obvious cause. This
// runs at boot, so the lists are derived rather than remembered.
//
//   node deploy/sync-models.mjs [--dry-run]

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SETTINGS_PATH = join(DSH_HOME, 'settings.yaml')
const CATALOGUE_PATH = join(DSH_HOME, '.model-catalogue.json')
const DRY_RUN = process.argv.includes('--dry-run')

/** Context and output limits for an id the settings file has never seen. */
function defaultsFor(id) {
  if (id.startsWith('gemini-')) return { contextWindow: 1048576, maxTokens: 65536 }
  if (id.startsWith('claude-')) return { contextWindow: 200000, maxTokens: 64000 }
  return { contextWindow: 131072, maxTokens: 16384 }
}

/** Title-case a bare id when the CLI offers no display name. */
function nameFor(id) {
  return id
    .replace(/-free$/, ' (Free)')
    .replace(/-/g, ' ')
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\(free\)/i, '(Free)')
}

function run(binary, args) {
  return execFileSync(binary, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] })
}

/** `agy models` prints `<id><tab or spaces><display name>` after a status line. */
function listAgy() {
  const out = run('agy', ['models'])
  const models = []
  for (const line of out.split('\n')) {
    const match = /^(\S+)(?:\t+|\s{2,})(.+?)\s*$/.exec(line)
    if (match !== null && !match[1].endsWith('...')) models.push({ id: match[1], name: match[2] })
  }
  return models
}

/** `opencode models` prints `<provider>/<id>`, one per line. */
function listOpencode() {
  const out = run('opencode', ['models'])
  const models = []
  for (const line of out.split('\n')) {
    const match = /^opencode\/(\S+)\s*$/.exec(line.trim())
    if (match !== null) models.push({ id: match[1], name: undefined })
  }
  return models
}

/**
 * Merge a live list over the configured one: an id the file already describes
 * keeps its tuned limits and display name; a new id gets inferred ones; an id
 * the CLI no longer serves is dropped.
 */
function merge(configured, live) {
  const byId = new Map((configured ?? []).map((row) => [row.id, row]))
  return live.map(({ id, name }) => {
    const existing = byId.get(id)
    if (existing !== undefined) return existing
    return { id, name: name ?? nameFor(id), ...defaultsFor(id), input: ['text', 'image'] }
  })
}

function summarise(provider, before, after) {
  const had = new Set((before ?? []).map((row) => row.id))
  const has = new Set(after.map((row) => row.id))
  const added = after.filter((row) => !had.has(row.id)).map((row) => row.id)
  const removed = [...had].filter((id) => !has.has(id))
  if (added.length === 0 && removed.length === 0) return `${provider}: ${String(after.length)} models, unchanged`
  const parts = []
  if (added.length > 0) parts.push(`+${added.join(' +')}`)
  if (removed.length > 0) parts.push(`-${removed.join(' -')}`)
  return `${provider}: ${String(after.length)} models, ${parts.join(' ')}`
}

if (!existsSync(SETTINGS_PATH)) {
  console.error(`sync-models: no settings at ${SETTINGS_PATH}; nothing to sync`)
  process.exit(0)
}

const document = yaml.load(readFileSync(SETTINGS_PATH, 'utf8')) ?? {}
const providers = document['llm-pi-ai']?.providers
if (providers === undefined) {
  console.error('sync-models: settings declare no llm-pi-ai providers; nothing to sync')
  process.exit(0)
}

const sources = [['agy', listAgy], ['opencode', listOpencode]]
const catalogue = {}
let changed = false

for (const [provider, list] of sources) {
  if (providers[provider] === undefined) continue
  let live
  try {
    live = list()
  } catch (error) {
    // A CLI that cannot answer leaves the configured list alone: an empty
    // catalogue would remove every model the operator can still select.
    console.error(`sync-models: ${provider} did not answer (${error.message.split('\n')[0]}); keeping its configured list`)
    catalogue[provider] = providers[provider].models ?? []
    continue
  }
  if (live.length === 0) {
    console.error(`sync-models: ${provider} listed no models; keeping its configured list`)
    catalogue[provider] = providers[provider].models ?? []
    continue
  }
  const before = providers[provider].models
  const after = merge(before, live)
  console.error(`sync-models: ${summarise(provider, before, after)}`)
  if (JSON.stringify(before) !== JSON.stringify(after)) changed = true
  providers[provider].models = after
  catalogue[provider] = after
}

// A default naming a retired model is the failure with no visible cause: the
// session opens on a model the provider will refuse.
const fallback = document['agent-default-model']
if (fallback !== undefined && providers[fallback.provider] !== undefined) {
  const available = (providers[fallback.provider].models ?? []).map((row) => row.id)
  if (available.length > 0 && !available.includes(fallback.model)) {
    console.error(`sync-models: default ${fallback.provider}/${fallback.model} is gone; using ${available[0]}`)
    document['agent-default-model'] = { provider: fallback.provider, model: available[0] }
    changed = true
  }
}

if (DRY_RUN) {
  console.error('sync-models: dry run, nothing written')
  process.exit(0)
}

writeFileSync(CATALOGUE_PATH, JSON.stringify(catalogue, null, 2))
if (!changed) {
  console.error('sync-models: settings already match')
  process.exit(0)
}
writeFileSync(SETTINGS_PATH, yaml.dump(document, { lineWidth: 120 }))
console.error(`sync-models: updated ${SETTINGS_PATH}`)
