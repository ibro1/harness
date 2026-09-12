/**
 * The social registry driven against in-memory providers: registration and
 * fiber disposal, the merged listing, a provider that fails to list, and every
 * refusal `post()` makes before a provider is reached. The providers are
 * stubs, because this package owns the namespace rule and the routing, not any
 * platform's API.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SocialRegistry, { type SocialPostRequest, type SocialPostResult, type SocialProvider, type SocialTarget } from '../src/index.ts'

/** A target with the accepts/ready defaults most cases want. */
function target(id: string, provider: string, label: string, overrides: Partial<SocialTarget> = {}): SocialTarget {
  return {
    id,
    provider,
    label,
    accepts: { text: true, image: true, video: true },
    ready: true,
    ...overrides,
  }
}

/** An in-memory provider recording every post it is asked to publish. */
class StubProvider implements SocialProvider {
  readonly posts: SocialPostRequest[] = []

  constructor(readonly name: string, private listing: readonly SocialTarget[] | Error) {}

  async targets(): Promise<readonly SocialTarget[]> {
    if (this.listing instanceof Error) throw this.listing
    return this.listing
  }

  async post(request: SocialPostRequest): Promise<SocialPostResult> {
    this.posts.push(request)
    return { id: `${this.name}-post-1`, url: `https://${this.name}.example/1` }
  }
}

/** A registry with the given providers registered directly on the root context. */
async function registryWith(...providers: SocialProvider[]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SocialRegistry)
  for (const provider of providers) ctx.social.register(provider)
  return ctx
}

describe('SocialRegistry registration', () => {
  it('merges every provider target into one id-ordered listing', async () => {
    const ctx = await registryWith(
      new StubProvider('linkedin', [target('linkedin:member', 'linkedin', 'Ada Obi (personal)')]),
      new StubProvider('facebook', [
        target('facebook:page:1234', 'facebook', 'FrontStaff (Page)'),
        target('facebook:page:9', 'facebook', 'Side project (Page)', { ready: false, reason: 'reconnect the Page' }),
      ]),
    )

    expect((await ctx.social.targets()).map(entry => [entry.id, entry.label, entry.ready])).toEqual([
      ['facebook:page:1234', 'FrontStaff (Page)', true],
      ['facebook:page:9', 'Side project (Page)', false],
      ['linkedin:member', 'Ada Obi (personal)', true],
    ])
  })

  it('removes a provider when its registering fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SocialRegistry)
    const provider = new StubProvider('linkedin', [target('linkedin:member', 'linkedin', 'Ada Obi (personal)')])
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.social.register(provider)
    }, { inject: ['social'] }))

    expect((await ctx.social.targets()).map(entry => entry.id)).toEqual(['linkedin:member'])

    await fiber.dispose()

    expect(await ctx.social.targets()).toEqual([])
  })

  it('removes a provider through the disposer register() returned', async () => {
    const ctx = new Context()
    await ctx.plugin(SocialRegistry)
    const dispose = ctx.social.register(new StubProvider('linkedin', [target('linkedin:member', 'linkedin', 'Ada Obi (personal)')]))

    expect((await ctx.social.targets()).map(entry => entry.id)).toEqual(['linkedin:member'])

    dispose()

    expect(await ctx.social.targets()).toEqual([])
  })

  it('refuses a second provider under one name, so an id cannot be claimed twice', async () => {
    const ctx = await registryWith(new StubProvider('linkedin', []))

    expect(() => ctx.social.register(new StubProvider('linkedin', [])))
      .toThrow('a social provider named "linkedin" is already registered')
  })

  it('refuses a provider name carrying the id separator', async () => {
    const ctx = new Context()
    await ctx.plugin(SocialRegistry)

    expect(() => ctx.social.register(new StubProvider('linked:in', [])))
      .toThrow('invalid social provider name "linked:in"')
    expect(() => ctx.social.register(new StubProvider('', [])))
      .toThrow('invalid social provider name ""')
  })
})

describe('SocialRegistry listing faults', () => {
  it('keeps the other providers listed when one throws while listing', async () => {
    const working = new StubProvider('linkedin', [target('linkedin:member', 'linkedin', 'Ada Obi (personal)')])
    const ctx = await registryWith(working, new StubProvider('facebook', new Error('the Page token expired')))

    const targets = await ctx.social.targets()
    expect(targets.map(entry => entry.id)).toEqual(['facebook', 'linkedin:member'])
    const failed = targets.find(entry => entry.id === 'facebook')
    expect(failed?.ready).toBe(false)
    expect(failed?.reason).toContain('the Page token expired')
    expect(failed?.accepts).toEqual({ text: false, image: false, video: false })
  })

  it('refuses to address a target that does not carry its provider prefix', async () => {
    const ctx = await registryWith(new StubProvider('linkedin', [
      target('member', 'linkedin', 'Unprefixed'),
      target('linkedin:member', 'linkedin', 'Ada Obi (personal)'),
    ]))

    const targets = await ctx.social.targets()
    expect(targets.map(entry => entry.id)).toEqual(['linkedin', 'linkedin:member'])
    expect(targets.find(entry => entry.id === 'linkedin')?.reason)
      .toContain('"member" does not start with "linkedin:"')
  })

  it('refuses to address a target claiming another provider, or an id listed twice', async () => {
    const ctx = await registryWith(new StubProvider('linkedin', [
      target('linkedin:member', 'linkedin', 'Ada Obi (personal)'),
      target('linkedin:page:1', 'facebook', 'Impersonating another provider'),
      target('linkedin:member', 'linkedin', 'A second claim on one id'),
    ]))

    const targets = await ctx.social.targets()
    expect(targets.map(entry => entry.id)).toEqual(['linkedin', 'linkedin:member'])
    expect(targets.find(entry => entry.id === 'linkedin:member')?.label).toBe('Ada Obi (personal)')
    const diagnostic = targets.find(entry => entry.id === 'linkedin')
    expect(diagnostic?.reason).toContain('"linkedin:page:1" names provider "facebook"')
    expect(diagnostic?.reason).toContain('"linkedin:member" was listed more than once')
  })
})

