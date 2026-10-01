#!/usr/bin/env node
// The harness's SEO employee tools over MCP, for the agy and opencode CLIs; see
// command-route-mcp.mjs and packages/host/seo-employee.

import { serveCommandRoute } from './command-route-mcp.mjs'

serveCommandRoute({
  name: 'dsh-seo',
  url: process.env.DSH_SEO_COMMAND_URL ?? 'http://127.0.0.1:3081/seo/command',
  token: process.env.DSH_SEO_TOKEN ?? '',
  tokenVar: 'DSH_SEO_TOKEN',
})
