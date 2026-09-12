/**
 * The social tools driven against a stub seam, a stub approval channel, and a
 * real temporary workspace: the catalog listing, the approval prompt's exact
 * contents, every refusal that leaves the provider's `post` uncalled, and the
 * workspace containment of model-supplied attachment paths. The `social`
 * service and the approval channel are stubs, because this package owns the
 * tools and the approval enforcement, not the registry or the approval seam.
 */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SocialPostRequest, SocialPostResult, SocialTarget } from '@deepseek-ai/dsh-social'
import { apply, type Config } from '../src/index.ts'

/** The two model-facing entry points, as the stub registry records them. */
interface RecordedTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<{ text: string; id?: string; url?: string }>
  presentCall?: (args: unknown) => unknown
}

/** One approval answer, and the prompt the person was shown to get it. */
interface RecordedApproval {
  toolName: string
  reason: string
}

/** What a mounted plugin exposes to a test. */
interface Mounted {
  tools: Map<string, RecordedTool>
  posts: SocialPostRequest[]
  asked: RecordedApproval[]
}

let workspace: string

beforeEach(async () => {
  // realpath: on macOS the temp root is itself a symlink, and containment
  // compares canonical paths.
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-social-')))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

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

const TARGETS: SocialTarget[] = [
  target('linkedin:member', 'linkedin', 'Ada Obi (personal)'),
  target('facebook:page:1234', 'facebook', 'FrontStaff (Page)'),
  target('facebook:page:9', 'facebook', 'Dormant (Page)', { ready: false, reason: 'the Page token expired; reconnect it' }),
]

interface MountOptions {
  /** What `ctx.social.targets()` answers; defaults to {@link TARGETS}. */
  targets?: SocialTarget[]
  /** The approval outcome, or `'none'` for a composition with no approval service. */
  approval?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | 'none'
  /** Plugin config. */
  config?: Config
}

/** Mount the plugin against a stub seam and a stub approval channel. */
function mount(options: MountOptions = {}): Mounted {
  const tools = new Map<string, RecordedTool>()
  const posts: SocialPostRequest[] = []
  const asked: RecordedApproval[] = []
  const outcome = options.approval ?? 'allowed-once'
  const approval = outcome === 'none' ? undefined : {
    request(request: { toolName: string; reason?: string }) {
      asked.push({ toolName: request.toolName, reason: request.reason ?? '' })
      return Promise.resolve(outcome)
    },
  }
  const ctx = {
    effect(fn: () => unknown) { return fn() },
    get(service: string) { return service === 'approval' ? approval : undefined },
    tools: {
      register(tool: RecordedTool) { tools.set(tool.name, tool); return () => {} },
    },
    social: {
      targets: () => Promise.resolve(options.targets ?? TARGETS),
      post(request: SocialPostRequest): Promise<SocialPostResult> {
        posts.push(request)
        return Promise.resolve({ id: 'urn:post:1', url: 'https://linkedin.example/urn:post:1' })
      },
    },
  }
  apply(ctx as unknown as Context, options.config ?? {})
  return { tools, posts, asked }
}

/** A tool-run context carrying the temporary workspace as the session cwd. */
function execContext(): unknown {
  return {
    callId: 'call-1',
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: workspace } } },
  }
}

