import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { newSampleId, readSample, serveSample } from '../src/samples.ts'

let server: Server | undefined
afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() => { resolve() }))
    server = undefined
  }
})

/** Serve a samples directory the way the plugin does and return the origin. */
async function serve(dir: string, ttlDays = 30): Promise<string> {
  server = createServer((req, res) => {
    void serveSample(req, res, dir, '/scout/s', {
      fileBase: 'https://harness.test/scout/s', corsOrigin: 'https://klipara.test', ttlDays, headline: 'h', note: 'n',
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${String(address.port)}`
}

/** A stored sample with its record and poster. */
function sample(dir: string, id: string, createdAt: string): void {
  writeFileSync(join(dir, `${id}.mp4`), Buffer.from('0123456789'))
  writeFileSync(join(dir, `${id}.jpg`), Buffer.from('jpg'))
  writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify({
    id, title: 'Episode 5', creatorName: 'Small Pod', sourceVideoUrl: 'https://www.youtube.com/watch?v=v1', createdAt,
  }))
}

describe('sample hosting', () => {
  it('makes ids of 11 URL-safe characters carrying 64 random bits', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSampleId()))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/u)
  })

  it('answers the public JSON with only the published fields and the CORS origin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'samples-'))
    const id = newSampleId()
    sample(dir, id, new Date().toISOString())
    const base = await serve(dir)
    const response = await fetch(`${base}/scout/s/${id}.json`)
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://klipara.test')
    const body = await response.json() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'creatorName', 'id', 'posterUrl', 'sourceVideoUrl', 'title', 'videoUrl'])
    expect(body).toMatchObject({
      id, title: 'Episode 5', creatorName: 'Small Pod', sourceVideoUrl: 'https://www.youtube.com/watch?v=v1',
      videoUrl: `https://harness.test/scout/s/${id}.mp4`, posterUrl: `https://harness.test/scout/s/${id}.jpg`,
    })
  })

  it('serves the clip with range requests and CORS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'samples-'))
    const id = newSampleId()
    sample(dir, id, new Date().toISOString())
    const base = await serve(dir)
    const response = await fetch(`${base}/scout/s/${id}.mp4`, { headers: { Range: 'bytes=2-5' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(response.headers.get('access-control-allow-origin')).toBe('https://klipara.test')
    expect(await response.text()).toBe('2345')
  })

  it('answers 404 for unknown, malformed and expired ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'samples-'))
    const old = newSampleId()
    sample(dir, old, new Date(Date.now() - 31 * 86_400_000).toISOString())
    const base = await serve(dir)
    for (const path of [`${newSampleId()}.json`, '..%2Fleads.json', 'abc.json', `${old}.json`, `${old}.mp4`]) {
      expect((await fetch(`${base}/scout/s/${path}`)).status).toBe(404)
    }
    expect(await readSample(dir, old, 0)).toBeDefined()
  })
})
