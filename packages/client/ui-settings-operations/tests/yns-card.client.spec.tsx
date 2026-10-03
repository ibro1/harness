// @vitest-environment jsdom
/** The YouTube niche scout card: list settings edited row by row, the Host's status, and "Run research now" refusals. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { ListEditor, YnsStatusBlock } from '../src/client/YouTubeNicheScoutCard.tsx'
import { listField, YnsCardController, type YnsLiveState, type YnsSettings, type YnsStatus } from '../src/client/yns-card-controller.ts'
import type { ScoutModelCatalogState } from '../src/client/scout-model-catalog.ts'

afterEach(cleanup)

/** Echo the key and its values, so queries name the dictionary entry. */
const t = ((key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key} ${JSON.stringify(params)}`) as Parameters<typeof YnsStatusBlock>[0]['t']

const STATUS: YnsStatus = {
  enabled: true, schedule: { weekday: 'monday', time: '09:00', timeZone: 'Africa/Lagos' }, lastShiftDate: '2026-09-28',
  apiKey: true, apiKeySource: 'environment', quota: { day: '2026-10-03', used: 1306, limit: 10_000 },
  run: null,
  latest: {
    id: 'abc', createdAt: '2026-09-28T09:40:00Z', recommendation: 'AI tools explained', why: 'Three young channels at 10× subs.', summary: 's',
    link: 'https://h/yns/r/abc?sig=x', changes: [], niches: [{ name: 'AI tools explained', score: 74, rpm: [8, 18], category: 'tech' }],
  },
  reports: [{ id: 'abc', createdAt: '2026-09-28T09:40:00Z', recommendation: 'AI tools explained', link: 'https://h/yns/r/abc?sig=x' }],
}

describe('the list editor', () => {
  it('adds, edits and removes rows, staging them as lines', () => {
    const onEdit = vi.fn<(text: string) => void>()
    render(<ListEditor id="seeds" label="Seeds" hint="h" text={'finance\nhistory'} placeholder="p" addLabel="Add" removeLabel="Remove" disabled={false} onEdit={onEdit} />)
    fireEvent.change(screen.getByLabelText('Seeds 2'), { target: { value: 'world history' } })
    expect(onEdit).toHaveBeenLastCalledWith('finance\nworld history')
    fireEvent.click(screen.getAllByText('Remove')[0]!)
    expect(onEdit).toHaveBeenLastCalledWith('history')
    fireEvent.click(screen.getByText('Add'))
    expect(onEdit).toHaveBeenLastCalledWith('finance\nhistory\n')
  })

  it('saves the rows as a list without blanks or repeats', () => {
    expect(listField('seedTopics').parse('a\n\n b \na\n')).toEqual({ kind: 'set', value: ['a', 'b'] })
    expect(listField('markets').parse('\n')).toEqual({ kind: 'clear' })
  })
})

describe('the status block', () => {
  it('shows the schedule, quota, key source and the latest report with its link', () => {
    const live: YnsLiveState = { status: STATUS, failed: false, started: false, runError: undefined }
    render(<YnsStatusBlock t={t} live={live} onRun={vi.fn()} onRefresh={vi.fn()} />)
    expect(screen.getByText('ynsQuota {"used":1306,"limit":10000}')).toBeTruthy()
    expect(screen.getByText('ynsKeyFromEnv')).toBeTruthy()
    expect(screen.getByText('ynsNicheRow {"name":"AI tools explained","score":74,"rpm":"$8–18"}')).toBeTruthy()
    expect(screen.getByText('ynsOpenReport').getAttribute('href')).toBe('https://h/yns/r/abc?sig=x')
  })
})

describe('the controller', () => {
  it('reads /yns/status and shows a refused run', async () => {
    const form = stubConfigForm<YnsSettings>()
    const request = vi.fn((url: string, _init?: RequestInit) => Promise.resolve(url === '/yns/action'
      ? new Response(JSON.stringify({ error: 'a research run started 3 minutes ago' }), { status: 409 })
      : new Response(JSON.stringify(STATUS), { status: 200 })))
    const face = new YnsCardController(form.scope, request).inject(createSnapshotStore({} as ScoutModelCatalogState), () => {})
    await vi.waitFor(() => { expect(face.hooks.ynsLive.getSnapshot().status?.quota.used).toBe(1306) })
    face.runNow()
    await vi.waitFor(() => { expect(face.hooks.ynsLive.getSnapshot().runError).toBe('a research run started 3 minutes ago') })
    expect(face.hooks.ynsLive.getSnapshot().started).toBe(false)
    expect(request).toHaveBeenCalledWith('/yns/action', expect.objectContaining({ method: 'POST', body: '{"action":"run-now"}' }))
  })
})