describe('social tools', () => {
  it('registers the catalog and the post tool', () => {
    const { tools } = mount()
    expect([...tools.keys()].sort()).toEqual(['social_post', 'social_targets'])
  })

  it('lists every target with what it accepts, and why an unready one cannot be used', async () => {
    const { tools } = mount()

    const out = await tools.get('social_targets')!.execute({}, execContext())

    expect(out.text).toContain('linkedin:member — Ada Obi (personal) [linkedin]: accepts text, images, video')
    expect(out.text).toContain('facebook:page:9 — Dormant (Page) [facebook]: NOT READY — the Page token expired; reconnect it')
  })

  it('says so when no account is connected', async () => {
    const { tools } = mount({ targets: [] })

    const out = await tools.get('social_targets')!.execute({}, execContext())

    expect(out.text).toBe('No social accounts are connected, so there is nothing to post to.')
  })

  it('shows the approving person the target, the text verbatim, and each attachment by name, kind and size', async () => {
    await writeFile(join(workspace, 'shot.png'), Buffer.alloc(2048))
    const { tools, asked, posts } = mount()

    await tools.get('social_post')!.execute({
      target: 'linkedin:member',
      text: '  Doors open at nine.\n\nBring a friend.\n',
      media: [{ path: 'shot.png', kind: 'image', alt: 'The wall at dusk' }],
    }, execContext())

    expect(asked).toHaveLength(1)
    expect(asked[0]?.toolName).toBe('social_post')
    expect(asked[0]?.reason).toBe([
      'Publish publicly to Ada Obi (personal) (linkedin:member) on linkedin.',
      '',
      '--- the post, exactly as it will be published ---',
      '  Doors open at nine.\n\nBring a friend.\n',
      '--- end of post ---',
      '',
      'Attachments:',
      '- shot.png — image, 2.0 KB — alt: The wall at dusk',
    ].join('\n'))
    expect(posts).toHaveLength(1)
  })

  it('says there are no attachments when the post carries none', async () => {
    const { asked, tools } = mount()

    await tools.get('social_post')!.execute({ target: 'linkedin:member', text: 'Just words.' }, execContext())

    expect(asked[0]?.reason).toContain('No attachments.')
  })

  it('publishes the approved text byte for byte, and reports where it went', async () => {
    const { tools, posts } = mount()
    const text = '  Two   spaces,\n\n\ttabs, and a trailing newline.\n'

    const out = await tools.get('social_post')!.execute({ target: 'linkedin:member', text }, execContext())

    expect(posts[0]).toEqual({ target: 'linkedin:member', text })
    expect(out.id).toBe('urn:post:1')
    expect(out.url).toBe('https://linkedin.example/urn:post:1')
    expect(out.text).toBe('Published to Ada Obi (personal) (linkedin:member). It is at https://linkedin.example/urn:post:1.')
  })

  it('sends each attachment with its canonical path and alt text', async () => {
    await mkdir(join(workspace, 'media'))
    await writeFile(join(workspace, 'media', 'clip.mp4'), Buffer.alloc(3 * 1024 * 1024))
    const { tools, posts, asked } = mount()

    await tools.get('social_post')!.execute({
      target: 'linkedin:member',
      text: 'A clip.',
      media: [{ path: './media/clip.mp4', kind: 'video' }],
    }, execContext())

    expect(posts[0]?.media).toEqual([{ path: join(workspace, 'media', 'clip.mp4'), kind: 'video' }])
    expect(asked[0]?.reason).toContain('- clip.mp4 — video, 3.0 MB')
  })
})

describe('social_post approval enforcement', () => {
  it('does not publish when the person rejects', async () => {
    const { tools, posts, asked } = mount({ approval: 'rejected' })

    await expect(tools.get('social_post')!.execute({ target: 'linkedin:member', text: 'Doors open at nine.' }, execContext()))
      .rejects.toThrow('the user rejected this post to "linkedin:member" (Ada Obi (personal)); nothing was published')

    expect(asked).toHaveLength(1)
    expect(posts).toEqual([])
  })

  it('does not publish when the approval is cancelled', async () => {
    const { tools, posts } = mount({ approval: 'cancelled' })

    await expect(tools.get('social_post')!.execute({ target: 'linkedin:member', text: 'hello' }, execContext()))
      .rejects.toThrow('approval for this post to "linkedin:member" was cancelled; nothing was published')
    expect(posts).toEqual([])
  })

  it('does not publish when no approval channel can answer', async () => {
    const { tools, posts } = mount({ approval: 'unavailable' })

    await expect(tools.get('social_post')!.execute({ target: 'linkedin:member', text: 'hello' }, execContext()))
      .rejects.toThrow('no approval channel is available; nothing was published')
    expect(posts).toEqual([])
  })

  it('does not publish when the composition has no approval service at all', async () => {
    const { tools, posts } = mount({ approval: 'none' })

    await expect(tools.get('social_post')!.execute({ target: 'linkedin:member', text: 'hello' }, execContext()))
      .rejects.toThrow('requires human approval, but no approval service is composed')
    expect(posts).toEqual([])
  })

  it('does not publish when the call has no agent to ask through', async () => {
    const { tools, posts } = mount()

    await expect(tools.get('social_post')!.execute(
      { target: 'linkedin:member', text: 'hello' },
      { callId: 'call-1', signal: new AbortController().signal },
    )).rejects.toThrow('social_post needs a session to resolve attachment paths against and a person to approve the post')
    expect(posts).toEqual([])
  })

  it('publishes without asking only for an id the composition exempted', async () => {
    const { tools, posts, asked } = mount({ config: { postWithoutApproval: ['facebook:page:1234'] } })

    await tools.get('social_post')!.execute({ target: 'facebook:page:1234', text: 'Staging.' }, execContext())
    expect(asked).toEqual([])
    expect(posts).toHaveLength(1)

    await tools.get('social_post')!.execute({ target: 'linkedin:member', text: 'Not staging.' }, execContext())
    expect(asked).toHaveLength(1)
    expect(posts).toHaveLength(2)
  })
})

