/**
 * Browser half: mount the mobile stylesheet, and — so the sidebar drawer closes
 * on an outside tap — a real scrim element (a pseudo-element cannot take a tap)
 * on the shell.overlay slot, wired to the layout toggle.
 * @module @deepseek-ai/dsh-client-ui-mobile/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only merges: the shell.overlay SlotMap entry + the ctx.layout service.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { installMobileStyles } from './styles.ts'
import { SidebarScrim } from './SidebarScrim.tsx'

/** Services this plugin injects. */
export const inject = ['slots', 'layout']

/**
 * Apply the plugin: install the responsive stylesheet and mount the sidebar
 * scrim.
 * @param ctx - the client plugin context.
 */
export function apply(ctx: ClientContext): void {
  installMobileStyles(ctx)

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'mobile-sidebar-scrim',
    inject: () => ({ close: () => { ctx.layout.toggleSidebar() } }),
  }, SidebarScrim))
}
