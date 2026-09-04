#!/usr/bin/env node
// Grant the agy CLI standing permission to call this deployment's browser tools.
//
// A headless `agy -p` run cannot prompt, so a tool needing approval is
// auto-denied and the turn produces nothing — the model calls browser_snapshot,
// the CLI refuses it, and the harness reports an empty response. The allow-rule
// is the documented way through.
//
// Scoped to this MCP server on purpose: `--dangerously-skip-permissions` would
// also auto-approve agy's own file writes and shell commands, which is a far
// larger grant than driving a browser.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const RULE = process.argv[2] ?? 'mcp(dsh-browser/*)'
const SETTINGS = process.env.AGY_SETTINGS_PATH ?? join(homedir(), '.gemini', 'settings.json')

let settings = {}
try {
  settings = JSON.parse(readFileSync(SETTINGS, 'utf8'))
} catch {
  // No settings yet, or unreadable: start from an empty document rather than
  // failing, since the file is created on first run.
}
if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) settings = {}

const permissions = typeof settings.permissions === 'object' && settings.permissions !== null && !Array.isArray(settings.permissions)
  ? settings.permissions
  : {}
const allow = Array.isArray(permissions.allow) ? permissions.allow : []

if (allow.includes(RULE)) {
  console.log(`already present: ${RULE}`)
  process.exit(0)
}

allow.push(RULE)
permissions.allow = allow
settings.permissions = permissions

mkdirSync(dirname(SETTINGS), { recursive: true })
// Atomic: a half-written settings.json would lose the CLI's own configuration.
const temporary = `${SETTINGS}.tmp`
writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`)
renameSync(temporary, SETTINGS)
console.log(`added: ${RULE}`)
