#!/usr/bin/env node
// The harness's Postgres tools over MCP, for the agy and opencode CLIs; see
// command-route-mcp.mjs.

import { serveCommandRoute } from './command-route-mcp.mjs'

serveCommandRoute({
  name: 'dsh-postgres',
  url: process.env.DSH_POSTGRES_COMMAND_URL ?? 'http://127.0.0.1:3081/postgres/command',
  token: process.env.DSH_POSTGRES_TOKEN ?? '',
  tokenVar: 'DSH_POSTGRES_TOKEN',
})
