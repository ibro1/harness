#!/usr/bin/env node
// Register a REMOTE (HTTP) MCP server with the opencode CLI.
//
// opencode, like agy, answers with its own tools and drops the harness's, so
// MCP is the only route by which a model reached through it can use an external
// tool server. The sibling register-opencode.mjs registers a local (stdio)
// bridge; this one registers a server opencode connects to directly over HTTP,
// for a server that already speaks MCP over the network — the DeerFlow browser.
//
// The shape is opencode's remote MCP config: { type: 'remote', url, headers,
// enabled }, written into ~/.config/opencode/opencode.jsonc the same way the
// local form is, so a parse failure leaves the file untouched.
//
//   node register-opencode-remote.mjs <name> <URL_ENV> <TOKEN_ENV> [defaultUrl]

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const CONFIG = process.env.OPENCODE_CONFIG_PATH
  ?? join(homedir(), '.config', 'opencode', 'opencode.jsonc')
const NAME = process.argv[2] ?? 'deerflow'
const URL_ENV = process.argv[3] ?? 'DEERFLOW_BROWSER_MCP_URL'
const TOKEN_ENV = process.argv[4] ?? 'DEERFLOW_BROWSER_MCP_TOKEN'
const DEFAULT_URL = process.argv[5] ?? 'https://deer.linkfa.de/mcp/browser'

const token = process.env[TOKEN_ENV] ?? ''
if (token === '') {
  console.error(`${TOKEN_ENV} is unset; not registering`)
  process.exit(1)
}
const url = process.env[URL_ENV] || DEFAULT_URL

let config = {}
try {
  // The file is .jsonc by name but plain JSON in practice; a comment would
  // make it unreadable here, so a parse failure keeps the existing file rather
  // than replacing configuration this script does not understand.
  config = JSON.parse(readFileSync(CONFIG, 'utf8'))
} catch (error) {
  if (error instanceof SyntaxError) {
    console.error(`${CONFIG} is not plain JSON; leaving it alone`)
    process.exit(1)
  }
}
if (config === null || typeof config !== 'object' || Array.isArray(config)) config = {}

config.$schema ??= 'https://opencode.ai/config.json'
const mcp = typeof config.mcp === 'object' && config.mcp !== null && !Array.isArray(config.mcp) ? config.mcp : {}

mcp[NAME] = {
  type: 'remote',
  url,
  headers: { Authorization: `Bearer ${token}` },
  enabled: true,
}
config.mcp = mcp

mkdirSync(dirname(CONFIG), { recursive: true })
const temporary = `${CONFIG}.tmp`
writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`)
renameSync(temporary, CONFIG)
console.log(`registered ${NAME} (remote ${url}) in ${CONFIG}`)
