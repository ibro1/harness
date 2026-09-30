import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { watchRun } from './bridge-watchdog.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs'

const PORT = 8002
const HOST = '127.0.0.1'
const OPENCODE_PATH = join(homedir(), '.opencode', 'bin')
const ENV = { ...process.env, PATH: `${OPENCODE_PATH}:${process.env.PATH || ''}` }

const OPENCODE_MODELS = [
  { id: 'big-pickle', name: 'Big Pickle (Free)', context_window: 131072, max_tokens: 16384 },
  { id: 'ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin (Free)', context_window: 131072, max_tokens: 16384 },
  { id: 'mimo-v2.5-free', name: 'Mimo v2.5 (Free)', context_window: 131072, max_tokens: 16384 },
  { id: 'muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2 (Free)', context_window: 131072, max_tokens: 16384 },
  { id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 (Free)', context_window: 131072, max_tokens: 16384 },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra (Free)', context_window: 131072, max_tokens: 16384 },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning (Free)', context_window: 131072, max_tokens: 16384 },
]

/**
 * Models this bridge advertises. The boot-time sync writes what the CLI
 * actually serves; the constant below is only the floor when that file is
 * missing or unreadable, so the list is never hand-maintained in two places.
 */
/** Header the llm-pi-ai provider's `sessionHeader` names; lower-case, as Node delivers it. */
const SESSION_HEADER = (process.env.DSH_BRIDGE_SESSION_HEADER || 'x-dsh-session-id').toLowerCase()

/**
 * The calling harness session's id, from the session header, or from a body
 * field for a client that sends it there; undefined when neither is present.
 */
function sessionIdOf(req, body) {
  const header = req.headers[SESSION_HEADER]
  if (typeof header === 'string' && header !== '') return header
  return body.sessionId !== undefined ? String(body.sessionId) : undefined
}

function catalogueModels(provider, fallback) {
  try {
    const path = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.model-catalogue.json')
    const rows = JSON.parse(readFileSync(path, 'utf8'))[provider]
    if (Array.isArray(rows) && rows.length > 0) {
      return rows.map(row => ({
        id: row.id,
        name: row.name || row.id,
        context_window: row.contextWindow || 131072,
        max_tokens: row.maxTokens || 16384,
      }))
    }
  } catch {
    // No catalogue yet (first boot, or the CLI never answered): the constant stands.
  }
  return fallback
}

