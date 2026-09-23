/**
 * Browser half: the WhatsApp plugin page. Registers one page into the Plugins
 * page (`plugins.item`, while the Host serves the `whatsapp` settings
 * namespace) that links an account by QR,
 * shows the linked state, disconnects, and approves or discards the messages
 * the agent has queued to send. All behaviour talks to the host /whatsapp/*
 * routes; this half owns only the card and its copy.
 * @module @deepseek-ai/dsh-client-ui-whatsapp/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only merges: the plugins.item SlotMap entry, ctx.locale, ctx.settingsScope,
// and the SlotRegistry face.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
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

/** The settings namespace the host plugin serves, which gates this page. */
const WHATSAPP_NS = 'whatsapp'

/** Services this plugin injects. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Apply the plugin: register the dictionaries and mount the WhatsApp page on
 * the Plugins page while the Host serves its namespace.
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

  // The page registers only while the Host serves this plugin's settings
  // namespace, so a deployment that does not compose it shows no dead entry.
  // The shared SettingsScope mirror updates after document commits and reconnects.
  const describeFace = ctx.settingsScope.describe()
  ctx.effect(() => {
    let off: (() => void) | undefined
    const sync = (): void => {
      const served = describeFace.getSnapshot().view?.namespaces.some(view => view.ns === WHATSAPP_NS) ?? false
      if (served && off === undefined) off = register()
      else if (!served && off !== undefined) {
        off()
        off = undefined
      }
    }
    const unsubscribe = describeFace.subscribe(sync)
    void describeFace.ensure()
    sync()
    return () => {
      unsubscribe()
      off?.()
    }
  }, 'ui-whatsapp: configuration page')
}
