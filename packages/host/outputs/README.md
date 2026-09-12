---
description: "Session outputs: the `<cwd>/.outputs` delivery directory, the `ctx.outputs` service that publishes into it, and the `publish_output` agent tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-outputs

## Summary

One place a skill or a plugin puts a finished file so the person who asked for it can get it. The convention is `<cwd>/.outputs`: the outputs directory is inside the session working directory, so it inherits whatever the workspace already guarantees about lifetime and permissions, and a session's deliverables travel with the session rather than with the skill that made them.

The package registers `ctx.outputs`, a service with three methods:

```ts
interface PublishedOutput {
  /** File name inside the outputs directory. */
  name: string
  /** Path relative to the session cwd, e.g. `.outputs/report.png`. */
  rel: string
  bytes: number
  mtime: number
  /** Optional human label the publisher supplied. */
  label?: string
}

interface SessionOutputs {
  /** Where a session's published outputs live: `<cwd>/.outputs`. */
  dir(cwd: string): string
  /** Copy a finished file into the session's outputs directory. */
  publish(cwd: string, absPath: string, label?: string): Promise<PublishedOutput>
  /** What has been published for this session, newest first. */
  list(cwd: string): Promise<PublishedOutput[]>
}
```

`name` is the name actually used inside the directory, which is not always the source basename. Every method takes the cwd explicitly: the service has no ambient notion of "the current session", so a caller stays responsible for reading an authoritative cwd. The agent tool reads it from the session store (`ctx.sessions.get(agent.session.id)?.header.cwd`) and never from a path the model supplied.

### Why one convention beats an allowlist

The composer's "Session outputs" drawer lists one hardcoded directory, `<cwd>/edit/` — the convention of the first skill that needed somewhere to write. A second skill rendering into its own directory produces files the drawer cannot see: correct output, on disk, invisible, with the drawer still showing a stale file from an earlier session. The two available fixes are to teach the drawer every skill's private directory, or to give every skill one directory that means delivered. An allowlist grows with every skill, is edited in a different package from the skill that needs it, and silently omits any skill whose author did not know the list existed; `.outputs` needs no edit at all, and `edit/` goes back to meaning what it says — a scratch directory one skill edits in — instead of doubling as a delivery channel for skills that never edit anything.

The consumer is [`deploy/plugins/composer-tools.mjs`](../../../deploy/plugins/composer-tools.mjs), which lists `.outputs` alongside `edit/` in the drawer and streams both through its existing download route. That wiring is one line there and is not owned by this package.

### Publishing semantics

- **Copy, never move and never symlink.** The producer may still be working on the file, and a symlink into a temp directory is a dead link an hour later. The original stays exactly where it was written.
- **Containment is checked after resolution, not by string prefix.** The cwd and the source are both canonicalised with `realpath`, then compared with `path.relative`, so neither a `../../` segment nor a symlink pointing out of the workspace can publish a file the session does not own. `allowOutsideCwd` turns the check off for a deployment that needs it; it is false by default.
- **A name collision suffixes, never overwrites.** `report.png`, then `report-2.png`, then `report-3.png`. The copy uses `COPYFILE_EXCL`, so the check and the write are one operation and two concurrent publishes cannot clobber each other. The returned `name` is the one actually used.
- **A refused publish copies nothing.** Both byte caps are checked before the copy begins and the failure names the size and the limit, rather than leaving a truncated file behind.
- **A label is data.** It is stripped of control characters, bounded, and stored in a `.labels.json` sidecar keyed by file name. It never influences the file name, which comes from the source basename reduced to `[A-Za-z0-9._-]` with no leading dot.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxFileBytes` | 512 MiB | Largest single file that may be published. |
| `maxTotalBytes` | 2 GiB | Largest total size of one session's outputs directory. |
| `allowOutsideCwd` | `false` | Whether a file outside the session cwd may be published. |

The directory name is not configurable. Its value is that it is the same everywhere: a consumer that must ask which name a deployment chose is back to keeping a list.

## Model Experience

- `publish_output` — one tool, registered per agent. Parameters: `path` (required; the finished file, absolute or relative to the session working directory) and `label` (optional; a short description shown beside the file).

The description tells the model the thing that is not otherwise visible to it: writing a file somewhere in the workspace does not deliver it, only published files reach the person who asked. The result names the `.outputs/` path, the size, and — when the name was taken — the name the file was actually published under, so the model can refer to it afterwards.

Token cost is one small tool definition per agent and one short text result per call; nothing is added to the system prompt, and nothing about the outputs directory is injected into context, so the KV cache prefix is unaffected.

## Known Limitations and Deferred Work

- **The label sidecar is last-writer-wins.** Two publishes racing in one session rewrite `.labels.json` whole, so a label can be lost. A lost label costs a caption, never a file; the files themselves are the record, and `list` reports a file with no label rather than hiding it.
- **Nothing unpublishes.** There is no `remove` and no retention policy: the outputs directory grows until the session's workspace goes away, and `maxTotalBytes` is the only backstop. A deployment that keeps workspaces indefinitely will want a sweeper.
- **The total-bytes cap is per session, computed by listing.** It costs one `readdir` plus a `stat` per published file on every publish, which is fine at drawer scale and wrong for a session that publishes thousands of files.
- **No command route.** `buildOutputTools()` is exported so one definition can serve both the per-agent registry and an MCP-style command route, but no route is mounted: a route would have to resolve a session id to a cwd itself, and no caller needs that yet.
