# Harness Browser Bridge (Chrome extension)

Lets a self-hosted DeepSeek Harness drive the browser you are sitting in front
of. The harness cannot reach your machine — it is behind NAT, on a laptop, on a
corporate network — so this extension dials *out* to the harness and holds one
WebSocket open. Agent tools then travel down that socket as commands, and the
extension executes them in your active tab.

Plain JavaScript, no build step. Load it unpacked and it runs.

## What it can do

| Command    | Payload                                        | Handled by |
| ---------- | ---------------------------------------------- | ---------- |
| `navigate` | `{ url }`                                      | background |
| `wait`     | `{ ms? }`                                      | background |
| `snapshot` | `{ full? }`                                    | content    |
| `click`    | `{ ref }`                                      | content    |
| `type`     | `{ ref, text, submit? }`                       | content    |
| `scroll`   | `{ direction: "up" \| "down", amount? }`       | content    |

`navigate` and `wait` are about the tab and the clock, so the service worker
runs them itself. Everything else is relayed to the content script in the active
tab, which owns the document and the `ref` numbering that `snapshot` hands out.

## Setting up the harness side

The bridge lives on the harness's existing web server rather than a port of its
own, so it is reachable at the same origin you already trust:

```
wss://<your harness host>/browser-bridge
```

Two environment variables configure it (see `deploy/plugins/browser.cordis.yml`):

- `DSH_BROWSER_BRIDGE_TOKEN` — **required**. The shared secret. The bridge
  refuses to start without one, and destroys any connection presenting the wrong
  value without a response.
- `DSH_BROWSER_BRIDGE_PATH` — optional, defaults to `/browser-bridge`.

Generate a token and put it in your deployment's environment (in Dokploy:
Application → Environment), alongside the other `DSH_*` values in
`deploy/.env.example`:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Avoid `$` in the value: Compose expands `$name` inside a `.env` value and would
eat part of it.

**The token is a full remote-control credential for your browser.** Anyone
holding it and able to reach the endpoint can drive whatever tab you have open,
with your cookies and your sessions. Treat it like a password, never commit it,
and rotate it by changing the env var and re-saving it in the extension.

## Installing the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this directory
   (`deploy/browser-extension/`).
4. Click the extension's icon in the toolbar, then **Settings** (or use
   **Details → Extension options**).
5. Enter the **Bridge URL** (`wss://your-harness-host/browser-bridge`) and the
   **Token** (the `DSH_BROWSER_BRIDGE_TOKEN` value), then **Save**.
6. The popup should show **Connected**. The harness logs
   `browser-bridge: extension connected` at the same moment.

Use `ws://` only for a harness on `localhost`; anywhere else the token would
cross the network in the clear.

The extension reconnects on its own — on browser start, after a harness
redeploy, and after a dropped network — with exponential backoff capped at 30
seconds. **Reconnect** in the popup skips the wait.

## Permissions, and why each one is needed

| Permission                | Why |
| ------------------------- | --- |
| `storage`                 | Holds the bridge URL, the token, and the connection status the popup renders. All in this browser profile; nothing is sent anywhere except the token, to the bridge URL you configured. |
| `tabs`                    | Finds the active tab and reads its URL and title. Needed because commands act on "the tab in front of you", and because `navigate` must wait for that tab to finish loading. |
| `scripting`               | Injects `content.js` into a tab that was already open when the extension was installed or reloaded, where the manifest's content script never ran. Only used after a message to that tab reports no listener. |
| `activeTab`               | Grants access to the tab the user is on when they invoke the extension from its toolbar button, without a separate prompt. |
| `alarms`                  | An MV3 service worker is torn down after about 30 seconds idle. A periodic alarm wakes it back up so a dropped socket is re-dialled even while you are not touching the browser. Without it the bridge would stay down until you clicked something. |
| `host_permissions: <all_urls>` | The harness may be asked to drive any site. Chrome has no way to express "whatever page the agent is sent to", so the content script is registered for all `http`/`https` pages. It does nothing until a command arrives. |

The extension never runs on `chrome://` pages, the Web Store, or other
restricted origins — Chrome forbids content scripts there, and a command aimed
at such a tab fails with a message saying so rather than silently doing nothing.

## Files

| File            | Role |
| --------------- | ---- |
| `manifest.json` | MV3 manifest: permissions, service worker, content script, options page, popup. |
| `background.js` | The service worker. Owns the socket, the backoff, the keepalive, command dispatch, and the reply-exactly-once rule. |
| `content.js`    | Runs in the page. Owns `snapshot`, `click`, `type` and `scroll`, and the `ref` numbering they share. Maintained separately from the files above. |
| `options.html` / `options.js` | Settings: bridge URL, token, status, reconnect. |
| `popup.html` / `popup.js`     | Toolbar popup: connection state and a reconnect button. |

## Wire protocol

Fixed, and mirrored from `packages/host/browser-bridge/src/index.ts`. The
harness sends:

```json
{ "id": "<uuid>", "type": "navigate", "payload": { "url": "https://example.com" } }
```

The extension replies **exactly once per id**, with either:

```json
{ "id": "<uuid>", "result": "Navigated to https://example.com/ (Example Domain)" }
```

`result` is the text an agent reads. Every command answers with a string —
a summary for `navigate` and `wait`, the rendered page for `snapshot` — because
the harness tool layer surfaces the reply to a model, and a record of tab ids
and internal counters is not something the model can act on.

or:

```json
{ "id": "<uuid>", "error": "the active tab (chrome://settings) is not a web page the extension can read; switch to an http or https tab" }
```

Exactly once matters in both directions. The harness correlates replies by id
and settles the waiting tool call on the first one, so a second reply for the
same id would be discarded at best and would settle an unrelated call at worst.
A repeated id arriving from the harness is therefore dropped rather than run
twice, and every failure path — a bad payload, a missing content script, a tab
that never loads — produces an error frame rather than silence. A command that
outlives 25 seconds is failed by the extension, just under the harness's own
30-second timeout, so you get a specific message instead of a generic one.

The extension also sends `{"type":"ping"}` about every 20 seconds. It carries no
`id`, so the harness ignores it; its only job is to keep the MV3 service worker's
idle timer from expiring mid-session.

## Troubleshooting

**Popup says Disconnected, "the connection dropped".** The harness is
unreachable or the token is wrong. The server destroys the socket without a
response when the token does not match, so a bad token and an unreachable host
look identical from here — check the URL in a browser tab first, then re-copy
the token.

**"no browser is connected" from an agent tool.** The extension is not
connected. Open the popup; if it says Disconnected, press Reconnect.

**"the active tab … is not a web page the extension can read".** The agent is
pointed at a `chrome://` page, the Web Store, a PDF viewer, or a blank tab.
Switch to an ordinary page.

**Commands work, then stop after a while.** Check that the alarm survived: open
`chrome://extensions`, click **service worker** under this extension, and
confirm the console shows it waking. Reloading the extension re-creates the
alarm.

**Nothing happens after a harness redeploy.** The socket closes and the backoff
restarts; the extension reconnects within 30 seconds. Press Reconnect to skip
the wait.
