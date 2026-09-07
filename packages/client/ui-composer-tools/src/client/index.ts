/**
 * Browser half: composer tools. In the input's leading icon row — a paperclip
 * that uploads one or more files into the current session's workspace (host
 * route /workspace-upload), and a mic that records audio, transcribes it via
 * the host relay (/voice-transcribe, Groq Whisper), and drops the text into the
 * composer. A full-width strip below the input previews the uploads.
 * @module @deepseek-ai/dsh-client-ui-composer-tools/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only merges: input.left + composer.dock SlotMap entries and the
// session-scope sessionId, ctx.sessions (scope → session actx), the
// session-scope conversation service, ctx.locale, and the SlotRegistry.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, zh, type ComposerToolsKey } from './locales.ts'
import { UploadControl } from './UploadControl.tsx'
import { VoiceControl } from './VoiceControl.tsx'
import { UploadStrip } from './UploadStrip.tsx'

export type { ComposerToolsKey } from './locales.ts'

/** Injected into the two leading-row controls: append text to the active
 *  composer draft. */
export interface ComposerDraftInsert {
  insertDraft: (text: string) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Composer tools copy (workspace upload + voice prompting). */
    'composer-tools': ComposerToolsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'composer-tools'

/** Services this plugin injects. */
export const inject = ['slots', 'locale', 'sessions']

/**
 * Apply the plugin: register the dictionaries, mount the upload + voice icons
 * on the input's leading row, and the upload preview strip below the input.
 * @param ctx - the client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-composer-tools: dictionaries')

  // Per-session draft writer, resolved the way ui-commands reaches the input
  // facade: sessionId → session scope → the session's conversation input.
  const draftInserter = (sessionId: unknown): ComposerDraftInsert => {
    const actx = ctx.sessions.scope(sessionId as never)
    return {
      insertDraft: (text: string) => {
        if (actx === undefined || text === '') return
        const conversation = actx.get('conversation')
        if (conversation === undefined) return
        const input = conversation.input.for(actx)
        const current = input.state.getSnapshot().draft
        const separator = current === '' || /\s$/.test(current) ? '' : ' '
        input.setDraft(current + separator + text)
      },
    }
  }

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'workspace-upload',
    order: 10,
    locale: NS,
    inject: draftInserter,
  }, UploadControl))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'voice-input',
    order: 11,
    locale: NS,
    inject: draftInserter,
  }, VoiceControl))

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'upload-strip',
    order: 10,
    locale: NS,
  }, UploadStrip))
}
