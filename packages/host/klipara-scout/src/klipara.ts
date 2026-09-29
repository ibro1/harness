/**
 * The three Klipara API calls a sample needs: start an analysis job (free),
 * read the job and its ranked clips (free), and export the best clip, which
 * spends one Klip of the workspace balance and returns a download link that
 * expires within the hour. Every call carries the workspace's API key.
 */

/** Where one analysis job stands. */
export interface KliparaJob {
  id: string
  /** `queued`, `running`, `succeeded`, `failed`, `cancelled`, or a stage word. */
  state: string
  /** Klipara's code for a failed job, when there is one. */
  errorCode?: string
}

/** One ranked clip a finished job found. */
export interface KliparaCandidate {
  clipId: string
  rank: number
  totalScore: number
  /** Klipara's standalone gate: a gated-out clip does not make sense on its own. */
  gatedOut: boolean
  startMs: number
  endMs: number
}

/** The Klipara API as the scout uses it. */
export interface KliparaApi {
  startJob(videoUrl: string, signal: AbortSignal): Promise<KliparaJob>
  getJob(jobId: string, signal: AbortSignal): Promise<KliparaJob>
  candidates(jobId: string, signal: AbortSignal): Promise<KliparaCandidate[]>
  exportClip(clipId: string, signal: AbortSignal): Promise<{ downloadUrl: string; charged: string }>
}

/** Best-effort record read. */
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Best-effort string field. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * A client over Klipara's `/api/v1` REST surface.
 * @param base - the API root, for example `https://klipara.linkfa.de/api/v1`.
 * @param apiKey - reads the workspace key at call time, so a key saved in settings applies at once.
 * @param timeoutMs - abandon one call after this long.
 * @returns the client.
 */
export function kliparaClient(base: string, apiKey: () => string, timeoutMs: number): KliparaApi {
  const root = base.replace(/\/+$/u, '')
  const call = async (
    method: string, path: string, signal: AbortSignal, body?: unknown, idempotencyKey?: string,
  ): Promise<Record<string, unknown>> => {
    const key = apiKey().trim()
    if (key === '') throw new Error('No Klipara API key is set; create one on Klipara\'s API keys page and save it in the Klipara Scout settings.')
    const response = await fetch(`${root}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${key}`,
        'Accept': 'application/json',
        ...body === undefined ? {} : { 'Content-Type': 'application/json' },
        ...idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey },
      },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    })
    const raw = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`Klipara answered ${String(response.status)} with a non-JSON body: ${raw.slice(0, 200)}`)
    }
    if (!response.ok) {
      const error = record(record(parsed)['error'])
      throw new Error(`Klipara refused ${method} ${path} (HTTP ${String(response.status)}): ${text(error['message']) || text(error['code']) || raw.slice(0, 200)}`)
    }
    return record(parsed)
  }
  const job = (value: Record<string, unknown>): KliparaJob => ({
    id: text(value['id']),
    state: text(value['state']),
    ...text(value['error_code']) === '' ? {} : { errorCode: text(value['error_code']) },
  })
  return {
    async startJob(videoUrl, signal) {
      return job(await call('POST', '/jobs', signal, { source_url: videoUrl, genre: 'podcast' }, `scout-job:${videoUrl}`))
    },
    async getJob(jobId, signal) {
      return job(await call('GET', `/jobs/${encodeURIComponent(jobId)}`, signal))
    },
    async candidates(jobId, signal) {
      const body = await call('GET', `/jobs/${encodeURIComponent(jobId)}/candidates`, signal)
      const rows = Array.isArray(body['candidates']) ? body['candidates'] : []
      return rows.map(record).flatMap(row => text(row['clip_id']) === '' ? [] : [{
        clipId: text(row['clip_id']),
        rank: typeof row['rank'] === 'number' ? row['rank'] : Number.MAX_SAFE_INTEGER,
        totalScore: typeof row['total_score'] === 'number' ? row['total_score'] : 0,
        gatedOut: row['gated_out'] === true,
        startMs: typeof row['start_ms'] === 'number' ? row['start_ms'] : 0,
        endMs: typeof row['end_ms'] === 'number' ? row['end_ms'] : 0,
      }])
    },
    async exportClip(clipId, signal) {
      const body = await call('POST', `/clips/${encodeURIComponent(clipId)}/export`, signal, { aspect: '9:16' }, `scout-export:${clipId}`)
      const downloadUrl = text(body['download_url'])
      if (downloadUrl === '') throw new Error(`Klipara exported ${clipId} but returned no download link; export it again to get one.`)
      return { downloadUrl, charged: JSON.stringify(body['charged'] ?? body['charge'] ?? '') }
    },
  }
}

/**
 * Pick the clip to send as a sample: the best-ranked one that stands alone.
 * @param candidates - a finished job's clips.
 * @returns the clip, or undefined when every clip needs context.
 */
export function bestCandidate(candidates: readonly KliparaCandidate[]): KliparaCandidate | undefined {
  return [...candidates].filter(c => !c.gatedOut).sort((a, b) => a.rank - b.rank || b.totalScore - a.totalScore)[0]
}
