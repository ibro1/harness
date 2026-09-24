// @vitest-environment jsdom

/**
 * The scrim's two ways of closing the mobile drawer: a tap outside it, and a
 * session becoming current while it covers the conversation.
 */

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarScrim } from '../src/client/SidebarScrim.tsx'
import type { SidebarScrimProps } from '../src/client/SidebarScrim.tsx'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

/** Stand in for the shell frame, open or collapsed as the drawer would be. */
function frame(collapsed: boolean): void {
  const element = document.createElement('div')
  element.setAttribute('data-shell-frame', '')
  if (collapsed) element.setAttribute('data-sidebar-collapsed', 'true')
  document.body.append(element)
}

/** Report the viewport the drawer opens at, or a desktop one. */
function viewport(phone: boolean): void {
  vi.stubGlobal('matchMedia', () => ({ matches: phone }))
}

/** One session list holding exactly the given id in the main view. */
function sessions(id: string | undefined) {
  const byId = id === undefined ? {} : { [id]: { id, retainedBy: { mainView: 1 } } }
  return (select: (list: unknown) => unknown) => select({ byId })
}

/** The selected main panel, as the layout store reports it. */
function panel(id: string | null) {
  return (select: (info: unknown) => unknown) => select({ activePanelId: id })
}

/** Where the main view is: a panel, or a session when no panel is selected. */
interface Where { panel?: string | null; session?: string | undefined }

/** Render the scrim over one destination, recording every close. */
function show(where: Where, close = vi.fn()) {
  const props = (at: Where) => ({
    close,
    useSessions: sessions(at.session),
    usePanelInfo: panel(at.panel ?? null),
  } as unknown as SidebarScrimProps)
  const view = render(<SidebarScrim {...props(where)} />)
  return {
    close,
    view,
    rerender: (next: Where) => { view.rerender(<SidebarScrim {...props(next)} />) },
  }
}

describe('SidebarScrim', () => {
  it('closes the drawer when it is tapped', () => {
    viewport(true)
    frame(false)
    const { close, view } = show({ session: 'session-a' })
    fireEvent.click(view.container.firstChild as Element)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the drawer when a session becomes current on a phone', () => {
    // The reported defect: picking a session from the drawer left the drawer
    // open over the conversation it had just opened.
    viewport(true)
    frame(false)
    const { close, rerender } = show({ session: 'session-a' })
    expect(close).not.toHaveBeenCalled()
    rerender({ session: 'session-b' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('leaves the drawer alone on a viewport that never opened one', () => {
    viewport(false)
    frame(false)
    const { close, rerender } = show({ session: 'session-a' })
    rerender({ session: 'session-b' })
    expect(close).not.toHaveBeenCalled()
  })

  it('does not toggle a collapsed rail back open', () => {
    // close() is the layout toggle, so calling it while the sidebar is already
    // collapsed would open the drawer instead of closing it.
    viewport(true)
    frame(true)
    const { close, rerender } = show({ session: 'session-a' })
    rerender({ session: 'session-b' })
    expect(close).not.toHaveBeenCalled()
  })

  it('stays put when the main view holds no session', () => {
    viewport(true)
    frame(false)
    const { close, rerender } = show({ session: undefined })
    rerender({ session: 'session-a' })
    expect(close).not.toHaveBeenCalled()
  })

  it('closes the drawer when a panel is opened from inside it', () => {
    // The second report: Plugins and Memory System are panels, not sessions,
    // so watching the session alone left the drawer open over them.
    viewport(true)
    frame(false)
    const { close, rerender } = show({ panel: null, session: 'session-a' })
    rerender({ panel: 'plugins', session: 'session-a' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the drawer moving between two panels', () => {
    viewport(true)
    frame(false)
    const { close, rerender } = show({ panel: 'plugins' })
    rerender({ panel: 'memory' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the drawer returning from a panel to the conversation', () => {
    viewport(true)
    frame(false)
    const { close, rerender } = show({ panel: 'plugins', session: 'session-a' })
    rerender({ panel: null, session: 'session-a' })
    expect(close).toHaveBeenCalledTimes(1)
  })
})
