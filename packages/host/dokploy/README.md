---
description: "Dokploy control: a settings-configured roster of Dokploy servers and the agent tools that query and deploy through their API."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-dokploy

## Summary

Lets an agent see and drive your Dokploy servers. Servers are configured in the `dokploy` user-settings namespace — added and edited in the settings UI the same way models are, one entry per server with a name, a base URL, and the name of an environment variable holding that server's API key. The key itself lives in the environment, never in settings, exactly as a model's `apiKeyEnv` does. Four tools reach the model: `dokploy_servers`, `dokploy_projects`, `dokploy_deploy`, `dokploy_status`.

Each server entry is `{ name, url, apiKeyEnv }`. Set the key as an environment variable of that name on the harness (in a container deployment, add it to the compose `environment:` block so it reaches the process), and name that variable in the server entry. A tool call fails with a clear message when the named variable is unset.

The tools resolve a server by its configured name and never take a URL or key from the model, so a prompt cannot point them at an arbitrary host. When several servers are configured and a tool is called without naming one, it refuses and lists the names rather than guessing — deploying to the wrong server is worse than not deploying.

## Model Experience

- `dokploy_servers` — the configured servers by name and URL; keys are never shown.
- `dokploy_projects` — a server's projects with the applications inside each, including the application id a deploy needs.
- `dokploy_deploy` — start a deployment of one application by id. This is a real deploy.
- `dokploy_status` — the current state of one application by id.

Each tool takes an optional `server`, needed only when more than one is configured.

## Known Limitations and Deferred Work

- **Endpoint names track Dokploy's API** (`project.all`, `application.deploy`, `application.one`). A Dokploy version that renames these surfaces the raw error status; the tool text carries Dokploy's own message so the mismatch is visible.
- **No confirmation gate on deploy.** The tool triggers a deployment directly; put the agent behind an approval preset if a spend or an outage would matter.
- **Read-then-act.** There is no single "deploy by name" tool; the model lists projects to find an id, then deploys it, so it acts on something it has seen.
