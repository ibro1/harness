import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
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

function formatPrompt(messages, system) {
  let promptParts = []
  let attachedFiles = []

  if (system) {
    promptParts.push(`[System Instructions]\n${system}\n`)
  }

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

      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        })

        const proc = spawn('opencode', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: ENV,
        })

        let usage = null
        let emittedText = false

        proc.stderr.on('data', d => {
          console.error('[OpenCode stderr]', d.toString())
        })

        const rl = createInterface({ input: proc.stdout })
        rl.on('line', line => {
          if (!line.trim()) return
          try {
            const parsed = JSON.parse(line)
            if (parsed.type === 'text' && parsed.part?.text) {
              const text = parsed.part.text
              emittedText = true
              const chunk = {
                id,
                object: 'chat.completion.chunk',
                created,
                model: requestedModel,
                choices: [{
                  index: 0,
                  delta: { content: text },
                  finish_reason: null,
                }],
              }
              res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            }
            if (parsed.type === 'step_finish' && parsed.part?.tokens) {
              usage = parsed.part.tokens
            }
          } catch (e) {
            // ignore non-json
          }
        })

        proc.on('close', code => {
          console.log(`[OpenCode proc closed] code=${code} emittedText=${emittedText}`)
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
            ...(usage ? {
              usage: {
                prompt_tokens: usage.input || 0,
                completion_tokens: usage.output || 0,
                total_tokens: usage.total || 0,
              },
            } : {}),
          }
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
          cleanupFiles()
        })

        proc.on('error', err => {
          console.error('OpenCode process error:', err)
          res.write(`data: {"error": {"message": ${JSON.stringify(String(err))}}}\n\n`)
          res.end()
          cleanupFiles()
        })

        res.on('close', () => {
          if (!res.writableEnded && !proc.killed) {
            console.log('[OpenCode] Client disconnected, killing process')
            proc.kill()
          }
        })
      } else {
        const proc = spawn('opencode', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: ENV,
        })

        let fullResponse = ''
        let usage = null

        const rl = createInterface({ input: proc.stdout })
        rl.on('line', line => {
          if (!line.trim()) return
          try {
            const parsed = JSON.parse(line)
            if (parsed.type === 'text' && parsed.part?.text) {
              fullResponse += parsed.part.text
            }
            if (parsed.type === 'step_finish' && parsed.part?.tokens) {
              usage = parsed.part.tokens
            }
          } catch (e) {}
        })

        proc.on('close', code => {
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
            usage: {
              prompt_tokens: usage?.input || 0,
              completion_tokens: usage?.output || 0,
              total_tokens: usage?.total || 0,
            },
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

server.listen(PORT, HOST, () => {
  console.log(`OpenCode OpenAI-compatible bridge listening on http://${HOST}:${PORT}`)
})
