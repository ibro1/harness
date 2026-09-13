// @vitest-environment jsdom

/**
 * The application-credential blocks: that a secret is never rendered back, that
 * the id and redirect URI are, that Save is blocked until something is staged,
 * and that a block belonging to a provider this deployment does not compose is
 * not shown at all.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppCredentialsSection } from '../src/client/AppCredentialsSection.tsx'
import type { AppCredentialState } from '../src/client/app-credentials-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

/** The shipped English copy, with the same `{name}` substitution the runtime does. */
function t(key: keyof typeof en, params?: Record<string, string>): string {
  const text = en[key]
  return params === undefined
    ? text
    : text.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole)
}

/**
 * Narrow a queried element to an input.
 *
 * `getByLabelText` answers `HTMLElement`, and `disabled` and `type` are the two
 * facts these tests are about. Throwing names the wrong element rather than
 * failing later on a property of the wrong type.
 * @param element - the queried element. @returns it, as an input.
 * @throws when the label reached something that is not an input.
 */
function toInput(element: HTMLElement): HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) throw new Error('expected an input')
  return element
}

/**
 * Narrow a queried element to a button.
 * @param element - the queried element. @returns it, as a button.
 * @throws when the role reached something that is not a button.
 */
function toButton(element: HTMLElement): HTMLButtonElement {
  if (!(element instanceof HTMLButtonElement)) throw new Error('expected a button')
  return element
}

/** A staged-field state with nothing staged. */
function field(text: string): AppCredentialState['id'] {
  return { text, overridden: text !== '' }
}

/** One block, defaulted to a composed and writable LinkedIn application. */
function block(overrides: Partial<AppCredentialState> = {}): AppCredentialState {
  return {
    available: true,
    writable: true,
    dirty: false,
    saving: false,
    failed: false,
    application: 'linkedin',
    idField: 'clientId',
    secretRefField: 'clientSecretEnv',
    id: field('77abc'),
    redirectUri: field('https://harness.example/oauth/linkedin'),
    secretRef: field('LINKEDIN_CLIENT_SECRET'),
    secret: field(''),
    secretConfigured: true,
    secretWritable: true,
    ...overrides,
  }
}

/** Render the section over the given blocks, recording every edit. */
function show(blocks: AppCredentialState[]): Array<[string, string, string]> {
  const edits: Array<[string, string, string]> = []
  render(<AppCredentialsSection
    t={t}
    blocks={blocks}
    onEdit={(application, name, text) => { edits.push([application, name, text]) }}
    onReset={() => {}}
    onSave={vi.fn()}
    onDiscard={vi.fn()}
  />)
  return edits
}

describe('AppCredentialsSection', () => {
  it('renders nothing when no provider settings namespace is served', () => {
    const { container } = render(<AppCredentialsSection
      t={t} blocks={[]} onEdit={() => {}} onReset={() => {}} onSave={() => {}} onDiscard={() => {}}
    />)
    expect(container.firstChild).toBeNull()
  })

  it('hides a block whose provider this deployment does not compose', () => {
    show([block(), block({ application: 'youtube', available: false })])
    expect(screen.getByText(en.appLinkedinTitle)).toBeDefined()
    expect(screen.queryByText(en.appYoutubeTitle)).toBeNull()
  })

  it('separates the two meanings of "credential" before asking for either', () => {
    show([block()])
    expect(screen.getByText(en.appIntro)).toBeDefined()
  })

  it('shows the public id and redirect URI, which are not secrets', () => {
    show([block()])
    expect(screen.getByDisplayValue('77abc')).toBeDefined()
    expect(screen.getByDisplayValue('https://harness.example/oauth/linkedin')).toBeDefined()
  })

  it('never renders a secret back, and says one is configured instead', () => {
    show([block({ secret: field('') })])
    const secret = toInput(screen.getByLabelText(en.appSecretLinkedin))
    expect(secret.type).toBe('password')
    expect(secret.value).toBe('')
    expect(screen.getByText(en.appSecretSet)).toBeDefined()
  })

  it('says when no secret is configured, so a blank box is not ambiguous', () => {
    show([block({ secretConfigured: false })])
    expect(screen.getByText(en.appSecretUnset)).toBeDefined()
  })

  it('names the field each control edits, including the ones Meta spells differently', () => {
    const edits = show([block({
      application: 'meta', idField: 'appId', secretRefField: 'appSecretEnv',
      publicMediaBaseUrl: field('https://media.example'),
    })])
    fireEvent.change(screen.getByLabelText(en.appIdMeta), { target: { value: '1234' } })
    fireEvent.change(screen.getByLabelText(en.appSecretMeta), { target: { value: 'shh' } })
    expect(edits).toEqual([['meta', 'appId', '1234'], ['meta', 'secret', 'shh']])
  })

  it('offers the public media base only to the application that has one', () => {
    show([block({ application: 'meta', publicMediaBaseUrl: field('https://media.example') })])
    expect(screen.getByText(en.appPublicMediaLabel)).toBeDefined()
    cleanup()
    show([block()])
    expect(screen.queryByText(en.appPublicMediaLabel)).toBeNull()
  })

  it('blocks Save until something is staged', () => {
    show([block()])
    expect(toButton(screen.getByRole('button', { name: en.appSave })).disabled).toBe(true)
    cleanup()
    show([block({ dirty: true })])
    expect(toButton(screen.getByRole('button', { name: en.appSave })).disabled).toBe(false)
  })

  it('says a save is crossing the wire rather than looking idle', () => {
    show([block({ dirty: true, saving: true })])
    expect(screen.getByRole('button', { name: en.appSaving })).toBeDefined()
  })

  it('reports a save that did not land, rather than clearing quietly', () => {
    show([block({ failed: true })])
    expect(screen.getByText(en.appSaveFailed)).toBeDefined()
  })

  it('disables every control and says why when the document is read-only', () => {
    show([block({ writable: false })])
    expect(screen.getByText(en.appReadOnly)).toBeDefined()
    expect(toInput(screen.getByLabelText(en.appIdLinkedin)).disabled).toBe(true)
    expect(toInput(screen.getByLabelText(en.appSecretLinkedin)).disabled).toBe(true)
  })

  it('disables only the secret when the credential store refuses writes for it', () => {
    show([block({ secretWritable: false })])
    expect(toInput(screen.getByLabelText(en.appSecretLinkedin)).disabled).toBe(true)
    expect(toInput(screen.getByLabelText(en.appIdLinkedin)).disabled).toBe(false)
  })
})
