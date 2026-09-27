#!/usr/bin/env node
// The harness's Cloudflare tools over MCP, for the agy and opencode CLIs; see
// command-route-mcp.mjs.

import { serveCommandRoute } from './command-route-mcp.mjs'

serveCommandRoute({
  name: 'dsh-cloudflare',
  url: process.env.DSH_CLOUDFLARE_COMMAND_URL ?? 'http://127.0.0.1:3081/cloudflare/command',
  token: process.env.DSH_CLOUDFLARE_TOKEN ?? '',
  tokenVar: 'DSH_CLOUDFLARE_TOKEN',
})
