#!/usr/bin/env node
// The DeerFlow download browser. Klipara Scout (scout-…), SEO employee (seo-…), TikTok Shop employee (tts-…) and WhatsApp delegate (wad-…) Sessions see no tools and are refused: its Google account is the one Klipara downloads YouTube videos with.
// Relayed for the agy and opencode CLIs; see remote-relay-mcp.mjs.

process.env.RELAY_NAME = 'deerflow'
process.env.RELAY_URL_VAR = 'DEERFLOW_BROWSER_MCP_URL'
process.env.RELAY_TOKEN_VAR = 'DEERFLOW_BROWSER_MCP_TOKEN'
process.env.RELAY_DENY_SESSION_PREFIX = 'scout-,seo-,tts-,wad-'
process.env.DEERFLOW_BROWSER_MCP_URL ??= 'https://deer.linkfa.de/mcp/browser'
await import('./remote-relay-mcp.mjs')
