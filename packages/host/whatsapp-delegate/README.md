---
description: "Fork-local WhatsApp delegate: answers the owner's listed work contacts on WhatsApp as the owner, with one long-lived Session per contact that triages, fixes, deploys and replies, and holds anything that commits the owner for his approval."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-whatsapp-delegate

## Summary

An employee that looks after the owner's work contacts on WhatsApp as he would. It reads each listed contact's chats, waits for a burst of messages to go quiet, and hands it to that contact's long-lived Session in the contact's project. The Session triages (work, greeting, personal), reproduces and fixes reported bugs, runs the project's checks, commits without AI attribution, pushes to the deploy branch, checks the live site, and replies in the owner's voice. Routine replies go out at once; prices, dates, scope, promises, apologies and anything uncertain wait for the owner's "ok".

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The web-app bundle inserts it when `DSH_DEPLOY=1` (`DSH_WHATSAPP_DELEGATE=0` leaves it out). It reads and sends nothing until it is switched on at **Plugins → WhatsApp delegate** with at least one contact. Each contact is a form: name, the WhatsApp numbers they write from, who they are (relationship, tone, language), the project folder on the server, its repository, the branch that deploys and the live address, an on switch, and "Ignore completely". The owner's own number goes in **Your WhatsApp number**: drafts, digests and his answers travel there.

The owner answers a draft in that chat with `ok 7`, `edit 7: his text` or `no 7`, or with **Send**, **Edit** and **Don't send** on the card. `pause delegate` and `resume delegate` there switch everything off and on; `@Name instruction` hands an instruction to that contact's Session. **Pause everything** on the card does the same as the first.

Only listed contacts are ever read or answered, and the only other chat the delegate writes to is the owner's. When the owner types in a contact's chat himself after the contact's latest message, that batch is left to him, and the delegate stays out of the conversation for `ownerActiveMinutes` (default 10). Switched off or paused, it forgets its read positions, so switching back on starts from new messages and a backlog is never answered.

Each contact has one Session (id `wad-<contact id>-<uuid>`, titled `WhatsApp: <name>`) in its project folder, under the `danger-full-access` permission preset by default so it can edit, run checks and push unattended. It follows the `whatsapp-delegate` skill (`deploy/skills/whatsapp-delegate/`). Tools, on `wad-` Sessions only and to agy and opencode over `deploy/mcp/wad-mcp.mjs` (the route lists them to delegate Sessions only):

| Tool | What it does and refuses |
|---|---|
| `delegate_reply` | `routine` sends now; `needs_approval` queues a numbered draft and asks the owner. Refused when paused, for text with a secret (key and token formats, connection-string passwords, secret settings, long key-like strings, or any value of the server's secret environment variables), for text already sent to the contact in the last six hours or already waiting, and past `maxReplies` messages in `rateWindowMinutes`. Long text is split at paragraph and sentence boundaries into `maxReplyChars` messages |
| `delegate_no_reply` | records that the batch needs no reply; `tell_owner` puts it in the digest |
| `delegate_tell_owner` | collected into the batch's digest, or sent at once with `urgent` |
| `delegate_history` | the contact's recent messages, both directions, with ids |

`delegate_*` and the WhatsApp plugin's tools are separate: `wad-` Sessions are refused `whatsapp_send` and `whatsapp_approve` (natively by this plugin, over MCP by the WhatsApp plugin, which reads the CLI's session id), and the DeerFlow browser.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

State is one JSON file, `<DSH home>/whatsapp-delegate/state.json` (mode 0600), replaced atomically with writes serialized: per contact the read cursor of each chat (the WhatsApp service's row id), the queue, the Session id, the owner's latest typed message, the chat the contact last wrote from, the answered row ids, and notes for the next batch; plus the batches (open and the last 100), the delegate's sends (last 500), the drafts and their numbers, the owner chat's cursor, and a 300-line activity log. Pictures and files from contacts are saved under `media/<contact id>/`.

`engine.ts` runs one round every `pollSeconds` (default 20). It reads each chat with `whatsapp_read` after its cursor (the first look starts after the latest message), queues the contact's rows and the owner's own typed rows, and skips rows sent through the WhatsApp service. `planBatch` hands the queue over once the contact has been quiet for `quietSeconds` (90) or `maxWaitSeconds` (240) after the first message, unless the owner answered after the contact's latest message or typed within `ownerActiveMinutes`. Voice notes are downloaded (`whatsapp_media`) and transcribed with Groq Whisper (`transcriptionModel`, the card's key, else `GROQ_API_KEY`); pictures, videos and documents are saved for the Session to open. The batch prompt carries the new messages with ids, the last `contextMessages` (30) messages of the contact's chats, the contact notes and project, the local time in `timeZone` (Africa/Lagos), the drafts waiting and the owner's decisions since the last batch. An idle Session gets it as a follow-up, a running one as steering, an unloaded one is resumed through the Session controller, and a missing one is replaced by a new Session.

When the Session goes idle its open batches close and the owner gets one digest (what they wrote, what was replied, drafts waiting, notes, messages left unanswered with `tell_owner`), unless the batch only closed a conversation. A restart marks open batches interrupted and puts one that had no decision back in the queue once. A draft is claimed before it is sent, so a second `ok` cannot send it twice.

The WhatsApp sidecar (`deploy/whatsapp-svc`) stores message ids, kinds (text, audio, image, video, document, sticker) with captions or placeholders, reply targets and the media reference, addresses LID chats by phone number when WhatsApp gives it, records its own sends as `via_api` rows (left out of reads unless `include_sent`), reads after a row id oldest first, downloads media (`/media`, up to 32 MB), and sends replies that quote a stored message. The routes `GET <path>/status` and `POST <path>/action` (pause, resume, poll, approve, edit, reject) are signed-in only; `<path>/command` takes the `DSH_WAD_TOKEN` bearer token.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Batch prompts

#### What the model sees

Each batch is one user message with the source `whatsapp-delegate`: the new messages as `[m<id> <time>] <who>: <text>` lines with transcripts and saved file paths, earlier chat lines, the contact's notes and project, drafts waiting and the owner's decisions. The first message of a Session points to the skill file.

#### Token effect

About 30 context lines plus the new messages per batch; `contextMessages` sets the context.

#### KV Cache effect

Batches append to one long-lived Session, so earlier turns stay cached; compaction applies as for any Session.

### Delegate tools

#### What the model sees

Four `delegate_*` tools on `wad-` Sessions only. Each answers in one text block; a refusal is a tool error saying why.

#### Token effect

The schemas ride every request of the Session; `delegate_history` returns at most 200 lines.

#### KV Cache effect

The tool set is fixed for a Session's life, so the prefix stays cacheable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Project access is the server's.** A contact's project folder must be a checkout on the harness server whose git remote the server can push to; the delegate does not clone or hold credentials of its own.
- **WhatsApp keeps media for a limited time.** A voice note or picture read long after it arrived can fail to download; the prompt then says it could not be read.
- **LID-only chats.** When WhatsApp addresses a contact by LID and the linked account has no phone number for it, the chat is stored under the LID; that LID must be added to the contact's numbers.
- **No delivery receipts.** A reply counts as sent when the WhatsApp service accepts it.
- **Runtime invariant:** No companion is published; the state file is the only record and nothing else observes it independently.
