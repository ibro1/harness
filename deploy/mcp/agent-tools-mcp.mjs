#!/usr/bin/env node
// The harness's Agent Teams tools over MCP, for the agy and opencode CLIs; see
// command-route-mcp.mjs and deploy/plugins/agent-tools.mjs.

import { serveCommandRoute } from './command-route-mcp.mjs'

serveCommandRoute({
  name: 'dsh-agent-tools',
  url: process.env.DSH_AGENT_TOOLS_COMMAND_URL ?? 'http://127.0.0.1:3081/agent-tools/command',
  token: process.env.DSH_AGENT_TOOLS_TOKEN ?? '',
  tokenVar: 'DSH_AGENT_TOOLS_TOKEN',
})
