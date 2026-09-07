import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Injected by the registration: collapse the sidebar. */
export type SidebarScrimProps = PropsRuntime<'shell.overlay'> & { close: () => void }

/**
 * A full-screen scrim behind the open mobile sidebar drawer. Tapping it closes
 * the drawer — the standard tap-outside-to-close. It replaces the old `::before`
 * pseudo-element scrim, which could not take a tap. Decorative (aria-hidden);
 * CSS (mobile.css) shows it only on a phone while the sidebar is expanded, so on
 * desktop and on a collapsed rail it renders nothing interactive.
 * @param props.close - collapse the sidebar (the layout toggle).
 */
export function SidebarScrim({ close }: SidebarScrimProps) {
  return <div data-mobile-sidebar-scrim aria-hidden="true" onClick={() => { close() }} />
}
