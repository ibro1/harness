---
description: "Postgres access: a settings-configured roster of databases and the agent tools that read from them, read-only unless an entry says otherwise."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-postgres

## Summary

Lets an agent answer questions about a database itself. An agent that can deploy an app, read its logs and edit its code still cannot say how many rows are in a table or why a job is stuck; until now the answer was a SQL statement handed to a human to paste into a terminal. Databases are configured in the `postgres` user-settings namespace — one entry per database, edited in the settings UI the same way models are. Four tools reach the model: `postgres_databases`, `postgres_query`, `postgres_execute`, `postgres_tables`.

Each entry is `{ name, ... }` plus one of two ways to give its connection string: `dsnEnv` names an environment variable holding the DSN (kept out of settings; in a container, add that variable to the compose `environment:` block so it reaches the process), or `dsn` carries the connection string inline (simpler, but stored in settings and shown in the card). A tool call fails with a message naming what to set when neither resolves. Two further fields carry defaults: `readOnly` defaults to `true`, and `statementTimeoutMs` defaults to `15000`.

Composition config sets the output caps and the optional command route: `maxRows` (default 200), `maxOutputBytes` (default 64000), and `path` plus `token` for the token-guarded MCP route, which stays unmounted while `token` is empty.

## Safety model

- **Read-only is enforced by the server.** `postgres_query` reserves a connection, issues `BEGIN READ ONLY`, sets `statement_timeout` with `SET LOCAL`, runs the statement, and issues `ROLLBACK`. A write anywhere in the statement — including one buried in a CTE — is refused by the backend. There is no statement allowlist parsed in JavaScript, because a regexp over SQL text is trivially defeated and would read as a guarantee it cannot keep.
- **Writes need an explicit settings change.** `postgres_execute` refuses unless that entry sets `readOnly` to `false`, and its refusal names the entry and the field. Its description tells the model it can destroy data; the statement is committed and there is no undo.
- **The DSN never reaches the model.** Tools take a database *name*, never a URL, host, user or password, so a prompt cannot point them at another server. `postgres_databases` prints only names and the read-only flag — not the host, not the environment-variable name.
- **Results are capped.** At most `maxRows` rows are rendered, within `maxOutputBytes`; when anything is left out the text says how many rows actually matched, so the model narrows the query instead of believing it saw everything.

## Model Experience

- `postgres_databases` — the configured databases by name, each marked read-only or writes-allowed. Connection strings are never shown. No parameters.
- `postgres_query` — `statement`, plus an optional `database`. Runs inside a rolled-back read-only transaction and returns an aligned text table. `NULL` renders as the word, so it is distinguishable from an empty string.
- `postgres_execute` — `statement`, plus an optional `database`. Commits, and reports the affected row count. Refused on a read-only entry.
- `postgres_tables` — an optional `schema` (default `public`) and an optional `database`. Lists tables with a row estimate from `pg_class.reltuples` and a total size, so the model orients itself without a single `count(*)`.

Token cost is bounded by the rendered table, not by the result set: a query matching forty thousand rows costs the same context as one matching two hundred, plus one line saying so. The rendered table changes with the data, so it is not KV-cache stable across turns.

## Known Limitations and Deferred Work

- **The row cap is applied after the fetch.** An arbitrary statement cannot be wrapped in a `LIMIT` without changing its meaning (`EXPLAIN`, `SHOW`, a statement with its own `LIMIT`), so all matching rows cross the wire and only the rendered table is capped. A query over a very large table still costs the harness memory, even though it costs the model nothing; `statement_timeout` is the backstop.
- **One pool per configured name, replaced when its DSN changes.** A DSN edited in settings takes effect on the next call, which ends the previous pool. In-flight statements on the replaced pool are not awaited.
- **No schema introspection beyond table names.** Column types, indexes and constraints are reachable only by querying `information_schema` through `postgres_query`.
- **No per-statement approval gate.** `postgres_execute` runs directly once an entry allows writes; put the agent behind an approval preset where a destructive statement would matter.
