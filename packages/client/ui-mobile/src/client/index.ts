/**
 * Browser half: mount the mobile stylesheet. Pure presentation — no services,
 * no copy — so the layout and settings modal respond to small screens without
 * changing any component.
 * @module @deepseek-ai/dsh-client-ui-mobile/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { installMobileStyles } from './styles.ts'

/**
 * Apply the plugin: install the responsive stylesheet.
 * @param ctx - the client plugin context.
 */
export function apply(ctx: ClientContext): void {
  installMobileStyles(ctx)
}
