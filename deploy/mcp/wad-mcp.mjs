#!/usr/bin/env node
// The harness's WhatsApp delegate tools over MCP, for the agy and opencode
// CLIs; see command-route-mcp.mjs and packages/host/whatsapp-delegate. The
// route lists and runs them only for a delegate Session (ids `wad-…`).

import { serveCommandRoute } from './command-route-mcp.mjs'

serveCommandRoute({
  name: 'dsh-whatsapp-delegate',
  url: process.env.DSH_WAD_COMMAND_URL ?? 'http://127.0.0.1:3081/whatsapp-delegate/command',
  token: process.env.DSH_WAD_TOKEN ?? '',
  tokenVar: 'DSH_WAD_TOKEN',
})
