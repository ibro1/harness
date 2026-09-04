/**
 * Browser entry: the account surface the password gate needs but the
 * application does not otherwise offer.
 *
 * Both contributions are slot registrations, so this package adds a sign-out
 * control and a Settings section without editing any component that ships
 * upstream.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SignOutAction } from './SignOutAction.tsx'
import { AccountSection } from './AccountSection.tsx'

/**
 * Mount the sign-out control and the account settings section.
 * @param ctx - client context.
 */
export function apply(ctx: Context): void {
  // Sidebar footer actions stack above Settings, which is where an account
  // action is expected rather than floating over the composer.
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'sign-out',
  }, SignOutAction))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'account',
    order: 40,
    label: 'Account',
  }, AccountSection))
}