describe('social_post refusals before the ask', () => {
  it('names what exists when the target id is unknown', async () => {
    const { tools, asked, posts } = mount()

    await expect(tools.get('social_post')!.execute({ target: 'twitter:me', text: 'hello' }, execContext()))
      .rejects.toThrow('no social target "twitter:me"; these exist: linkedin:member, facebook:page:1234, facebook:page:9')
    expect(asked).toEqual([])
    expect(posts).toEqual([])
  })

  it('says nothing is connected when there are no targets at all', async () => {
    const { tools } = mount({ targets: [] })

    await expect(tools.get('social_post')!.execute({ target: 'linkedin:member', text: 'hello' }, execContext()))
      .rejects.toThrow('no social account is connected')
  })

  it('refuses an unready target with its own reason, and never asks a person', async () => {
    const { tools, asked, posts } = mount()

    await expect(tools.get('social_post')!.execute({ target: 'facebook:page:9', text: 'hello' }, execContext()))
      .rejects.toThrow('social target "facebook:page:9" (Dormant (Page)) is not ready: the Page token expired; reconnect it')
    expect(asked).toEqual([])
    expect(posts).toEqual([])
  })

  it('refuses an unready target that gave no reason', async () => {
    const { tools } = mount({ targets: [target('linkedin:member', 'linkedin', 'Ada Obi (personal)', { ready: false })] })

    await expect(tools.get('social_post')!.execute({ target: 'linkedin:member', text: 'hello' }, execContext()))
      .rejects.toThrow('is not ready: the provider gave no reason')
  })

  it('refuses an attachment that walks out of the session workspace', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-social-outside-')))
    await writeFile(join(outside, 'secret.png'), Buffer.alloc(16))
    const { tools, asked, posts } = mount()

    await expect(tools.get('social_post')!.execute({
      target: 'linkedin:member',
      text: 'hello',
      media: [{ path: join(outside, 'secret.png'), kind: 'image' }],
    }, execContext())).rejects.toThrow('outside the session workspace')

    expect(asked).toEqual([])
    expect(posts).toEqual([])
    await rm(outside, { recursive: true, force: true })
  })

  it('refuses an attachment reached through a symlink pointing out of the workspace', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-social-outside-')))
    await writeFile(join(outside, 'secret.png'), Buffer.alloc(16))
    await symlink(join(outside, 'secret.png'), join(workspace, 'looks-local.png'))
    const { tools, posts } = mount()

    await expect(tools.get('social_post')!.execute({
      target: 'linkedin:member',
      text: 'hello',
      media: [{ path: 'looks-local.png', kind: 'image' }],
    }, execContext())).rejects.toThrow('outside the session workspace')

    expect(posts).toEqual([])
    await rm(outside, { recursive: true, force: true })
  })

  it('refuses the workspace directory itself, and a directory attachment', async () => {
    await mkdir(join(workspace, 'media'))
    const { tools } = mount()

    await expect(tools.get('social_post')!.execute({
      target: 'linkedin:member',
      text: 'hello',
      media: [{ path: '.', kind: 'image' }],
    }, execContext())).rejects.toThrow('outside the session workspace')

    await expect(tools.get('social_post')!.execute({
      target: 'linkedin:member',
      text: 'hello',
      media: [{ path: 'media', kind: 'image' }],
    }, execContext())).rejects.toThrow('cannot attach "media": it is not a file')
  })

  it('refuses an attachment that does not exist', async () => {
    const { tools, posts } = mount()

    await expect(tools.get('social_post')!.execute({
      target: 'linkedin:member',
      text: 'hello',
      media: [{ path: 'missing.png', kind: 'image' }],
    }, execContext())).rejects.toThrow('cannot attach "missing.png": no such file in the session workspace')
    expect(posts).toEqual([])
  })

  it('rejects arguments the schema refuses before anything runs', async () => {
    const { tools, posts } = mount()

    await expect(tools.get('social_post')!.execute({ target: 'linkedin:member' }, execContext()))
      .rejects.toThrow('invalid arguments')
    await expect(tools.get('social_post')!.execute({
      target: 'linkedin:member',
      text: 'hello',
      media: [{ path: 'shot.png', kind: 'audio' }],
    }, execContext())).rejects.toThrow('invalid arguments')
    expect(posts).toEqual([])
  })

  it('presents the call by its target, with the post text as the salient input', () => {
    const { tools } = mount()

    expect(tools.get('social_post')!.presentCall?.({ target: 'linkedin:member', text: 'Doors open at nine.' }))
      .toEqual({ card: 'generic', title: 'Post to linkedin:member', kind: 'other', rawInput: 'Doors open at nine.' })
    expect(tools.get('social_targets')!.presentCall?.({}))
      .toEqual({ card: 'generic', title: 'List social targets', kind: 'read' })
  })
})
