#!/usr/bin/env node
// The harness's YouTube niche scout tools over MCP, for the agy and opencode
// CLIs; see command-route-mcp.mjs and packages/host/youtube-niche-scout.

import { serveCommandRoute } from './command-route-mcp.mjs'

serveCommandRoute({
  name: 'dsh-youtube-niche-scout',
  url: process.env.DSH_YNS_COMMAND_URL ?? 'http://127.0.0.1:3081/yns/command',
  token: process.env.DSH_YNS_TOKEN ?? '',
  tokenVar: 'DSH_YNS_TOKEN',
})
