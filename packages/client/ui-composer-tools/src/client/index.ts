/**
 * Browser half: a composer-dock button that uploads a file into the current
 * session's workspace directory (the host route /workspace-upload). Lets the
 * operator drop footage into the folder the agent is editing in, straight from
 * the web composer.
 * @module @deepseek-ai/dsh-client-ui-composer-tools/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only merges: the composer.dock SlotMap entry, the session-scope
// sessionId prop, ctx.locale, and the ctx.slots (SlotRegistry) service.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, zh, type ComposerToolsKey } from './locales.ts'
import { UploadButton } from './UploadButton.tsx'

export type { ComposerToolsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Composer tools copy (workspace upload). */
    'composer-tools': ComposerToolsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'composer-tools'

/** Services this plugin injects. */
export const inject = ['slots', 'locale']

/**
 * Apply the plugin: register the dictionaries and mount the upload button on
 * the composer dock.
 * @param ctx - the client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-composer-tools: dictionaries')

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'workspace-upload',
    order: 10,
    locale: NS,
  }, UploadButton))
}
