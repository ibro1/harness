/**
 * The application-credential precedence rule: which layer supplies a value,
 * that blank is the same statement as absent, and that a refusal names every
 * place the value could be put.
 */

import { describe, expect, it } from 'vitest'
import {
  chooseAppCredential, firstConfigured, missingAppCredential, resolveAppCredential,
} from '../src/app-credentials.ts'

/** A credential seam that holds the given references and nothing else. */
function seam(held: Record<string, string>): (ref: string) => Promise<string | undefined> {
  return ref => Promise.resolve(held[ref])
}

const SUBJECT = { platform: 'LinkedIn', what: 'client id' }

describe('chooseAppCredential', () => {
  it('prefers what a person typed into settings over every other layer', () => {
    expect(chooseAppCredential({ settings: 'typed', config: 'composed', ref: 'NAMED' }))
      .toEqual({ kind: 'literal', value: 'typed', layer: 'settings' })
  })

  it('falls to the composition layer when settings carries nothing', () => {
    expect(chooseAppCredential({ config: 'composed', ref: 'NAMED' }))
      .toEqual({ kind: 'literal', value: 'composed', layer: 'config' })
  })

  it('falls to the named reference when neither literal layer carries one', () => {
    expect(chooseAppCredential({ ref: 'NAMED' })).toEqual({ kind: 'reference', ref: 'NAMED' })
  })

  it('reports that nothing supplies it rather than choosing an empty value', () => {
    expect(chooseAppCredential({})).toEqual({ kind: 'absent' })
  })

  it('reads a blank layer as absent, because clearing a field means "I do not supply this"', () => {
    expect(chooseAppCredential({ settings: '   ', config: 'composed' }))
      .toEqual({ kind: 'literal', value: 'composed', layer: 'config' })
    expect(chooseAppCredential({ settings: '', config: '', ref: '  ' })).toEqual({ kind: 'absent' })
  })

  it('trims what it returns, so a pasted value with a stray newline still works', () => {
    expect(chooseAppCredential({ settings: ' 77abc \n' }))
      .toEqual({ kind: 'literal', value: '77abc', layer: 'settings' })
  })
})

describe('firstConfigured', () => {
  it('takes the first layer carrying anything', () => {
    expect(firstConfigured(undefined, '', '  ', 'third', 'fourth')).toBe('third')
  })

  it('is undefined when no layer carries anything', () => {
    expect(firstConfigured(undefined, '', '   ')).toBeUndefined()
  })
})

describe('resolveAppCredential', () => {
  it('returns a literal without consulting the credential seam', async () => {
    let asked = false
    const value = await resolveAppCredential({ settings: 'typed', ref: 'NAMED' }, SUBJECT, (ref) => {
      asked = true
      return Promise.resolve(ref)
    })
    expect(value).toBe('typed')
    expect(asked).toBe(false)
  })

  it('resolves a named reference through the credential seam', async () => {
    expect(await resolveAppCredential({ ref: 'LINKEDIN_CLIENT_ID' }, SUBJECT, seam({ LINKEDIN_CLIENT_ID: 'from-env' })))
      .toBe('from-env')
  })

  it('names the card, the variable, and the config when the reference holds nothing', async () => {
    await expect(resolveAppCredential({ ref: 'LINKEDIN_CLIENT_ID' }, SUBJECT, seam({})))
      .rejects.toThrow('No LinkedIn client id is configured: enter it in Settings → Plugins → Social, set the LINKEDIN_CLIENT_ID environment variable, or give this plugin the value directly in its config.')
  })

  it('treats a reference that resolves to blank as holding nothing', async () => {
    await expect(resolveAppCredential({ ref: 'LINKEDIN_CLIENT_ID' }, SUBJECT, seam({ LINKEDIN_CLIENT_ID: '  ' })))
      .rejects.toThrow('set the LINKEDIN_CLIENT_ID environment variable')
  })

  it('omits the variable clause when no layer even names one', async () => {
    await expect(resolveAppCredential({}, SUBJECT, seam({})))
      .rejects.toThrow('No LinkedIn client id is configured: enter it in Settings → Plugins → Social, or give this plugin the value directly in its config.')
  })
})

describe('missingAppCredential', () => {
  it('puts the card first, because it is the one way that needs no redeploy', () => {
    expect(missingAppCredential({ platform: 'Meta', what: 'app secret' }, 'META_APP_SECRET'))
      .toBe('No Meta app secret is configured: enter it in Settings → Plugins → Social, set the META_APP_SECRET environment variable, or give this plugin the value directly in its config.')
  })
})
