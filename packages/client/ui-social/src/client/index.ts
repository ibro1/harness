/**
 * Browser half: the social plugin page. Registers one page into the Plugins
 * page (`plugins.item`, when the Host answers its status route) that shows
 * every target the agent
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
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, zh, type SocialKey } from './locales.ts'
import { SocialCard } from './SocialCard.tsx'
import { SocialCredentialsController } from './app-credentials-controller.ts'
// Type-only merges: ctx.configForms, and the ctx.remote credentials namespace
// the write-only secret controls are written through.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'

export type { SocialKey } from './locales.ts'
export type { SocialCardProps } from './SocialCard.tsx'
export type { AppCredentialsSectionProps } from './AppCredentialsSection.tsx'
export type {
  AppCredentialSpec, AppCredentialState, SocialCredentialsFace,
} from './app-credentials-controller.ts'
export { APP_CREDENTIAL_SPECS } from './app-credentials-controller.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Social card copy. */
    'social': SocialKey
  }
}

/** Locale dictionary namespace owned by this plugin. */
const NS = 'social'

/**
 * Whether the Host composes the social plugins. The tool plugin has nothing to
 * configure, so it has no settings form whose presence could gate the page;
 * its own status route does instead. Only a JSON answer means the plugin is
 * there: a path no route claims answers 404 or with the web app's HTML shell.
 * @returns true when GET /social/status answers JSON.
 */
export async function hostServesSocial(): Promise<boolean> {
  try {
    const response = await fetch('/social/status')
    return (response.headers.get('content-type') ?? '').includes('application/json')
  } catch (_error) {
    // No answer at all reads as no plugin; the page is simply not listed.
    return false
  }
}

/**
 * Services this plugin injects. `configForms` and the credentials namespace
 * are required rather than optional: the card's application-credential forms
 * are half of what it is for, and a card that silently dropped them would look
 * like a deployment with nothing to configure.
 */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.credentials']

/**
 * Apply the plugin: register the dictionaries and mount the social card into
 * the plugin configuration section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-social: dictionaries')

  const credentials = new SocialCredentialsController(ctx)

  const register = () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: 'social',
    order: 80,
    label: () => t('title'),
    locale: NS,
    inject: () => credentials.inject(),
  }, SocialCard))

  // Probed once per page load: whether the plugins are composed changes only
  // with a redeploy, which reloads the page.
  ctx.effect(() => {
    let off: (() => void) | undefined
    let live = true
    void hostServesSocial().then((served) => {
      if (served && live) off = register()
    })
    return () => {
      live = false
      off?.()
    }
  }, 'ui-social: configuration page')
}
