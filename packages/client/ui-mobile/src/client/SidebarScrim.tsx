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
 * It also closes the drawer on any navigation made from inside it — a session
 * row, or a panel row such as Plugins or Memory System. On a phone the drawer
 * covers what it just opened, so a tap that leaves the list on screen reads as
 * a tap that did nothing. The signals are the selected panel and the session
 * the main view retains, not a tap on a row: a row is one of several ways each
 * becomes current, and the drawer should follow the outcome rather than one of
 * its causes.
 * @param props.close - collapse the sidebar (the layout toggle).
 */
export function SidebarScrim({ close, useSessions, usePanelInfo }: SidebarScrimProps) {
  const panelId = usePanelInfo(info => info.activePanelId)
  const sessionId = useSessions(list =>
    Object.values(list.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id)
  const shown = useRef({ panelId, sessionId, mounted: false })
  useEffect(() => {
    const previous = shown.current
    shown.current = { panelId, sessionId, mounted: true }
    // The first render is not a navigation, and neither is the session list
    // resolving afterwards into a main view that was already the destination.
    if (!previous.mounted) return
    const movedPanel = panelId !== previous.panelId
    const movedSession = sessionId !== previous.sessionId && previous.sessionId !== undefined
    if (!movedPanel && !movedSession) return
    if (!globalThis.matchMedia(PHONE).matches) return
    // The drawer is the expanded sidebar; a collapsed rail has nothing to close.
    const frame = globalThis.document.querySelector('[data-shell-frame]')
    if (frame === null || frame.hasAttribute('data-sidebar-collapsed')) return
    close()
  }, [panelId, sessionId, close])
  return <div data-mobile-sidebar-scrim aria-hidden="true" onClick={() => { close() }} />
}
