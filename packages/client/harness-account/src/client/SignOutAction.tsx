/** Sidebar footer action ending the browser session held by the password gate. */

import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SignOutAction.module.css'

/** Sidebar footer owner share: wide content versus the 56px rail. */
export type SignOutActionProps = PropsRuntime<'sidebar.footer.action'>

/**
 * Render the sign-out control beside Settings, labelled only when the sidebar
 * is wide. A plain link, not a fetch: `/auth/logout` revokes the session
 * server-side and redirects to the login page, so the app never renders
 * against a dead session.
 * @param props - sidebar footer owner props.
 * @returns the sign-out link.
 */
export function SignOutAction({ wide }: SignOutActionProps): ReactNode {
  return (
    <a
      className={wide ? css.action : `${css.action} ${css.rail}`}
      href="/auth/logout"
      title="Sign out"
      aria-label="Sign out"
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
      {wide ? <span className={css.label}>Sign out</span> : null}
    </a>
  )
}
