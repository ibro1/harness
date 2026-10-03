/**
 * The WhatsApp delegate form's editing rules, free of React: the saved
 * contacts array read into editable contacts, the id a new contact gets from
 * its name, and the plain-language problems that keep a contact from saving.
 * The stored value stays the plugin's `contacts` array; the form stages it as
 * JSON text.
 */

/** One contact as the form edits it; the fields the plugin stores. */
export interface DelegateContactDraft {
  id: string
  name: string
  numbers: string[]
  workspacePath: string
  repoUrl: string
  deployBranch: string
  liveUrl: string
  notes: string
  enabled: boolean
  paused: boolean
}

/** A problem the form shows under a contact, as a locale key and its values. */
export interface DelegateContactIssue {
  key: 'wadIssue.name' | 'wadIssue.numbers' | 'wadIssue.number' | 'wadIssue.duplicate'
  params?: Record<string, string | number>
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Read one stored contact into the form's contact, filling what is missing.
 * @param value - an entry of the saved array.
 * @returns the contact.
 */
export function contactDraftFrom(value: unknown): DelegateContactDraft {
  const entry = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    id: text(entry['id']),
    name: text(entry['name']),
    numbers: Array.isArray(entry['numbers']) ? entry['numbers'].map(text) : [],
    workspacePath: text(entry['workspacePath']),
    repoUrl: text(entry['repoUrl']),
    deployBranch: text(entry['deployBranch']),
    liveUrl: text(entry['liveUrl']),
    notes: text(entry['notes']),
    enabled: entry['enabled'] !== false,
    paused: entry['paused'] === true,
  }
}

/**
 * Read the contacts field's draft text into contacts.
 * @param draft - the staged JSON text.
 * @returns the contacts; text that is not a JSON array reads as none.
 */
export function readContacts(draft: string): DelegateContactDraft[] {
  try {
    const value: unknown = JSON.parse(draft)
    return Array.isArray(value) ? value.map(contactDraftFrom) : []
  } catch {
    // The field is only ever staged by this form, so unreadable text means nothing has been saved yet.
    return []
  }
}

/**
 * The text the contacts field stages: empty number rows are left out.
 * @param contacts - the form's contacts.
 * @returns pretty-printed JSON.
 */
export function writeContacts(contacts: readonly DelegateContactDraft[]): string {
  return JSON.stringify(contacts.map(c => ({ ...c, numbers: c.numbers.map(n => n.trim()).filter(n => n !== '') })), null, 2)
}

/**
 * Whether a number or WhatsApp id is one the delegate can read.
 * @param value - as the owner typed it.
 * @returns true for 7–15 digits (spaces, `+`, dashes and brackets allowed) or a WhatsApp id such as `123@s.whatsapp.net`.
 */
export function validNumber(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.includes('@')) return /^[\w.:-]+@[\w.]+$/u.test(trimmed)
  return /^\d{7,15}$/u.test(trimmed.replace(/[\s()+.-]/gu, ''))
}

/**
 * A lowercase id made of the name's letters and digits.
 * @param name - the contact's name.
 * @returns such as `hellen`; `contact` when the name has no letters or digits.
 */
export function contactSlug(name: string): string {
  const plain = name.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '')
  return plain.replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 30) || 'contact'
}

/**
 * Give a contact its name, and to a contact not yet saved an id made from it. A saved contact keeps its id: its
 * Session, read positions and history are filed under it.
 * @param contact - the contact.
 * @param name - the new name.
 * @param savedIds - ids of the contacts the plugin has saved.
 * @param otherIds - ids of the form's other contacts, which the new id must not repeat.
 * @returns the renamed contact.
 */
export function renamedContact(
  contact: DelegateContactDraft, name: string, savedIds: ReadonlySet<string>, otherIds: ReadonlySet<string>,
): DelegateContactDraft {
  if (savedIds.has(contact.id) && contact.id !== '') return { ...contact, name }
  const base = contactSlug(name)
  let id = base
  for (let n = 2; otherIds.has(id); n++) id = `${base}-${String(n)}`
  return { ...contact, name, id }
}

/**
 * A new contact for the "Add contact" button.
 * @param otherIds - ids already in the form.
 * @returns the contact, switched on, with one empty number row.
 */
export function newContact(otherIds: ReadonlySet<string>): DelegateContactDraft {
  return renamedContact({
    id: '', name: '', numbers: [''], workspacePath: '', repoUrl: '', deployBranch: '', liveUrl: '', notes: '', enabled: true, paused: false,
  }, '', new Set(), otherIds)
}

/**
 * What keeps a contact from saving, in the words the form shows.
 * @param contact - the contact.
 * @param others - the form's other contacts, for duplicate ids.
 * @returns the problems; empty when it can be saved.
 */
export function contactIssues(contact: DelegateContactDraft, others: readonly DelegateContactDraft[] = []): DelegateContactIssue[] {
  const issues: DelegateContactIssue[] = []
  if (contact.name.trim() === '') issues.push({ key: 'wadIssue.name' })
  const numbers = contact.numbers.filter(n => n.trim() !== '')
  if (numbers.length === 0) issues.push({ key: 'wadIssue.numbers' })
  contact.numbers.forEach((number, index) => {
    if (number.trim() !== '' && !validNumber(number)) issues.push({ key: 'wadIssue.number', params: { n: index + 1 } })
  })
  if (contact.id !== '' && others.some(other => other.id === contact.id)) issues.push({ key: 'wadIssue.duplicate' })
  return issues
}
