/** The address-bar format: what each hash opens, and that writing then reading returns the same place. */

import { describe, expect, it } from 'vitest'
import { formatPlace, parsePlace, type Place } from '../src/client/location.ts'

describe('place in the address bar', () => {
  it('round-trips every kind of place', () => {
    const places: Place[] = [
      { kind: 'session' },
      { kind: 'panel', panel: 'memory' },
      { kind: 'plugins', view: { kind: 'list' } },
      { kind: 'plugins', view: { kind: 'item', id: 'switch-psd-tools' } },
      { kind: 'plugins', view: { kind: 'package', name: '@deepseek-ai/dsh-bundle-agent-teams' } },
      { kind: 'plugins', view: { kind: 'row', name: '@scope/bundle', rowId: 'row/with slash' } },
    ]
    for (const place of places) expect(parsePlace(formatPlace(place))).toEqual(place)
  })

  it('keeps a scoped package name in one segment', () => {
    expect(formatPlace({ kind: 'plugins', view: { kind: 'package', name: '@scope/name' } })).toBe('#/plugins/package/%40scope%2Fname')
  })

  it('reads a hash it did not write as the Session', () => {
    expect(parsePlace('')).toEqual({ kind: 'session' })
    expect(parsePlace('#section-2')).toEqual({ kind: 'session' })
    expect(parsePlace('#/plugins/item/%E0%A4%A')).toEqual({ kind: 'session' })
  })

  it('opens the plugin list for an incomplete plugins address', () => {
    expect(parsePlace('#/plugins/item')).toEqual({ kind: 'plugins', view: { kind: 'list' } })
  })
})