function saveBase64Image(dataUrl) {
  try {
    let ext = 'png'
    let base64Data = dataUrl
    if (dataUrl.startsWith('data:')) {
      const parts = dataUrl.split(';base64,')
      const mime = parts[0].replace('data:', '')
      if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg'
      else if (mime.includes('webp')) ext = 'webp'
      else if (mime.includes('gif')) ext = 'gif'
      base64Data = parts[1]
    }
    const filename = `/tmp/dsh_oc_img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
    writeFileSync(filename, Buffer.from(base64Data, 'base64'))
    return filename
  } catch (err) {
    console.error('Error saving base64 image:', err)
    return null
  }
}

/**
 * How opencode should work inside the harness, appended after the harness's
 * own system prompt. Measured on a local run: without it, a Lead that spawned
 * a teammate spent a dozen shell steps searching for the reply, because a
 * teammate's message reaches the Lead only when the harness starts its next
 * step, which for opencode is after this reply ends.
 */
const BRIDGE_NOTES = `[Bridge Notes]
You are running inside DeepSeek Harness through a bridge. The harness's tools are MCP tools whose names start with "dsh-" (for example dsh-agent-tools_spawn_teammate); call them directly. Do not inspect the harness itself (its source, logs, session files or processes) to find or work around a tool.
Messages from teammates are delivered by the harness after you finish this reply. When wait_agent reports a mailbox change, or you are waiting for a teammate's answer, end your reply with a one-line status; the message arrives as your next input.
`

function formatPrompt(messages, system) {
  let promptParts = []
  let attachedFiles = []

  if (system) {
    promptParts.push(`[System Instructions]\n${system}\n`)
  }
  if (process.env.OPENCODE_BRIDGE_NOTES !== '0') promptParts.push(BRIDGE_NOTES)

  for (const msg of messages) {
    const role = msg.role || 'user'
    let contentParts = []

    if (typeof msg.content === 'string') {
      contentParts.push(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'string') {
          contentParts.push(block)
        } else if (block.type === 'text') {
          contentParts.push(block.text)
        } else if (block.type === 'image_url' && block.image_url?.url) {
          const imgPath = saveBase64Image(block.image_url.url)
          if (imgPath) attachedFiles.push(imgPath)
        } else if (block.type === 'image' && block.source?.data) {
          const imgPath = saveBase64Image(`data:${block.source.media_type || 'image/png'};base64,${block.source.data}`)
          if (imgPath) attachedFiles.push(imgPath)
        } else {
          contentParts.push(JSON.stringify(block))
        }
      }
    }

    const content = contentParts.join('\n')

    if (role === 'system') {
      promptParts.push(`[System]\n${content}\n`)
    } else if (role === 'user') {
      promptParts.push(`[User]\n${content}\n`)
    } else if (role === 'assistant') {
      promptParts.push(`[Assistant]\n${content}\n`)
    } else if (role === 'tool') {
      promptParts.push(`[Tool Result for ${msg.name || msg.tool_call_id || 'tool'}]\n${content}\n`)
    }
  }

  return { prompt: promptParts.join('\n'), attachedFiles }
}

/**
 * opencode's step tokens as an OpenAI usage block. The harness reads
 * `prompt_tokens` as the size of the context the model was given and checks it
 * against the model's window, so it carries the latest call's input, with its
 * cached share in `prompt_tokens_details`; a run's internal steps summed would
 * report a context several times larger than any the model saw.
 * `completion_tokens` sums the output of every step.
 */
function openAiUsage(usage) {
  const prompt = usage?.lastPrompt ?? 0
  const completion = usage?.output ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: usage?.lastCached ?? 0 },
  }
}

function briefParams(input) {
  if (!input || typeof input !== 'object') return ''
  const salient = input.command ?? input.filePath ?? input.file_path ?? input.path
    ?? input.pattern ?? input.url ?? input.query ?? input.description
  let s = salient !== undefined ? String(salient) : JSON.stringify(input)
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > 140 ? s.slice(0, 137) + '…' : s
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    const data = {
      object: 'list',
      data: catalogueModels('opencode', OPENCODE_MODELS).map(m => ({
        id: m.id,
        object: 'model',
        created: 1700000000,
        owned_by: 'opencode',
        permission: [],
        root: m.id,
        parent: null,
      })),
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
    return
  }

  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
    let bodyText = ''
    req.on('data', chunk => { bodyText += chunk })
    req.on('end', async () => {
      let body
      try {
        body = JSON.parse(bodyText)
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }))
        return
      }

      const requestedModel = body.model || 'mimo-v2.5-free'
      const opencodeModel = requestedModel.startsWith('opencode/') ? requestedModel : `opencode/${requestedModel}`
      const messages = body.messages || []
      const system = body.system || ''
      const stream = body.stream !== false
      const { prompt, attachedFiles } = formatPrompt(messages, system)

      const id = `chatcmpl-oc-${Date.now()}`
      const created = Math.floor(Date.now() / 1000)

      console.log(`[OpenCode] Start req model=${opencodeModel} stream=${stream} len=${prompt.length} files=${attachedFiles.length}`)

      const cleanupFiles = () => {
        setTimeout(() => {
          for (const f of attachedFiles) {
            try { unlinkSync(f) } catch {}
          }
        }, 60000)
      }

      const args = [
        'run', prompt,
        '-m', opencodeModel,
        '--auto',
        '--format', 'json',
      ]

      for (const f of attachedFiles) {
        args.push('-f', f)
      }

      // The originating session id arrives in the header the provider's
      // `sessionHeader` names (deploy/settings.seed.yaml sets it). Exposed to
      // the CLI as DSH_SESSION_ID, it reaches the MCP servers the CLI starts,
      // so session-scoped tools (outputs, capture, Agent Teams) act on THIS
      // session, a skill can link back to its workspace, and the
      // background-notify hook can wake it.
      const sessionId = sessionIdOf(req, body)
      console.log(`[OpenCode] session=${sessionId || '-'}`)
      const childEnv = sessionId !== undefined
        ? { ...ENV, DSH_SESSION_ID: sessionId }
        : ENV

      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        })

        const proc = spawn('opencode', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv,
        })

        let usage = null
        let emittedText = false
        let lastActivity = Date.now()
        const seenToolDone = new Set()

        const send = (delta) => {
          res.write(`data: ${JSON.stringify({
            id, object: 'chat.completion.chunk', created, model: requestedModel,
            choices: [{ index: 0, delta, finish_reason: null }],
          })}\n\n`)
          lastActivity = Date.now()
        }
        const sendContent = (text) => { emittedText = true; send({ content: text }) }
        // Tool activity/progress rides the reasoning channel — live "thinking"
        // that never pollutes the answer, and every one resets the harness idle
        // watchdog so a long tool-only phase no longer times out.
        const sendProgress = (text) => send({ reasoning_content: text })

        // Keep the stream warm through a quiet long-running tool so the idle
        // watchdog never fires mid-tool.
        const HEARTBEAT_MS = 40000
        const heartbeat = setInterval(() => {
          if (!res.writableEnded && Date.now() - lastActivity >= HEARTBEAT_MS) sendProgress('·')
        }, 10000)

        // opencode reports a failed run (a refused key, a locked state
        // database) as an `error` event or on stderr, and exits non-zero. Kept
        // here so a run that produced no text ends the stream with that error
        // instead of an empty answer the harness cannot tell from a real one.
        let failure = ''
        let stderrTail = ''
        const toolSteps = []
        const guard = watchRun(proc, 'opencode', () => toolSteps.at(-1), (reason) => {
          if (res.writableEnded) return
          clearInterval(heartbeat)
          res.write(`data: ${JSON.stringify({ error: { message: reason } })}\n\n`)
          res.end()
          cleanupFiles()
        })

        proc.stderr.on('data', d => {
          const text = d.toString()
          stderrTail = `${stderrTail}${text}`.slice(-2000)
          console.error('[OpenCode stderr]', text)
        })

        const rl = createInterface({ input: proc.stdout })
        rl.on('line', line => {
          if (!line.trim()) return
          lastActivity = Date.now()
          guard.touch()
          let parsed
          try { parsed = JSON.parse(line) } catch { return }

          if (parsed.type === 'text' && parsed.part?.text) {
            sendContent(parsed.part.text)
            return
          }
          if (parsed.type === 'error') {
            failure = parsed.error?.data?.message ?? parsed.error?.message ?? parsed.error?.name ?? 'opencode reported an error'
            return
          }
          // One step_finish per model call; a run with tool calls has several.
          if (parsed.type === 'step_finish' && parsed.part?.tokens) {
            const t = parsed.part.tokens
            usage = {
              input: (usage?.input ?? 0) + (t.input ?? 0),
              output: (usage?.output ?? 0) + (t.output ?? 0),
              total: (usage?.total ?? 0) + (t.total ?? 0),
              cacheRead: (usage?.cacheRead ?? 0) + (t.cache?.read ?? 0),
              cacheWrite: (usage?.cacheWrite ?? 0) + (t.cache?.write ?? 0),
              // The context the model saw on its latest call, which is what the
              // harness reads prompt_tokens as; the sums above are cost.
              lastPrompt: (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0),
              lastCached: t.cache?.read ?? 0,
            }
            return
          }
          // Tool activity → live progress. opencode emits one `tool_use` event
          // per call, when it has finished, with the arguments in
          // part.state.input and the outcome in part.state.status.
          if (parsed.type === 'tool_use' && parsed.part) {
            const p = parsed.part
            const callId = String(p.callID ?? p.id ?? '')
            if (seenToolDone.has(callId)) return
            seenToolDone.add(callId)
            const toolName = p.tool ?? 'tool'
            toolSteps.push(toolName)
            const brief = briefParams(p.state?.input)
            sendProgress(`\n🔧 ${toolName}${brief ? ` — ${brief}` : ''}${p.state?.status === 'error' ? ' ✗' : ' ✓'}`)
          }
        })

        proc.on('close', code => {
          clearInterval(heartbeat)
          guard.stop()
          const tokens = usage ? ` in=${usage.input + usage.cacheRead + usage.cacheWrite} cached=${usage.cacheRead} out=${usage.output} context=${usage.lastPrompt}` : ''
          console.log(`[OpenCode proc closed] code=${code} emittedText=${emittedText} tools=${toolSteps.length}${tokens}${toolSteps.length ? ` [${toolSteps.join(' ')}]` : ''}${failure ? ` error=${JSON.stringify(failure)}` : ''}`)
          if (guard.reason() !== undefined) return
          if (!emittedText && (failure !== '' || code !== 0)) {
            const reason = failure !== '' ? failure : stderrTail.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').filter(Boolean).slice(-2).join(' ') || `opencode exited with code ${String(code)}`
            res.write(`data: ${JSON.stringify({ error: { message: `opencode: ${reason}` } })}\n\n`)
            res.end()
            cleanupFiles()
            return
          }
          const finalChunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model: requestedModel,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'stop',
            }],
            ...(usage ? { usage: openAiUsage(usage) } : {}),
          }
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
          cleanupFiles()
        })

        proc.on('error', err => {
          clearInterval(heartbeat)
          guard.stop()
          console.error('OpenCode process error:', err)
          res.write(`data: {"error": {"message": ${JSON.stringify(String(err))}}}\n\n`)
          res.end()
          cleanupFiles()
        })

        res.on('close', () => {
          clearInterval(heartbeat)
          guard.stop()
          if (!res.writableEnded && !proc.killed) {
            console.log('[OpenCode] Client disconnected, killing process')
            proc.kill()
          }
        })
      } else {
        const proc = spawn('opencode', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv,
        })

        let fullResponse = ''
        let usage = null
        let failure = ''
        const guard = watchRun(proc, 'opencode', () => undefined, (reason) => {
          if (res.headersSent) return
          res.writeHead(504, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: reason } }))
          cleanupFiles()
        })

        const rl = createInterface({ input: proc.stdout })
        rl.on('line', line => {
          if (!line.trim()) return
          guard.touch()
          try {
            const parsed = JSON.parse(line)
            if (parsed.type === 'text' && parsed.part?.text) {
              fullResponse += parsed.part.text
            }
            if (parsed.type === 'error') {
              failure = parsed.error?.data?.message ?? parsed.error?.message ?? parsed.error?.name ?? 'opencode reported an error'
            }
            if (parsed.type === 'step_finish' && parsed.part?.tokens) {
              const t = parsed.part.tokens
              usage = {
                input: (usage?.input ?? 0) + (t.input ?? 0),
                output: (usage?.output ?? 0) + (t.output ?? 0),
                total: (usage?.total ?? 0) + (t.total ?? 0),
                cacheRead: (usage?.cacheRead ?? 0) + (t.cache?.read ?? 0),
                cacheWrite: (usage?.cacheWrite ?? 0) + (t.cache?.write ?? 0),
                // The context the model saw on its latest call, which is what the
                // harness reads prompt_tokens as; the sums above are cost.
                lastPrompt: (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0),
                lastCached: t.cache?.read ?? 0,
              }
            }
          } catch (e) {}
        })

        proc.on('close', code => {
          guard.stop()
          if (guard.reason() !== undefined) return
          if (fullResponse === '' && (failure !== '' || code !== 0)) {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: `opencode: ${failure !== '' ? failure : `exited with code ${String(code)}`}` } }))
            cleanupFiles()
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id,
            object: 'chat.completion',
            created,
            model: requestedModel,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: fullResponse },
              finish_reason: 'stop',
            }],
            usage: openAiUsage(usage),
          }))
          cleanupFiles()
        })
      }
    })
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'Not found' } }))
})

// opencode creates its state database on first use, and two runs starting
// together on a fresh home both fail with "database is locked" while it does.
// One listing run before the first request creates it; the boot-time model
// sync does the same, but the bridge does not rely on that ordering.
try {
  spawnSync('opencode', ['models'], { env: ENV, stdio: 'ignore', timeout: 60_000 })
} catch (error) {
  console.error('[OpenCode] warm-up failed:', error)
}

server.listen(PORT, HOST, () => {
  console.log(`OpenCode OpenAI-compatible bridge listening on http://${HOST}:${PORT}`)
})
