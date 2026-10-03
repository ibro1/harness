// @vitest-environment jsdom
/** The meeting reminders form: each control stages the rule the plugin stores, and problems show under the meeting. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeetingForm, type MeetingFormProps } from '../src/client/MeetingRemindersCard.tsx'
import { rulesField, type MeetingRemindersLiveState } from '../src/client/meeting-reminders-card-controller.ts'
import {
  insertPlaceholder, meetingIssues, newMeeting, readMeetings, renamed, slug, writeMeetings, type MeetingDraft,
} from '../src/client/meeting-reminders-model.ts'

afterEach(cleanup)

/** Echo the key and its values, so queries name the dictionary entry. */
const t = ((key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key} ${JSON.stringify(params)}`) as MeetingFormProps['t']

const EXCO: MeetingDraft = {
  id: 'amya-exco', label: 'AMYA Exco meeting', chat: 'exco@g.us', meeting: { nth: 1, weekday: 'sat' },
  time: '8:15 PM', venue: 'Central Masjid', reminders: [{ daysBefore: 2, at: '09:00' }, { daysBefore: 0, at: '09:00' }], enabled: true,
}

function live(groups: MeetingRemindersLiveState['groups']): MeetingRemindersLiveState {
  return { status: undefined, failed: false, previews: {}, results: {}, busy: [], groups }
}

function form(meeting: MeetingDraft, overrides: Partial<MeetingFormProps> = {}) {
  const onChange = vi.fn<(next: MeetingDraft) => void>()
  render(
    <MeetingForm
      t={t}
      meeting={meeting}
      others={[]}
      savedIds={new Set(['amya-exco'])}
      status={undefined}
      live={live({ state: 'ready', list: [{ jid: 'exco@g.us', name: 'AMYA Exco' }, { jid: 'general@g.us', name: 'AMYA General' }] })}
      disabled={false}
      onChange={onChange}
      onRemove={vi.fn()}
      onPreview={vi.fn()}
      onSend={vi.fn()}
      onRetryGroups={vi.fn()}
      {...overrides}
    />,
  )
  return { onChange, last: () => onChange.mock.calls.at(-1)?.[0] }
}

describe('the meeting form', () => {
  it('offers the WhatsApp groups by name and stores the chosen JID', () => {
    const { last } = form(EXCO)
    const select = screen.getByLabelText('mrField.chat') as HTMLSelectElement
    expect([...select.options].map(o => o.textContent)).toEqual(['mrChooseGroup', 'AMYA Exco', 'AMYA General'])
    fireEvent.change(select, { target: { value: 'general@g.us' } })
    expect(last()?.chat).toBe('general@g.us')
  })

  it('falls back to a group id field when the groups cannot be listed', () => {
    const onRetryGroups = vi.fn()
    const { last } = form(EXCO, { live: live({ state: 'failed', list: [], error: 'not linked' }), onRetryGroups })
    expect(screen.getByText('mrGroupsFailed {"error":"not linked"}')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('mrField.chat'), { target: { value: ' 1203@g.us ' } })
    expect(last()?.chat).toBe('1203@g.us')
    fireEvent.click(screen.getByText('mrRetryGroups'))
    expect(onRetryGroups).toHaveBeenCalled()
  })

  it('sets which weekday of the month and the reminder rows', () => {
    const { last } = form(EXCO)
    const [nth, weekday] = screen.getAllByRole('combobox', { name: 'mrField.repeats' })
    fireEvent.change(nth!, { target: { value: 'last' } })
    expect(last()?.meeting).toEqual({ nth: 'last', weekday: 'sat' })
    fireEvent.change(weekday!, { target: { value: 'fri' } })
    expect(last()?.meeting).toEqual({ nth: 1, weekday: 'fri' })
    const days = screen.getAllByRole('combobox', { name: 'mrField.reminders' }) as HTMLSelectElement[]
    expect([...days[0]!.options].slice(0, 3).map(o => o.textContent)).toEqual(['mrDays.0', 'mrDays.1', 'mrDays.n {"n":2}'])
    fireEvent.change(days[1]!, { target: { value: '1' } })
    expect(last()?.reminders[1]).toEqual({ daysBefore: 1, at: '09:00' })
    fireEvent.change(screen.getAllByLabelText('mrAt')[0]!, { target: { value: '07:30' } })
    expect(last()?.reminders[0]).toEqual({ daysBefore: 2, at: '07:30' })
    fireEvent.click(screen.getByText('mrAddReminder'))
    expect(last()?.reminders).toHaveLength(3)
    fireEvent.click(screen.getAllByText('mrRemoveReminder')[0]!)
    expect(last()?.reminders).toEqual([{ daysBefore: 0, at: '09:00' }])
  })

  it('inserts a placeholder chip into the message', () => {
    const { last } = form({ ...EXCO, template: 'Salam ' })
    fireEvent.click(screen.getByText('{hijriDate}'))
    expect(last()?.template).toBe('Salam {hijriDate}')
  })

  it('skips one month', () => {
    const { last } = form(EXCO)
    fireEvent.change(screen.getByLabelText('mrOverrideMonth'), { target: { value: '2026-11' } })
    expect(last()?.override).toEqual({ month: '2026-11' })
    fireEvent.click(screen.getByLabelText('mrOverrideSkip'))
    expect(last()?.override).toEqual({ skip: true })
  })

  it('keeps a saved meeting\'s id when renamed, and names a new one from its name', () => {
    const saved = form(EXCO)
    fireEvent.change(screen.getByLabelText('mrField.label'), { target: { value: 'Exco' } })
    expect(saved.last()).toMatchObject({ id: 'amya-exco', label: 'Exco' })
    cleanup()
    const fresh = form(newMeeting(new Set()))
    fireEvent.change(screen.getByLabelText('mrField.label'), { target: { value: 'AMYA General Meeting' } })
    expect(fresh.last()).toMatchObject({ id: 'amya-general-meeting', label: 'AMYA General Meeting' })
  })

  it('shows what keeps a meeting from saving', () => {
    form({ ...newMeeting(new Set()), reminders: [{ daysBefore: 0, at: '' }], override: { skip: true } })
    expect(screen.getByText('mrIssue.label')).toBeTruthy()
    expect(screen.getByText('mrIssue.chat')).toBeTruthy()
    expect(screen.getByText('mrIssue.at {"n":1}')).toBeTruthy()
    expect(screen.getByText('mrIssue.month')).toBeTruthy()
    expect((screen.getByText('mrPreview').closest('button')!).disabled).toBe(true)
  })
})

describe('the meeting model', () => {
  it('reads and writes the stored rules, dropping an empty override and message', () => {
    const text = writeMeetings([{ ...EXCO, template: ' ', override: { month: '' } }])
    expect(JSON.parse(text)).toEqual([EXCO])
    expect(readMeetings(text)).toEqual([EXCO])
    expect(readMeetings('not json')).toEqual([])
  })

  it('makes unique ids from names', () => {
    expect(slug('AMYA Exco meeting!')).toBe('amya-exco-meeting')
    expect(slug('—')).toBe('meeting')
    expect(renamed(newMeeting(new Set()), 'Exco', new Set(), new Set(['exco'])).id).toBe('exco-2')
  })

  it('accepts a complete meeting and inserts at the cursor', () => {
    expect(meetingIssues(EXCO)).toEqual([])
    expect(meetingIssues(EXCO, [EXCO]).map(i => i.key)).toEqual(['mrIssue.duplicate'])
    expect(insertPlaceholder('ab', 'when', 1)).toEqual({ text: 'a{when}b', cursor: 7 })
  })
})

describe('the rules field', () => {
  const field = rulesField()

  it('shows the saved rules as indented JSON, and none as an empty list', () => {
    expect(field.format([{ id: 'exco' }])).toBe('[\n  {\n    "id": "exco"\n  }\n]')
    expect(field.format(undefined)).toBe('[]')
  })

  it('stages complete meetings and clears on an empty draft', () => {
    expect(field.parse(JSON.stringify([EXCO]))).toEqual({ kind: 'set', value: [EXCO] })
    expect(field.parse('  ')).toEqual({ kind: 'clear' })
  })

  it('refuses drafts that are not a list of complete meetings', () => {
    expect(field.parse('[{"id":')).toBeUndefined()
    expect(field.parse('{"id":"exco"}')).toBeUndefined()
    expect(field.parse('["exco"]')).toBeUndefined()
    expect(field.parse(JSON.stringify([{ ...EXCO, chat: '' }]))).toBeUndefined()
  })
})
