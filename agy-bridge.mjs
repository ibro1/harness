import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const PORT = 8001
const HOST = '127.0.0.1'

const AGY_MODELS = [
  { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)', context_window: 1048576, max_tokens: 65536 },
  { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)', context_window: 1048576, max_tokens: 65536 },
  { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)', context_window: 1048576, max_tokens: 65536 },
  { id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)', context_window: 1048576, max_tokens: 65536 },
  { id: 'gemini-3.7-flash-medium', name: 'Gemini 3.7 Flash (Medium)', context_window: 1048576, max_tokens: 65536 },
  { id: 'gemini-3.7-flash-low', name: 'Gemini 3.7 Flash (Low)', context_window: 1048576, max_tokens: 65536 },
  { id: 'gemini-3.6-flash-high', name: 'Gemini 3.6 Flash (High)', context_window: 1048576, max_tokens: 65536 },
  { id: 'gemini-3.6-flash-medium', name: 'Gemini 3.6 Flash (Medium)', context_window: 1048576, max_tokens: 65536 },
  { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)', context_window: 1048576, max_tokens: 65536 },
  { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)', context_window: 1048576, max_tokens: 65536 },
  { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)', context_window: 1048576, max_tokens: 65536 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', context_window: 200000, max_tokens: 64000 },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', context_window: 200000, max_tokens: 64000 },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', context_window: 131072, max_tokens: 16384 },
]

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
    const filename = `/tmp/dsh_img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
    writeFileSync(filename, Buffer.from(base64Data, 'base64'))
    return filename
  } catch (err) {
    console.error('Error saving base64 image:', err)
    return null
  }
}

function formatPrompt(messages, system) {
  let promptParts = []
  let savedImages = []

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
          if (imgPath) {
            savedImages.push(imgPath)
            contentParts.push(`\n[Attached User Image: ${imgPath} - please use view_file or read the visual content of this file]\n`)
          }
        } else if (block.type === 'image' && block.source?.data) {
          const imgPath = saveBase64Image(`data:${block.source.media_type || 'image/png'};base64,${block.source.data}`)
          if (imgPath) {
            savedImages.push(imgPath)
            contentParts.push(`\n[Attached User Image: ${imgPath} - please use view_file or read the visual content of this file]\n`)
          }
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

  return { prompt: promptParts.join('\n'), savedImages }
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
      data: AGY_MODELS.map(m => ({
        id: m.id,
        object: 'model',
        created: 1700000000,
        owned_by: 'antigravity',
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

      const model = body.model || 'gemini-3.7-flash-medium'
      const messages = body.messages || []
      const system = body.system || ''
      const stream = body.stream !== false
      const { prompt, savedImages } = formatPrompt(messages, system)

      const id = `chatcmpl-${Date.now()}`
      const created = Math.floor(Date.now() / 1000)

      console.log(`[AGY] Start req model=${model} stream=${stream} len=${prompt.length} images=${savedImages.length}`)

      const cleanupImages = () => {
        // give a grace period before deleting images
        setTimeout(() => {
          for (const img of savedImages) {
            try { unlinkSync(img) } catch {}
          }
        }, 60000)
      }

      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        })

        const proc = spawn('agy', [
          '--input-format', 'stream-json',
          '--output-format', 'stream-json',
          '--model', model,
          '--disable-slash-commands',
        ], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        })

        let usage = null
        let emittedText = false

        proc.stderr.on('data', d => {
          console.error('[AGY stderr]', d.toString())
        })

        const rl = createInterface({ input: proc.stdout })
        rl.on('line', line => {
          if (!line.trim()) return
          try {
            const parsed = JSON.parse(line)
            if (parsed.event === 'step_update' && parsed.step_update?.text_delta) {
              const text = parsed.step_update.text_delta
              emittedText = true
              const chunk = {
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                  index: 0,
                  delta: { content: text },
                  finish_reason: null,
                }],
              }
              res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            }
            if (parsed.event === 'result' && parsed.result) {
              if (parsed.result.usage) {
                usage = parsed.result.usage
              }
              if (!emittedText && parsed.result.response) {
                const chunk = {
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: { content: parsed.result.response },
                    finish_reason: null,
                  }],
                }
                res.write(`data: ${JSON.stringify(chunk)}\n\n`)
                emittedText = true
              }
            }
          } catch (e) {
            // ignore non-json
          }
        })

        proc.on('close', code => {
          console.log(`[AGY proc closed] code=${code} emittedText=${emittedText}`)
          const finalChunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'stop',
            }],
            ...(usage ? {
              usage: {
                prompt_tokens: usage.input_tokens || 0,
                completion_tokens: usage.output_tokens || 0,
                total_tokens: usage.total_tokens || 0,
              },
            } : {}),
          }
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
          cleanupImages()
        })

        proc.on('error', err => {
          console.error('agy process error:', err)
          res.write(`data: {"error": {"message": ${JSON.stringify(String(err))}}}\n\n`)
          res.end()
          cleanupImages()
        })

        // Feed user input event to agy via stdin
        const inputEvent = JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n'
        proc.stdin.write(inputEvent)
        proc.stdin.end()

        res.on('close', () => {
          if (!res.writableEnded && !proc.killed) {
            console.log('[AGY] Client disconnected, killing process')
            proc.kill()
          }
        })
      } else {
        const proc = spawn('agy', [
          '--input-format', 'stream-json',
          '--output-format', 'stream-json',
          '--model', model,
          '--disable-slash-commands',
        ], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        })

        let fullResponse = ''
        let usage = null

        const rl = createInterface({ input: proc.stdout })
        rl.on('line', line => {
          if (!line.trim()) return
          try {
            const parsed = JSON.parse(line)
            if (parsed.event === 'step_update' && parsed.step_update?.text_delta) {
              fullResponse += parsed.step_update.text_delta
            }
            if (parsed.event === 'result' && parsed.result) {
              if (parsed.result.usage) usage = parsed.result.usage
              if (!fullResponse && parsed.result.response) fullResponse = parsed.result.response
            }
          } catch (e) {}
        })

        proc.on('close', code => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id,
            object: 'chat.completion',
            created,
            model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: fullResponse },
              finish_reason: 'stop',
            }],
            usage: {
              prompt_tokens: usage?.input_tokens || 0,
              completion_tokens: usage?.output_tokens || 0,
              total_tokens: usage?.total_tokens || 0,
            },
          }))
          cleanupImages()
        })

        const inputEvent = JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n'
        proc.stdin.write(inputEvent)
        proc.stdin.end()
      }
    })
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'Not found' } }))
})

server.listen(PORT, HOST, () => {
  console.log(`AGY OpenAI-compatible bridge listening on http://${HOST}:${PORT}`)
})
