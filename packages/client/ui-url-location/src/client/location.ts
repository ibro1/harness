/**
 * The address-bar form of where the person is: a main panel, and for the
 * Plugins panel the view inside it. Pure, so the format is tested apart from
 * the browser.
 *
 * | Hash | Place |
 * |---|---|
 * | (none) | the current Session |
 * | `#/plugins` | the plugin list |
 * | `#/plugins/item/<id>` | an official plugin's page, such as `psd-tools` or `seo-employee` |
 * | `#/plugins/package/<name>` | an installed bundle |
 * | `#/plugins/package/<name>/<row>` | one plugin row of a bundle |
 * | `#/<panel>` | another main panel |
 *
 * Every segment is URI-encoded, so a package name such as `@scope/name` stays one segment.
 */

import type { PluginView } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'

/** The Plugins panel's id. */
export const PLUGINS_PANEL = 'plugins'

/** Where the person is, as the address bar records it. */
export type Place =
  | { readonly kind: 'session' }
  | { readonly kind: 'panel'; readonly panel: string }
  | { readonly kind: 'plugins'; readonly view: PluginView }

/**
 * Read a place from `location.hash`.
 * @param hash - the hash, with or without its leading `#`.
 * @returns the place; a hash this plugin did not write reads as the Session.
 */
export function parsePlace(hash: string): Place {
  const body = hash.replace(/^#/u, '')
  if (!body.startsWith('/')) return { kind: 'session' }
  let parts: string[]
  try {
    parts = body.slice(1).split('/').filter(part => part !== '').map(part => decodeURIComponent(part))
  } catch (_error) {
    // A malformed escape is not an address this plugin wrote.
    return { kind: 'session' }
  }
  const [panel, kind, first, second] = parts
  if (panel === undefined) return { kind: 'session' }
  if (panel !== PLUGINS_PANEL) return { kind: 'panel', panel }
  if (kind === 'item' && first !== undefined) return { kind: 'plugins', view: { kind: 'item', id: first } }
  if (kind === 'package' && first !== undefined) {
    return second === undefined
      ? { kind: 'plugins', view: { kind: 'package', name: first } }
      : { kind: 'plugins', view: { kind: 'row', name: first, rowId: second } }
  }
  return { kind: 'plugins', view: { kind: 'list' } }
}

/**
 * Write a place as a hash.
 * @param place - where the person is.
 * @returns the hash with its `#`, or the empty string for the Session.
 */
export function formatPlace(place: Place): string {
  const path = (...parts: string[]): string => `#/${parts.map(part => encodeURIComponent(part)).join('/')}`
  switch (place.kind) {
    case 'session': return ''
    case 'panel': return path(place.panel)
    case 'plugins': {
      const view = place.view
      switch (view.kind) {
        case 'list': return path(PLUGINS_PANEL)
        case 'item': return path(PLUGINS_PANEL, 'item', view.id)
        case 'package': return path(PLUGINS_PANEL, 'package', view.name)
        case 'row': return path(PLUGINS_PANEL, 'package', view.name, view.rowId)
      }
    }
  }
}