describe('SocialRegistry post routing', () => {
  it('routes a post to the provider owning the target id', async () => {
    const linkedin = new StubProvider('linkedin', [target('linkedin:member', 'linkedin', 'Ada Obi (personal)')])
    const facebook = new StubProvider('facebook', [target('facebook:page:1234', 'facebook', 'FrontStaff (Page)')])
    const ctx = await registryWith(linkedin, facebook)

    const result = await ctx.social.post({ target: 'facebook:page:1234', text: 'Doors open at nine.' })

    expect(result).toEqual({ id: 'facebook-post-1', url: 'https://facebook.example/1' })
    expect(facebook.posts).toEqual([{ target: 'facebook:page:1234', text: 'Doors open at nine.' }])
    expect(linkedin.posts).toEqual([])
  })

  it('publishes the text byte for byte', async () => {
    const linkedin = new StubProvider('linkedin', [target('linkedin:member', 'linkedin', 'Ada Obi (personal)')])
    const ctx = await registryWith(linkedin)
    const text = '  Two   spaces,\n\n\ttabs, and a trailing newline.\n'

    await ctx.social.post({ target: 'linkedin:member', text })

    expect(linkedin.posts[0]?.text).toBe(text)
  })

  it('names what exists when the target id is unknown', async () => {
    const ctx = await registryWith(
      new StubProvider('linkedin', [target('linkedin:member', 'linkedin', 'Ada Obi (personal)')]),
      new StubProvider('facebook', [target('facebook:page:1234', 'facebook', 'FrontStaff (Page)')]),
    )

    await expect(ctx.social.post({ target: 'twitter:me', text: 'hello' }))
      .rejects.toThrow('no social target "twitter:me"; these exist: facebook:page:1234, linkedin:member')
  })

  it('says so when nothing is registered at all', async () => {
    const ctx = new Context()
    await ctx.plugin(SocialRegistry)

    await expect(ctx.social.post({ target: 'linkedin:member', text: 'hello' }))
      .rejects.toThrow('no social target "linkedin:member": no social provider is registered')
  })

  it('refuses an unready target with the provider reason, without calling the provider', async () => {
    const linkedin = new StubProvider('linkedin', [
      target('linkedin:member', 'linkedin', 'Ada Obi (personal)', { ready: false, reason: 'the LinkedIn token expired; reconnect the account' }),
    ])
    const ctx = await registryWith(linkedin)

    await expect(ctx.social.post({ target: 'linkedin:member', text: 'hello' }))
      .rejects.toThrow('social target "linkedin:member" (Ada Obi (personal)) is not ready: the LinkedIn token expired; reconnect the account')
    expect(linkedin.posts).toEqual([])
  })

  it('refuses an unready target that gave no reason', async () => {
    const ctx = await registryWith(new StubProvider('linkedin', [
      target('linkedin:member', 'linkedin', 'Ada Obi (personal)', { ready: false }),
    ]))

    await expect(ctx.social.post({ target: 'linkedin:member', text: 'hello' }))
      .rejects.toThrow('is not ready: the provider gave no reason')
  })

  it('refuses a post to the stand-in left by a provider that could not list', async () => {
    const ctx = await registryWith(new StubProvider('facebook', new Error('the Page token expired')))

    await expect(ctx.social.post({ target: 'facebook', text: 'hello' }))
      .rejects.toThrow('the Page token expired')
  })

  it('refuses media a target does not accept, naming the target, before dispatch', async () => {
    const linkedin = new StubProvider('linkedin', [
      target('linkedin:member', 'linkedin', 'Ada Obi (personal)', { accepts: { text: true, image: true, video: false } }),
    ])
    const ctx = await registryWith(linkedin)

    await expect(ctx.social.post({
      target: 'linkedin:member',
      text: 'Our new spot.',
      media: [{ path: '/w/clip.mp4', kind: 'video' }],
    })).rejects.toThrow('social target "linkedin:member" (Ada Obi (personal)) does not accept video: /w/clip.mp4')
    expect(linkedin.posts).toEqual([])
  })

  it('refuses text a target does not accept, and an empty post', async () => {
    const imageOnly = new StubProvider('gallery', [
      target('gallery:wall', 'gallery', 'The wall', { accepts: { text: false, image: true, video: false } }),
    ])
    const ctx = await registryWith(imageOnly)

    await expect(ctx.social.post({ target: 'gallery:wall', text: 'a caption' }))
      .rejects.toThrow('social target "gallery:wall" (The wall) does not accept text')
    await expect(ctx.social.post({ target: 'gallery:wall', text: '' }))
      .rejects.toThrow('nothing to post to "gallery:wall" (The wall): the request carries neither text nor media')
    expect(imageOnly.posts).toEqual([])
  })

  it('accepts an image-only post to a target that takes no text', async () => {
    const imageOnly = new StubProvider('gallery', [
      target('gallery:wall', 'gallery', 'The wall', { accepts: { text: false, image: true, video: false } }),
    ])
    const ctx = await registryWith(imageOnly)

    await ctx.social.post({ target: 'gallery:wall', text: '', media: [{ path: '/w/shot.png', kind: 'image', alt: 'The wall at dusk' }] })

    expect(imageOnly.posts[0]?.media).toEqual([{ path: '/w/shot.png', kind: 'image', alt: 'The wall at dusk' }])
  })
})
