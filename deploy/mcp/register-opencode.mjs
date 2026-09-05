#!/usr/bin/env node
// Register the browser MCP server with the opencode CLI.
//
// opencode, like agy, answers with its own tools and drops the harness's, so
// MCP is the only route by which a model reached through it can drive a
// browser. Unlike agy it has no `mcp add` subcommand reachable here, so the
// entry is merged into its config file directly.
//
// The shape is the SDK's `McpLocalConfig`, read from
// @opencode-ai/sdk types rather than guessed: type, command, environment,
// enabled, timeout.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const CONFIG = process.env.OPENCODE_CONFIG_PATH
  ?? join(homedir(), '.config', 'opencode', 'opencode.jsonc')
const SERVER = process.argv[2] ?? '/app/deploy/mcp/browser-mcp.mjs'
const NAME = 'dsh-browser'

const token = process.env.DSH_BROWSER_BRIDGE_TOKEN ?? ''
if (token === '') {
  console.error('DSH_BROWSER_BRIDGE_TOKEN is unset; not registering')
  process.exit(1)
}

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
  type: 'local',
  command: ['node', SERVER],
  environment: {
    DSH_BROWSER_BRIDGE_TOKEN: token,
    DSH_BROWSER_COMMAND_URL: process.env.DSH_BROWSER_COMMAND_URL
      ?? 'http://127.0.0.1:3081/browser-bridge/command',
  },
  enabled: true,
}
config.mcp = mcp

mkdirSync(dirname(CONFIG), { recursive: true })
const temporary = `${CONFIG}.tmp`
writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`)
renameSync(temporary, CONFIG)
console.log(`registered ${NAME} in ${CONFIG}`)
