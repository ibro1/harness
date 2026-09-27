/**
 * Browser half: the WhatsApp plugin page. Registers one page into the Plugins
 * page (`plugins.item`, when the Host answers its status route) that links an
 * account by QR,
 * shows the linked state, disconnects, and approves or discards the messages
 * the agent has queued to send. All behaviour talks to the host /whatsapp/*
 * routes; this half owns only the card and its copy.
 * @module @deepseek-ai/dsh-client-ui-whatsapp/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only merges: the plugins.item SlotMap entry, ctx.locale, and the
// SlotRegistry face.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, zh, type WhatsAppKey } from './locales.ts'
import { WhatsAppCard } from './WhatsAppCard.tsx'

export type { WhatsAppKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WhatsApp card copy. */
    'whatsapp': WhatsAppKey
  }
}

/** Locale dictionary namespace owned by this plugin. */
const NS = 'whatsapp'

/** Services this plugin injects. */
export const inject = ['slots', 'locale']

/**
 * Whether the Host composes the WhatsApp plugin. The plugin has nothing to
 * configure, so it has no settings form whose presence could gate the page;
 * its own status route does instead. Only a JSON answer means the plugin is
 * there: a path no route claims answers 404 or with the web app's HTML shell.
 * @returns true when GET /whatsapp/status answers JSON.
 */
export async function hostServesWhatsApp(): Promise<boolean> {
  try {
    const response = await fetch('/whatsapp/status')
    return (response.headers.get('content-type') ?? '').includes('application/json')
  } catch (_error) {
    // No answer at all reads as no plugin; the page is simply not listed.
    return false
  }
}

/**
 * Apply the plugin: register the dictionaries and mount the WhatsApp page on
 * the Plugins page when the Host composes the plugin.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-whatsapp: dictionaries')

  const register = () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: 'whatsapp',
    order: 90,
    label: () => t('title'),
    locale: NS,
  }, WhatsAppCard))

  // Probed once per page load: whether the plugin is composed changes only
  // with a redeploy, which reloads the page.
  ctx.effect(() => {
    let off: (() => void) | undefined
    let live = true
    void hostServesWhatsApp().then((served) => {
      if (served && live) off = register()
    })
    return () => {
      live = false
      off?.()
    }
  }, 'ui-whatsapp: configuration page')
}
