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

/** Render the scrim over one session list, recording every close. */
function show(id: string | undefined, close = vi.fn()) {
  const view = render(<SidebarScrim {...({
    close, useSessions: sessions(id),
  } as unknown as SidebarScrimProps)} />)
  const rerender = (next: string | undefined) => {
    view.rerender(<SidebarScrim {...({
      close, useSessions: sessions(next),
    } as unknown as SidebarScrimProps)} />)
  }
  return { close, rerender, view }
}

describe('SidebarScrim', () => {
  it('closes the drawer when it is tapped', () => {
    viewport(true)
    frame(false)
    const { close, view } = show('session-a')
    fireEvent.click(view.container.firstChild as Element)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the drawer when a session becomes current on a phone', () => {
    // The reported defect: picking a session from the drawer left the drawer
    // open over the conversation it had just opened.
    viewport(true)
    frame(false)
    const { close, rerender } = show('session-a')
    expect(close).not.toHaveBeenCalled()
    rerender('session-b')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('leaves the drawer alone on a viewport that never opened one', () => {
    viewport(false)
    frame(false)
    const { close, rerender } = show('session-a')
    rerender('session-b')
    expect(close).not.toHaveBeenCalled()
  })

  it('does not toggle a collapsed rail back open', () => {
    // close() is the layout toggle, so calling it while the sidebar is already
    // collapsed would open the drawer instead of closing it.
    viewport(true)
    frame(true)
    const { close, rerender } = show('session-a')
    rerender('session-b')
    expect(close).not.toHaveBeenCalled()
  })

  it('stays put when the main view holds no session', () => {
    viewport(true)
    frame(false)
    const { close, rerender } = show('session-a')
    rerender(undefined)
    expect(close).not.toHaveBeenCalled()
  })
})
