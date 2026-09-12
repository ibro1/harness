/**
 * Browser half: the social plugin card. Registers one card into the
 * Settings → Plugins section (`settings.plugin.item`, keyed by the `social`
 * settings namespace the host plugin serves) that shows every target the agent
 * can post to, how each credential stands, which targets publish without
 * asking, and a Disconnect per provider.
 *
 * There is deliberately no credential field. An account is connected by asking
 * the agent, which walks the provider's authorization flow and stores the grant
 * through the credential seam; this card shows the resulting state, which is a
 * different thing from configuration. All behaviour talks to the host /social/*
 * routes; this half owns only the card and its copy.
 * @module @deepseek-ai/dsh-client-ui-social/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only merges: the settings.plugin.item SlotMap entry, ctx.locale, and the
// SlotRegistry face.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, zh, type SocialKey } from './locales.ts'
import { SocialCard } from './SocialCard.tsx'

export type { SocialKey } from './locales.ts'
export type { SocialCardProps } from './SocialCard.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Social card copy. */
    'social': SocialKey
  }
}

/** Locale dictionary namespace owned by this plugin. */
const NS = 'social'

/**
 * The settings namespace the host plugin serves and this card is keyed to. The
 * plugin-config tab dispatches a card only when its key is in the served set,
 * so the two must agree.
 */
const SOCIAL_NS = 'social'

/** Services this plugin injects. */
export const inject = ['slots', 'locale']

/**
 * Apply the plugin: register the dictionaries and mount the social card into
 * the plugin configuration section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-social: dictionaries')

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: SOCIAL_NS,
    locale: NS,
  }, SocialCard))
}
