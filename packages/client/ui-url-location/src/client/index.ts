/**
 * Browser half: keeps the open main panel, and the view inside the Plugins
 * panel, in the address bar's hash, so a refresh, the back and forward
 * buttons, and a copied link return to the same page. The format is in
 * `location.ts`.
 *
 * The app has no router: the layout keeps the selected panel and the Plugins
 * panel keeps its view, both in memory. This plugin follows both and writes
 * the hash with `history.pushState`, one entry per move, and applies the hash
 * on load and on `popstate`. Panels and plugin pages register while the app
 * starts, some only after a request to the Host answers, so applying a place
 * retries until its panel exists; nothing is written to the address bar until
 * the place in it has been applied or abandoned, so a starting app never
 * overwrites the address it was opened with.
 *
 * The sign-in page's redirect drops the hash, so the tab's last address is
 * also kept in `sessionStorage` and restored when the app opens with none.
 * Every move records it, a return to a Session included, so an ordinary
 * refresh of a Session never jumps to an old page.
 * @module @deepseek-ai/dsh-client-ui-url-location/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only merges: ctx.layout and its MainPanelId, and ctx.pluginNavigation.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { formatPlace, parsePlace, PLUGINS_PANEL, type Place } from './location.ts'

export { formatPlace, parsePlace, type Place } from './location.ts'

/** Services this plugin injects; `pluginNavigation` is optional and read per use. */
export const inject = ['layout']

/** Where the tab's last address is kept, for the return from the sign-in page. */
const STORAGE_KEY = 'dsh-url-location'

/** How often a place is tried again while its panel is not registered yet, in milliseconds. */
const RETRY_MS = 200

/** How long a place is tried before it is abandoned and the app's own choice stands, in milliseconds. */
const GIVE_UP_MS = 20_000

/**
 * Follow the layout and the Plugins panel into the address bar, and back.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const navigation = () => ctx.get('pluginNavigation')

  /** Where the person is now. */
  const current = (): Place => {
    const panel = ctx.layout.panelInfo.getSnapshot().activePanelId
    if (panel === null) return { kind: 'session' }
    if (panel === PLUGINS_PANEL) {
      const nav = navigation()
      return nav === undefined ? { kind: 'panel', panel } : { kind: 'plugins', view: nav.view() }
    }
    return { kind: 'panel', panel }
  }

  /**
   * Try to show a place once.
   * @returns true when it is showing, false when its panel is not registered yet.
   */
  const show = (place: Place): boolean => {
    try {
      switch (place.kind) {
        case 'session':
          ctx.layout.selectPanel(null)
          return true
        case 'panel':
          ctx.layout.selectPanel(place.panel as MainPanelId)
          return true
        case 'plugins': {
          const nav = navigation()
          if (nav === undefined) return false
          nav.show(place.view)
          return true
        }
      }
    } catch (_error) {
      // selectPanel throws while the panel is not registered; the caller retries.
      return false
    }
  }

  // While a place from the address bar is being applied, the app's own moves
  // are not written back, or the starting app's default would replace it.
  let applying = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const remember = (hash: string): void => {
    try {
      sessionStorage.setItem(STORAGE_KEY, hash)
    } catch (_error) {
      // Storage refused (private mode, quota): only the return from sign-in is lost.
    }
  }

  const write = (): void => {
    if (applying) return
    const hash = formatPlace(current())
    remember(hash)
    if (hash === location.hash || (hash === '' && location.hash === '')) return
    const url = `${location.pathname}${location.search}${hash}`
    history.pushState(history.state, '', url)
  }

  const applyPlace = (place: Place): void => {
    if (timer !== undefined) clearTimeout(timer)
    applying = true
    const started = Date.now()
    const attempt = (): void => {
      timer = undefined
      if (show(place) || Date.now() - started > GIVE_UP_MS) {
        applying = false
        // The address keeps what was asked for when it is showing; when it was
        // abandoned, it now records what is on screen instead.
        const hash = formatPlace(current())
        remember(hash)
        if (hash !== location.hash) history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`)
        return
      }
      timer = setTimeout(attempt, RETRY_MS)
    }
    attempt()
  }

  ctx.effect(() => ctx.layout.panelInfo.subscribe(write), 'ui-url-location: panel')

  // The Plugins panel may register after this plugin; follow its view once it exists.
  ctx.effect(() => {
    let unsubscribe: (() => void) | undefined
    const poll = setInterval(() => {
      const nav = navigation()
      if (nav === undefined) return
      clearInterval(poll)
      unsubscribe = nav.subscribe(write)
    }, RETRY_MS)
    return () => {
      clearInterval(poll)
      unsubscribe?.()
    }
  }, 'ui-url-location: plugins view')

  ctx.effect(() => {
    const onPop = (): void => { applyPlace(parsePlace(location.hash)) }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      if (timer !== undefined) clearTimeout(timer)
    }
  }, 'ui-url-location: back and forward')

  let stored = ''
  if (location.hash === '') {
    try {
      stored = sessionStorage.getItem(STORAGE_KEY) ?? ''
    } catch (_error) {
      // Storage refused: open where the app opens.
    }
  }
  const opened = parsePlace(location.hash === '' ? stored : location.hash)
  if (opened.kind !== 'session') applyPlace(opened)
}
