/** The meeting reminders card's rules field: JSON in, JSON out, and a draft that is not a list of rules blocks the save. */

import { describe, expect, it } from 'vitest'
import { rulesField } from '../src/client/meeting-reminders-card-controller.ts'

describe('meeting reminders rules field', () => {
  const field = rulesField()

  it('shows the saved rules as indented JSON, and none as an empty list', () => {
    expect(field.format([{ id: 'exco' }])).toBe('[\n  {\n    "id": "exco"\n  }\n]')
    expect(field.format(undefined)).toBe('[]')
  })

  it('stages a JSON array of objects and clears on an empty draft', () => {
    expect(field.parse('[{"id":"exco","meeting":{"nth":1,"weekday":"sat"}}]')).toEqual({
      kind: 'set', value: [{ id: 'exco', meeting: { nth: 1, weekday: 'sat' } }],
    })
    expect(field.parse('  ')).toEqual({ kind: 'clear' })
  })

  it('refuses drafts that are not a list of rule objects', () => {
    expect(field.parse('[{"id":')).toBeUndefined()
    expect(field.parse('{"id":"exco"}')).toBeUndefined()
    expect(field.parse('["exco"]')).toBeUndefined()
  })
})
