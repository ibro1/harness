/** Settings section linking to the account pages the password gate serves. */

import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './AccountSection.module.css'

/** Settings-section owner share. */
export type AccountSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'settings'>

/** One row: where it goes and why. */
const ROWS = [
  { href: '/auth/sessions', title: 'account.sessions.title', detail: 'account.sessions.detail' },
  { href: '/auth/git-key', title: 'account.gitKey.title', detail: 'account.gitKey.detail' },
] as const

/**
 * Render the account rows.
 *
 * These pages are served by the password gate rather than the application, so
 * each row is a link out rather than a panel: the gate owns the session and key
 * state, and mirroring it through the app's RPC surface would duplicate it.
 * They open in a new tab so the harness keeps its state.
 * @returns the section content.
 */
export function AccountSection({ t }: AccountSectionProps): ReactNode {
  return (
    <div className={css.rows}>
      {ROWS.map(row => (
        <a key={row.href} className={css.row} href={row.href} target="_blank" rel="noreferrer">
          <span className={css.text}>
            <span className={css.title}>{t(row.title)}</span>
            <span className={css.detail}>{t(row.detail)}</span>
          </span>
          <span className={css.open}>{t('account.open')}</span>
        </a>
      ))}
    </div>
  )
}
