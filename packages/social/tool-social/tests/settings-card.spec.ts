/**
 * The `social` settings namespace against a real Cordis context: that it is
 * registered once the settings service arrives, and that a composition without
 * one keeps the tools.
 *
 * A real context rather than the stub the tool suite uses, because the defect
 * this covers was entirely a matter of timing. The settings service is
 * file-backed and resolves its `Service.init` off disk, so it is reliably
 * absent at the moment this plugin applies. Sampling it there with
 * `ctx.get('settings')?.register(...)` read undefined on every boot and
 * registered nothing, silently — the routes mounted, the card shipped, and the
 * Settings → Plugins tab listed no social card at all, because it dispatches a
 * card only when its key is a namespace the Host serves. A stub that already
 * holds the service when `apply` runs cannot see that; only a context where
 * the service lands afterwards can.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

/** The namespaces a stub settings service was asked to serve, in order. */
type Served = string[]

/**
 * A context carrying the services this plugin requires, and no settings.
 * @param served - collects the namespaces the settings service is handed.
 * @returns the context, and the tool names registered on it.
 */
function compose(served: Served): { ctx: Context; tools: string[] } {
  const tools: string[] = []
  const ctx = new Context()
  ctx.provide('tools', { register: (tool: { name: string }) => { tools.push(tool.name); return () => {} } } as never)
  ctx.provide('webServer', { register: () => () => {} } as never)
  ctx.provide('social', { targets: () => Promise.resolve([]), post: () => Promise.resolve({ id: 'x' }) } as never)
  void served
  return { ctx, tools }
}

/** Mount a stub settings service that records the namespaces it is given. */
function provideSettings(ctx: Context, served: Served): void {
  ctx.provide('settings', {
    register: (ns: string) => {
      served.push(ns)
      return { get: () => ({}), watch: () => () => {} }
    },
  } as never)
}

describe('the social settings namespace', () => {
  it('is registered when the settings service arrives after this plugin applies', async () => {
    const served: Served = []
    const { ctx, tools } = compose(served)

    apply(ctx, {})

    // The condition every real boot is in: the tools are up and the
    // file-backed settings service has not resolved yet.
    expect(tools.sort()).toEqual(['social_post', 'social_targets'])
    expect(served).toEqual([])

    provideSettings(ctx, served)

    await vi.waitFor(() => {
      expect(served).toEqual(['social'])
    })
  })

  it('keeps the tools when no settings service is ever composed', async () => {
    const served: Served = []
    const { ctx, tools } = compose(served)

    apply(ctx, {})
    await Promise.resolve()

    expect(tools.sort()).toEqual(['social_post', 'social_targets'])
    expect(served).toEqual([])
  })
})
