#!/usr/bin/env node
// The harness's Dokploy tools over MCP, for the agy and opencode CLIs; see
// command-route-mcp.mjs.

import { serveCommandRoute } from './command-route-mcp.mjs'

serveCommandRoute({
  name: 'dsh-dokploy',
  url: process.env.DSH_DOKPLOY_COMMAND_URL ?? 'http://127.0.0.1:3081/dokploy/command',
  token: process.env.DSH_DOKPLOY_TOKEN ?? '',
  tokenVar: 'DSH_DOKPLOY_TOKEN',
})
