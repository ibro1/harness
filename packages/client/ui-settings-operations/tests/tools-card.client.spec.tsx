// @vitest-environment jsdom
/** The tools employee card: the Host's status (site, shortlist, published tools, AdSense) and refused actions. */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { ToolsStatusBlock } from '../src/client/ToolsEmployeeCard.tsx'
import { ToolsCardController, type ToolsLiveState, type ToolsSettings, type ToolsStatus } from '../src/client/tools-card-controller.ts'
import type { ScoutModelCatalogState } from '../src/client/scout-model-catalog.ts'

afterEach(cleanup)

/** Echo the key and its values, so queries name the dictionary entry. */
const t = ((key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key} ${JSON.stringify(params)}`) as Parameters<typeof ToolsStatusBlock>[0]['t']

const STATUS: ToolsStatus = {
  enabled: true, schedule: { weekday: 'monday', time: '09:00', timeZone: 'Africa/Lagos' }, lastShiftDate: '2026-09-28',
  run: null,
  site: {
    url: 'https://tools.linkfa.de/', state: 'not-deployed', detail: 'DNS has no record for tools.linkfa.de.',
    liveVersion: null, localVersion: 'a1b2c3', checkedAt: '2026-10-03T08:00:00Z',
    repo: 'https://github.com/o/tools.git', pushReady: true, pushDetail: '', deployHookSet: false,
  },
  shortlist: {
    id: 's1', createdAt: '2026-09-28T09:30:00Z', status: 'pending', link: 'https://h/tools/s/s1?sig=x',
    items: [{
      n: 1, slug: 'zakat-calculator', tool: 'Zakat calculator', keyword: 'zakat calculator', verdict: 'Build', demand: '2.4k/mo',
      market: 'GB', rpm: '$6–12', difficulty: 18, approved: null, built: false, published: false,
    }],
  },
  tools: [
    {
      slug: 'loan-calculator', title: 'Loan calculator', url: 'https://tools.linkfa.de/loan-calculator', keyword: 'loan calculator',
      publishedAt: '2026-09-20', seed: true, tests: 'failed', testsAt: '2026-10-02T06:00:00Z', live: true,
      clicks: 12, impressions: 340, position: 23.46, flag: 'Rounding is off by a penny.',
    },
  ],
  pace: { thisWeek: 1, max: 3 },
  serp: { today: 4, max: 20 },
  adsense: {
    clientSet: false, ready: false, verdict: 'Needs more content.',
    checks: [
      { label: 'Privacy policy', ok: true, detail: '' },
      { label: 'Ten useful tools', ok: false, detail: '3 of 10' },
    ],
  },
  gsc: {
    connected: false, keySet: true, property: 'sc-domain:linkfa.de', lastReviewAt: null,
    detail: 'The service account is not a user on the property.',
  },
  keywordPlanner: { available: false, detail: 'No SEO site chosen.' },
}

function block(live: ToolsLiveState) {
  return render(
    <ToolsStatusBlock t={t} live={live} onRun={vi.fn()} onPublish={vi.fn()} onCheck={vi.fn()} onRefresh={vi.fn()} />,
  )
}

const LIVE: ToolsLiveState = {
  status: STATUS, failed: false, started: false, action: undefined, actionMessage: undefined, actionError: undefined,
}

describe('the status block', () => {
  it('shows a pending shortlist with its review link and the not-deployed site sentence', () => {
    block(LIVE)
    expect(screen.getByText('toolsShortlistPending')).toBeTruthy()
    expect(screen.getByText('toolsShortlistItem {"tool":"Zakat calculator","keyword":"zakat calculator"}')).toBeTruthy()
    expect(screen.getByText('toolsShortlistReview').getAttribute('href')).toBe('https://h/tools/s/s1?sig=x')
    expect(screen.getByText('toolsSiteState.not-deployed')).toBeTruthy()
    expect(screen.getByText('DNS has no record for tools.linkfa.de.')).toBeTruthy()
    expect(screen.getByText('toolsPace {"thisWeek":1,"max":3}')).toBeTruthy()
    expect(screen.getByText('toolsSerp {"today":4,"max":20}')).toBeTruthy()
  })

  it('lists a published tool with a failed-tests badge and its search figures', () => {
    block(LIVE)
    expect(screen.getByText('Loan calculator').getAttribute('href')).toBe('https://tools.linkfa.de/loan-calculator')
    expect(screen.getByText('toolsTests.failed')).toBeTruthy()
    const figures = 'toolsGsc.clicks {"value":12} · toolsGsc.impressions {"value":340} · toolsGsc.position {"value":23.5}'
    expect(screen.getByText(figures)).toBeTruthy()
    expect(screen.getByText('Rounding is off by a penny.')).toBeTruthy()
  })

  it('shows each AdSense check with its mark and detail', () => {
    block(LIVE)
    expect(screen.getByText('toolsAdsenseNotReady {"verdict":"Needs more content."}')).toBeTruthy()
    expect(screen.getByText('✓ Privacy policy')).toBeTruthy()
    expect(screen.getByText('✗ Ten useful tools')).toBeTruthy()
    expect(screen.getByText('— 3 of 10')).toBeTruthy()
  })

  it('shows a refusal as an alert', () => {
    block({ ...LIVE, action: 'run-now', actionError: 'a run started 3 minutes ago' })
    expect(screen.getByRole('alert').textContent).toBe('toolsRefused.run-now {"error":"a run started 3 minutes ago"}')
  })
})

describe('the controller', () => {
  it('reads /tools/status, posts run-now and shows a 409 refusal', async () => {
    const form = stubConfigForm<ToolsSettings>()
    const request = vi.fn((url: string, _init?: RequestInit) => Promise.resolve(url === '/tools/action'
      ? new Response(JSON.stringify({ error: 'a run started 3 minutes ago' }), { status: 409 })
      : new Response(JSON.stringify(STATUS), { status: 200 })))
    const face = new ToolsCardController(form.scope, request).inject(createSnapshotStore({} as ScoutModelCatalogState), () => {})
    await vi.waitFor(() => { expect(face.hooks.toolsLive.getSnapshot().status?.site.state).toBe('not-deployed') })
    expect(request).toHaveBeenCalledWith('/tools/status', expect.objectContaining({ credentials: 'same-origin' }))
    face.runNow()
    await vi.waitFor(() => { expect(face.hooks.toolsLive.getSnapshot().actionError).toBe('a run started 3 minutes ago') })
    expect(face.hooks.toolsLive.getSnapshot().started).toBe(false)
    expect(face.hooks.toolsLive.getSnapshot().action).toBe('run-now')
    expect(request).toHaveBeenCalledWith('/tools/action', expect.objectContaining({ method: 'POST', body: '{"action":"run-now"}' }))
  })
})
