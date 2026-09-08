// Background-job completion notifier.
//
// The agy/opencode CLIs run synchronously per turn and have no way to be told
// when a detached job finishes — so a long render or a big TTS batch either
// blocks the turn or makes the agent spin emitting "waiting…". This gives them
// the missing piece: a loopback route a finished job pings, which wakes the
// originating session into a fresh turn (agent.followup) so the agent reports
// the result and hands the user a download link.
//
// The agent launches work like:
//   nohup sh -c '<cmd>; curl -s -XPOST "$DSH_NOTIFY_URL&session=$DSH_SESSION_ID&label=render&exit=$?"' >/dev/null 2>&1 &
// then ends its turn. $DSH_NOTIFY_URL already carries the shared token; the
// route is loopback-only and authenticate:false, verified by that token — the
// caller is a process inside this container, not the browser, so the password
// gate does not apply (the browser-bridge command route works the same way).

import { readdir, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'bg-notify'
export const inject = ['webServer', 'sessions', 'agents']

export const Config = z.object({
  /** Absolute route path a finished background job POSTs to. */
  path: z.string().default('/bg-notify'),
})

/** Shared secret the finished job must present; set by the entrypoint. Empty
 *  disables the route (it answers 503) so a misconfigured deploy fails safe. */
const TOKEN = (process.env.DSH_BG_TOKEN ?? '').trim()
const PUBLIC_HOST = (process.env.DSH_PUBLIC_HOST ?? '').trim()

const MEDIA = new Set(['.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.m4a', '.ogg', '.png', '.jpg', '.jpeg', '.gif', '.webp'])

function announce(message) {
  process.stderr.write(`bg-notify: ${message}\n`)
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Newest media files under <cwd>/edit/, with a public download link each. */
async function outputsWithLinks(cwd, sessionId) {
  const dir = join(cwd, 'edit')
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const rows = []
  for (const entry of entries) {
    if (!entry.isFile() || !MEDIA.has(extname(entry.name).toLowerCase())) continue
    try {
      const s = await stat(join(dir, entry.name))
      const link = PUBLIC_HOST === ''
        ? `edit/${entry.name}`
        : `https://${PUBLIC_HOST}/workspace-download?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(`edit/${entry.name}`)}`
      rows.push({ name: entry.name, mtime: s.mtimeMs, link })
    } catch {
      // vanished between readdir and stat; skip
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime)
  return rows.slice(0, 8)
}

/** The user-message text the woken agent reads. Phrased as a notification with
 *  an explicit instruction to relay the result and the link(s). */
function notificationText(label, exit, rows) {
  const ok = exit === 0
  const head = ok
    ? `[background job] "${label}" finished successfully.`
    : `[background job] "${label}" exited with code ${exit}.`
  const files = rows.length > 0
    ? '\n\nOutputs in this session:\n' + rows.map(r => `- ${r.name} — ${r.link}`).join('\n')
    : '\n\n(No media files found in edit/.)'
  return `${head}${files}\n\nTell the user this job is done and give them the download link(s) above. Do not re-run the job.`
}

export function apply(ctx, config) {
  if (TOKEN === '') {
    announce('DSH_BG_TOKEN unset — background notify route disabled')
  } else {
    announce(`notify route ${config.path} (loopback + token)`)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: config.path,
    // Called by a process inside the container (not the browser), so it is not
    // behind the password gate; the shared token + loopback are its auth.
    authenticate: false,
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { json(res, 405, { error: 'use POST' }); return }
        if (TOKEN === '') { json(res, 503, { error: 'DSH_BG_TOKEN not configured' }); return }

        const remote = req.socket?.remoteAddress ?? ''
        const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
        if (!loopback) { json(res, 403, { error: 'loopback only' }); return }

        const url = new URL(req.url ?? '/', 'http://x')
        if (url.searchParams.get('token') !== TOKEN) { json(res, 401, { error: 'bad token' }); return }

        const sessionId = url.searchParams.get('session') ?? ''
        const label = (url.searchParams.get('label') ?? 'job').slice(0, 80)
        const exit = Number.parseInt(url.searchParams.get('exit') ?? '0', 10) || 0
        if (sessionId === '') { json(res, 400, { error: 'missing ?session' }); return }

        const cwd = ctx.sessions.get(sessionId)?.header?.cwd
        const rows = typeof cwd === 'string' && cwd !== '' ? await outputsWithLinks(cwd, sessionId) : []

        // Build the message the same way the browser prompt path does, then wake
        // the session with a fresh follow-up turn. Lazy import so a resolution
        // problem degrades to a logged no-op instead of failing plugin boot.
        const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
        const found = await ctx.agents.resolveAgent(sessionId)
        if ('error' in found) {
          announce(`cannot wake session ${sessionId}: ${String(found.error?.message ?? found.error)}`)
          json(res, 202, { accepted: false, reason: 'session unavailable' })
          return
        }
        const message = createUserMessage({
          content: [{ type: 'text', text: notificationText(label, exit, rows) }],
          source: { kind: 'user' },
        })
        found.agent.followup(message)
        announce(`woke session ${sessionId} for job "${label}" (exit ${exit}, ${rows.length} file(s))`)
        json(res, 200, { accepted: true })
      } catch (error) {
        announce(`notify failed: ${String(error)}`)
        // Never fail the job's own curl over a notify problem.
        if (!res.headersSent) json(res, 500, { error: String(error) })
      }
    },
  }), 'bg-notify: completion notify route')
}
