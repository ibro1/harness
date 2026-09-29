#!/usr/bin/env node
// The outreach browser: a separate Chromium signed in to the outreach Google account, which Klipara Scout sends and reads replies with.
// Relayed for the agy and opencode CLIs; see remote-relay-mcp.mjs.

process.env.RELAY_NAME = 'outreach'
process.env.RELAY_URL_VAR = 'DEERFLOW_OUTREACH_MCP_URL'
process.env.RELAY_TOKEN_VAR = 'DEERFLOW_BROWSER_MCP_TOKEN'
process.env.RELAY_DENY_SESSION_PREFIX = ''
process.env.DEERFLOW_OUTREACH_MCP_URL ??= 'https://deer.linkfa.de/mcp/outreach'
await import('./remote-relay-mcp.mjs')
