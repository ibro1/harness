/** What the browser half registers, when, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, NS } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

/** One Host view of a served namespace. */
function view(ns: string) {
  return { ns, schema: {}, value: {}, applies: 'live', secrets: [], revision: 0 }
}

/** @param served - namespaces the Host describes. */
async function bench(served: string[]) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const describeSettings = vi.fn(() => Promise.resolve({
    ok: true, value: { writable: true, hasDocument: true, namespaces: served.map(ns => view(ns)) },
  }))
  new TestRemote(ctx, { settings: { describe: describeSettings } })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'plugins.item': { kind: 'list', scope: 'root' } } } as never, () => null)
  return { ctx, slots, describeSettings }
}

describe('ui-settings-operations apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'configForms'])
  })

  it('registers one page per served namespace, titled in the active locale', async () => {
    const { ctx, slots } = await bench(['dokploy', 'postgres', 'cloudflare'])

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(3) })
    const entries = slots.entries('plugins.item')
    expect(entries.map(entry => [entry.options.id, entry.options.order])).toEqual([
      ['dokploy', 50], ['postgres', 60], ['cloudflare', 70],
    ])
    expect(entries.map(entry => resolveSlotLabel(entry.options.label))).toEqual(['Dokploy', 'Postgres', 'Cloudflare'])
    expect(entries.every(entry => entry.locale === NS)).toBe(true)
  })

  it('registers only the pages whose plugin the deployment composes', async () => {
    const { ctx, slots, describeSettings } = await bench(['cloudflare'])

    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })

    expect(slots.entries('plugins.item')[0]!.options.id).toBe('cloudflare')
  })

  it('registers the SEO and ads employee cards and their pages while the Host serves seo-employee', async () => {
    const { ctx, slots } = await bench(['seo-employee'])

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(4) })
    const entries = slots.entries('plugins.item')
    expect(entries.map(entry => [entry.options.id, entry.options.order])).toEqual([
      ['seo-employee', 82], ['seo-employee-sites', 83], ['ads-employee', 84], ['ads-employee-proposals', 85],
    ])
    expect(entries.map(entry => resolveSlotLabel(entry.options.label))).toEqual(['SEO employee', 'SEO sites', 'Ads employee', 'Ads proposals'])
  })

  it('registers the meeting reminders card while the Host serves meeting-reminders', async () => {
    const { ctx, slots } = await bench(['meeting-reminders'])

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const [entry] = slots.entries('plugins.item')
    expect([entry!.options.id, entry!.options.order, resolveSlotLabel(entry!.options.label)]).toEqual(['meeting-reminders', 87, 'Meeting reminders'])
  })

  it('registers the WhatsApp delegate card while the Host serves whatsapp-delegate', async () => {
    const { ctx, slots } = await bench(['whatsapp-delegate'])

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const [entry] = slots.entries('plugins.item')
    expect([entry!.options.id, entry!.options.order, resolveSlotLabel(entry!.options.label)]).toEqual(['whatsapp-delegate', 88, 'WhatsApp delegate'])
  })

  it('registers the YouTube niche scout card while the Host serves youtube-niche-scout', async () => {
    const { ctx, slots } = await bench(['youtube-niche-scout'])

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const [entry] = slots.entries('plugins.item')
    expect([entry!.options.id, entry!.options.order, resolveSlotLabel(entry!.options.label)]).toEqual(['youtube-niche-scout', 89, 'YouTube niche scout'])
  })

  it('registers the tools employee card while the Host serves tools-employee', async () => {
    const { ctx, slots } = await bench(['tools-employee'])

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const [entry] = slots.entries('plugins.item')
    expect([entry!.options.id, entry!.options.order, resolveSlotLabel(entry!.options.label)]).toEqual(['tools-employee', 91, 'Tools employee'])
  })

  it('removes its pages with the plugin', async () => {
    const { ctx, slots } = await bench(['dokploy', 'postgres', 'cloudflare'])
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(3) })

    await fiber.dispose()

    expect(slots.entries('plugins.item')).toHaveLength(0)
  })
})
