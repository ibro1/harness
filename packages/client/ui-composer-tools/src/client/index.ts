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
 *  composer draft, and route image files through the built-in vision
 *  attachment (so they persist as thumbnails in the sent message and never
 *  reach the workspace-upload path). */
export interface ComposerControlInject {
  insertDraft: (text: string) => void
  /** Attach image files to the draft the way an editor drop does; returns null
   *  when handled, or an error message (an unsupported media type) so the
   *  caller can fall back to a workspace upload. */
  attachImages: (files: readonly File[]) => string | null
}

/** Injected into the preview strip: clear its rows when the composer submits. */
export interface ComposerStripInject {
  /** Subscribe to this session's submit; fires once per send. Returns an
   *  unsubscribe. */
  watchSubmit: (onSubmit: () => void) => () => void
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

  // Per-session leading-row inject, resolved the way ui-commands reaches the
  // input facade: sessionId → session scope → the session's conversation input.
  const controlInject = (sessionId: unknown): ComposerControlInject => {
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
      attachImages: (files: readonly File[]): string | null => {
        if (actx === undefined) return 'no session scope'
        const conversation = actx.get('conversation')
        if (conversation === undefined) return 'no conversation service'
        return conversation.addImagesFromFiles(actx, files)
      },
    }
  }

  // The strip clears itself on send: the input phase enters 'submitting' once
  // per submit, and the strip is mounted (rendering null while empty) whenever
  // this slot is active, so the subscription is live exactly when there is
  // anything to clear.
  const stripInject = (sessionId: unknown): ComposerStripInject => {
    const actx = ctx.sessions.scope(sessionId as never)
    return {
      watchSubmit: (onSubmit: () => void): (() => void) => {
        if (actx === undefined) return () => {}
        const conversation = actx.get('conversation')
        if (conversation === undefined) return () => {}
        const input = conversation.input.for(actx)
        let wasSubmitting = input.state.getSnapshot().phase === 'submitting'
        return input.state.subscribe(() => {
          const submitting = input.state.getSnapshot().phase === 'submitting'
          if (submitting && !wasSubmitting) onSubmit()
          wasSubmitting = submitting
        })
      },
    }
  }

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'workspace-upload',
    order: 10,
    locale: NS,
    inject: controlInject,
  }, UploadControl))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'voice-input',
    order: 11,
    locale: NS,
    inject: controlInject,
  }, VoiceControl))

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'upload-strip',
    order: 10,
    locale: NS,
    inject: stripInject,
  }, UploadStrip))
}
