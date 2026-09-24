import { useEffect, useRef } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only merge: adds `useSessions` to the global standard props.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

/** Injected by the registration: collapse the sidebar. */
export type SidebarScrimProps = PropsRuntime<'shell.overlay'> & { close: () => void }

/** The phone breakpoint mobile.css opens the drawer at. */
const PHONE = '(max-width: 768px)'

/**
 * A full-screen scrim behind the open mobile sidebar drawer. Tapping it closes
 * the drawer — the standard tap-outside-to-close. It replaces the old `::before`
 * pseudo-element scrim, which could not take a tap. Decorative (aria-hidden);
 * CSS (mobile.css) shows it only on a phone while the sidebar is expanded, so on
 * desktop and on a collapsed rail it renders nothing interactive.
 *
 * It also closes the drawer when a session is opened from inside it. On a phone
 * the drawer covers the conversation, so picking a session and then being left
 * looking at the list reads as a tap that did nothing. The signal is the
 * session the main view retains, not a tap on a row: a row is one of several
 * ways a session becomes current, and the drawer should follow the outcome
 * rather than one of its causes.
 * @param props.close - collapse the sidebar (the layout toggle).
 */
export function SidebarScrim({ close, useSessions }: SidebarScrimProps) {
  const openId = useSessions(list =>
    Object.values(list.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id)
  const shown = useRef(openId)
  useEffect(() => {
    const previous = shown.current
    shown.current = openId
    // First render is not a navigation, and neither is losing the main view.
    if (openId === undefined || openId === previous) return
    if (!globalThis.matchMedia(PHONE).matches) return
    // The drawer is the expanded sidebar; a collapsed rail has nothing to close.
    const frame = globalThis.document.querySelector('[data-shell-frame]')
    if (frame === null || frame.hasAttribute('data-sidebar-collapsed')) return
    close()
  }, [openId, close])
  return <div data-mobile-sidebar-scrim aria-hidden="true" onClick={() => { close() }} />
}
