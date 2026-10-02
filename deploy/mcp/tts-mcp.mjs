#!/usr/bin/env node
// The harness's TikTok Shop employee tools over MCP, for the agy and opencode
// CLIs; see command-route-mcp.mjs and packages/host/tiktok-shop-employee.

import { serveCommandRoute } from './command-route-mcp.mjs'

serveCommandRoute({
  name: 'dsh-tiktok-shop',
  url: process.env.DSH_TTS_COMMAND_URL ?? 'http://127.0.0.1:3081/tts/command',
  token: process.env.DSH_TTS_TOKEN ?? '',
  tokenVar: 'DSH_TTS_TOKEN',
})
