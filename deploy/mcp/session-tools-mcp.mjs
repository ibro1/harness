#!/usr/bin/env node
// The harness's session outputs and page capture tools over MCP, for the agy and opencode CLIs; see
// command-route-mcp.mjs.

import { serveCommandRoute } from './command-route-mcp.mjs'

serveCommandRoute({
  name: 'dsh-session-tools',
  url: process.env.DSH_SESSION_TOOLS_COMMAND_URL ?? 'http://127.0.0.1:3081/session-tools/command',
  token: process.env.DSH_SESSION_TOOLS_TOKEN ?? '',
  tokenVar: 'DSH_SESSION_TOOLS_TOKEN',
})
