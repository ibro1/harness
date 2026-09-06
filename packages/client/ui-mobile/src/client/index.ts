/**
 * Browser half: mount the mobile stylesheet and mobile details drawer toggle.
 * @module @deepseek-ai/dsh-client-ui-mobile/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { installMobileStyles } from './styles.ts'
import { en, zh, type MobileKey } from './locales.ts'
import { MobileDetailsToggle } from './MobileDetailsToggle.tsx'

export type { MobileKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Mobile responsive layer copy. */
    mobile: MobileKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'mobile'

/** Services required by the mobile plugin. */
export const inject = ['slots', 'layout', 'locale']

/**
 * Apply the plugin: install the responsive stylesheet and register details toggle.
 * @param ctx - the client plugin context.
 */
export function apply(ctx: ClientContext): void {
  installMobileStyles(ctx)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-mobile: dictionaries')

  ctx.effect(
    () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'mobile-details-toggle',
      locale: NS,
      inject: () => ({
        openDetails: () => { ctx.layout.openDetails() },
        closeDetails: () => { ctx.layout.closeDetails() },
      }),
    }, MobileDetailsToggle),
    'ui-mobile: details toggle registration',
  )
}
