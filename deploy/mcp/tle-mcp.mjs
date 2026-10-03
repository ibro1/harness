#!/usr/bin/env node
// The harness's tools employee tools over MCP, for the agy and opencode CLIs;
// see command-route-mcp.mjs and packages/host/tools-employee.

import { serveCommandRoute } from './command-route-mcp.mjs'

serveCommandRoute({
  name: 'dsh-tools-employee',
  url: process.env.DSH_TLE_COMMAND_URL ?? 'http://127.0.0.1:3081/tools/command',
  token: process.env.DSH_TLE_TOKEN ?? '',
  tokenVar: 'DSH_TLE_TOKEN',
})
