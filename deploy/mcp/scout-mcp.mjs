#!/usr/bin/env node
// The harness's Klipara Scout tools over MCP, for the agy and opencode CLIs; see
// command-route-mcp.mjs and packages/host/klipara-scout.

import { serveCommandRoute } from './command-route-mcp.mjs'

serveCommandRoute({
  name: 'dsh-scout',
  url: process.env.DSH_SCOUT_COMMAND_URL ?? 'http://127.0.0.1:3081/scout/command',
  token: process.env.DSH_SCOUT_TOKEN ?? '',
  tokenVar: 'DSH_SCOUT_TOKEN',
})
