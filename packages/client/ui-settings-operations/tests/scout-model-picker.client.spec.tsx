// @vitest-environment jsdom
/** The Klipara Scout card's model picker and masked API key. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { maskKey } from '../src/client/ScoutCard.tsx'
import { ScoutModelPicker, type ScoutModelPickerLabels } from '../src/client/ScoutModelPicker.tsx'
import type { ScoutModelCatalogState } from '../src/client/scout-model-catalog.ts'

afterEach(cleanup)

const labels: ScoutModelPickerLabels = {
  label: 'Shift model', hint: 'hint', search: 'Search models', none: 'Default model', change: 'Choose',
  loading: 'Loading', failed: 'Failed', retry: 'Retry', noMatch: 'No match', unknown: 'Not in the model list',
}

const catalog: ScoutModelCatalogState = {
  status: 'ready',
  groups: [
    { id: 'agy', name: 'Antigravity', models: [{ id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' }] },
    { id: 'opencode', name: 'OpenCode', models: [{ id: 'big-pickle', name: 'Big Pickle (Free)' }, { id: 'muse-spark-1.2', name: 'Muse Spark 1.2 (Free)' }] },
  ],
}

describe('the scout model picker', () => {
  it('shows the saved choice by name and sets provider and model together from a search', () => {
    const onPick = vi.fn()
    render(<ScoutModelPicker labels={labels} catalog={catalog} provider="agy" model="gemini-3.8-flash-medium" disabled={false} onPick={onPick} onRetry={() => undefined} />)
    expect(screen.getByText('Antigravity · Gemini 3.8 Flash (Medium)')).toBeTruthy()

    fireEvent.click(screen.getByText('Choose'))
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'pickle' } })
    expect(screen.queryByText('Muse Spark 1.2 (Free)')).toBeNull()
    fireEvent.click(screen.getByText('Big Pickle (Free)'))

    expect(onPick).toHaveBeenCalledWith('opencode', 'big-pickle')
  })

  it('flags a saved model the catalog does not have, such as a typo', () => {
    render(<ScoutModelPicker labels={labels} catalog={catalog} provider="opencode" model="big-prickle" disabled={false} onPick={() => undefined} onRetry={() => undefined} />)
    expect(screen.getByText('Not in the model list')).toBeTruthy()
  })

  it('offers the empty choice, which clears both fields', () => {
    const onPick = vi.fn()
    render(<ScoutModelPicker labels={labels} catalog={catalog} provider="agy" model="gemini-3.8-flash-medium" disabled={false} onPick={onPick} onRetry={() => undefined} />)
    fireEvent.click(screen.getByText('Choose'))
    fireEvent.click(screen.getByText('Default model'))
    expect(onPick).toHaveBeenCalledWith('', '')
  })
})

describe('the masked Klipara API key', () => {
  it('keeps the key kind and the last four characters, hiding the rest', () => {
    expect(maskKey('klp_sk_live_a1b2c3d4e5f6g7h8')).toBe('klp_sk_live_••••••••••••g7h8')
    expect(maskKey('short')).toBe('•••••')
  })
})
