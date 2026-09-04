/** Settings section linking to the account pages the password gate serves. */

import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './AccountSection.module.css'

/** Settings-section owner share. */
export type AccountSectionProps = PropsRuntime<'settings.section'>

/** One row: where it goes and why. */
const ROWS: readonly { href: string; title: string; detail: string }[] = [
  {
    href: '/auth/sessions',
    title: 'Sessions',
    detail: 'Browsers signed in to this account. Revoke one, or sign out every other browser.',
  },
  {
    href: '/auth/git-key',
    title: 'Git access key',
    detail: 'The SSH public key agents use to reach your repositories. Add it as a deploy key or an account key.',
  },
]

/**
 * Render the account rows.
 *
 * These pages are served by the password gate rather than the application, so
 * each row is a link out rather than a panel: the gate owns the session and key
 * state, and mirroring it through the app's RPC surface would duplicate it.
 * They open in a new tab so the harness keeps its state.
 * @returns the section content.
 */
export function AccountSection(_props: AccountSectionProps): ReactNode {
  return (
    <div className={css.rows}>
      {ROWS.map(row => (
        <a key={row.href} className={css.row} href={row.href} target="_blank" rel="noreferrer">
          <span className={css.text}>
            <span className={css.title}>{row.title}</span>
            <span className={css.detail}>{row.detail}</span>
          </span>
          <span className={css.open}>Open ↗</span>
        </a>
      ))}
    </div>
  )
}
