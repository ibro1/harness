/**
 * Inject the fork-local mobile stylesheet as an owned `<style>` tag. The tag
 * carries the plugin-ownership attributes the client module system expects, so
 * a rebuild replaces exactly this sheet, and the effect's disposer removes it
 * when the plugin unwinds.
 * @module @deepseek-ai/dsh-client-ui-mobile/client/styles
 */

import type { Context } from '@deepseek-ai/cordis'
// The `?inline` loader compiles the CSS to text at build time.
import mobileCss from '../styles/mobile.css?inline'

/** This plugin's package id, the ownership key on the injected tag. */
const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-mobile'

/**
 * Add the mobile stylesheet to the document head for this plugin's lifetime.
 * @param ctx - the client plugin context.
 */
export function installMobileStyles(ctx: Context): void {
  // Node e2e runs have no document; the sheet is a browser-only concern.
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/mobile.css`
    tag.textContent = mobileCss
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'ui-mobile: mobile.css stylesheet')
}
