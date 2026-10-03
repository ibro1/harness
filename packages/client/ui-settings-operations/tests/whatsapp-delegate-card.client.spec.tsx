// @vitest-environment jsdom
/** The WhatsApp delegate's contact form: each control stages the contact the plugin stores, and problems show under it. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContactForm, type ContactFormProps } from '../src/client/WhatsAppDelegateCard.tsx'
import { contactsField } from '../src/client/whatsapp-delegate-card-controller.ts'
import {
  contactIssues, contactSlug, newContact, readContacts, renamedContact, validNumber, writeContacts, type DelegateContactDraft,
} from '../src/client/whatsapp-delegate-model.ts'

afterEach(cleanup)

/** Echo the key and its values, so queries name the dictionary entry. */
const t = ((key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key} ${JSON.stringify(params)}`) as ContactFormProps['t']

const HELLEN: DelegateContactDraft = {
  id: 'hellen', name: 'Hellen', numbers: ['+234 800 000 0001'], workspacePath: '/workspace/zenith', repoUrl: '', deployBranch: 'deploy',
  liveUrl: '', notes: 'Client', enabled: true, paused: false,
}

function form(contact: DelegateContactDraft) {
  const onChange = vi.fn<(next: DelegateContactDraft) => void>()
  render(<ContactForm t={t} contact={contact} others={[]} savedIds={new Set(['hellen'])} disabled={false} onChange={onChange} onRemove={vi.fn()} />)
  return onChange
}

describe('WhatsApp delegate contact form', () => {
  it('stages a second number, notes and the pause switch', () => {
    const onChange = form(HELLEN)
    fireEvent.click(screen.getByRole('button', { name: 'wadAddNumber' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...HELLEN, numbers: ['+234 800 000 0001', ''] })
    fireEvent.change(screen.getByLabelText('wadContact.notes'), { target: { value: 'Writes in Hausa' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...HELLEN, notes: 'Writes in Hausa' })
    fireEvent.change(screen.getByLabelText('wadContact.deployBranch'), { target: { value: 'main' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...HELLEN, deployBranch: 'main' })
  })

  it('keeps a saved contact\'s id when it is renamed', () => {
    const onChange = form(HELLEN)
    fireEvent.change(screen.getByLabelText('wadContact.name'), { target: { value: 'Hellen O.' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...HELLEN, name: 'Hellen O.' })
  })

  it('shows what keeps a contact from saving', () => {
    form({ ...HELLEN, name: '', numbers: ['call me'] })
    expect(screen.getByText('wadIssue.name')).toBeTruthy()
    expect(screen.getByText('wadIssue.number {"n":1}')).toBeTruthy()
  })
})

describe('WhatsApp delegate contacts model', () => {
  it('names new contacts from their name without repeating an id', () => {
    const fresh = newContact(new Set(['contact']))
    expect(fresh.id).toBe('contact-2')
    expect(renamedContact(fresh, 'Hellen (Zenith)', new Set(), new Set(['hellen-zenith'])).id).toBe('hellen-zenith-2')
    expect(contactSlug('Ẹmẹka Ọ.')).toBe('emeka-o')
  })

  it('reads and writes the stored array, dropping empty number rows', () => {
    const text = writeContacts([{ ...HELLEN, numbers: ['+2348000000001', ' '] }])
    expect(readContacts(text)).toEqual([{ ...HELLEN, numbers: ['+2348000000001'] }])
    expect(readContacts('not json')).toEqual([])
  })

  it('accepts phone numbers with a country code and WhatsApp ids', () => {
    expect(validNumber('+234 (803) 123-4567')).toBe(true)
    expect(validNumber('2348031234567@s.whatsapp.net')).toBe(true)
    expect(validNumber('0803')).toBe(false)
    expect(contactIssues({ ...HELLEN, numbers: [''] })).toEqual([{ key: 'wadIssue.numbers' }])
  })

  it('blocks the save while a contact has a problem', () => {
    const field = contactsField()
    expect(field.parse(writeContacts([HELLEN]))).toMatchObject({ kind: 'set' })
    expect(field.parse(writeContacts([{ ...HELLEN, numbers: [] }]))).toBeUndefined()
    expect(field.parse('')).toEqual({ kind: 'clear' })
  })
})
