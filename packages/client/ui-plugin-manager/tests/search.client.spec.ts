/** What a Plugins-page search matches. */

import { describe, expect, it } from 'vitest'
import { matchesSearch } from '../src/client/presentation.ts'

describe('plugin search', () => {
  it('matches every word anywhere in the card, ignoring case and accents', () => {
    const card = 'PSD tools Open, edit and export Photoshop files through Photopea psd-tools'
    expect(matchesSearch(card, '')).toBe(true)
    expect(matchesSearch(card, 'psd')).toBe(true)
    expect(matchesSearch(card, 'PHOTOSHOP export')).toBe(true)
    expect(matchesSearch(card, 'photoshop email')).toBe(false)
    expect(matchesSearch('Café plugin', 'cafe')).toBe(true)
  })
})
