/**
 * Browser half: the WhatsApp plugin card. Registers one card into the
 * Settings → Plugins section (`settings.plugin.item`, keyed by the `whatsapp`
 * settings namespace the host plugin serves) that links an account by QR,
 * shows the linked state, disconnects, and approves or discards the messages
 * the agent has queued to send. All behaviour talks to the host /whatsapp/*
 * routes; this half owns only the card and its copy.
 * @module @deepseek-ai/dsh-client-ui-whatsapp/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only merges: the settings.plugin.item SlotMap entry, ctx.locale, and the
// SlotRegistry face.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
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

/**
 * The settings namespace the host plugin serves and this card is keyed to. The
 * plugin-config tab dispatches a card only when its key is in the served set,
 * so the two must agree.
 */
const WHATSAPP_NS = 'whatsapp'

/** Services this plugin injects. */
export const inject = ['slots', 'locale']

/**
 * Apply the plugin: register the dictionaries and mount the WhatsApp card into
 * the plugin configuration section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-whatsapp: dictionaries')

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: WHATSAPP_NS,
    locale: NS,
  }, WhatsAppCard))
}
