/**
 * The six model-facing tools that drive the connected browser through
 * `ctx.browserBridge.call`. This module owns their schemas, argument
 * resolution, and model-facing rendering; the extension owns page semantics —
 * what a snapshot ref denotes, how far a scroll step moves, and when a page has
 * settled.
 *
 * Every tool fails loud rather than degrading: a missing connection, an
 * extension-reported failure, and a reply that never arrives all reach the
 * model as the bridge's own error text, so the model can read that no browser
 * is connected instead of retrying against silence.
 * @module @deepseek-ai/dsh-host-browser-bridge/src/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
// Type-only: resolves the ctx.browserBridge service declaration this module calls.
import type {} from './index.ts'

/** Milliseconds `browser_wait` waits when the model names no duration. */
const DEFAULT_WAIT_MS = 1000

/** Longest `browser_wait` pause; a longer request is clamped to it. */
const MAX_WAIT_MS = 10_000

/**
 * The canonical value of every browser tool: the extension's reply as text.
 * One value declaration for all six, because the commands differ in what they
 * do to the page, not in what they report back.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      required: true,
      description: 'What the browser reported: the page text for a snapshot, otherwise a status line, empty when the command only acknowledged.',
    },
  },
} as const satisfies ValueSchemaSpec

/**
 * Reduce one extension reply to model-facing text. The extension answers a
 * command with a string, with an object carrying `text`, or with nothing at all
 * when the command's only result is that it succeeded; any other reply is
 * serialized rather than dropped, so an unrecognized field still reaches the
 * model.
 * @param reply - the extension's reply value, unvalidated wire data.
 * @returns the reply's text, empty when it carries none.
 */
function replyText(reply: unknown): string {
  if (typeof reply === 'string') return reply
  if (reply === null || reply === undefined) return ''
  if (typeof reply === 'object' && 'text' in reply && typeof reply.text === 'string') return reply.text
  return JSON.stringify(reply)
}

/**
 * Send one command to the connected browser and return its reply as the
 * canonical value all six tools declare.
 *
 * `BrowserBridge.call` takes no cancellation argument and settles either on the
 * extension's reply or on its own `commandTimeoutMs`, so `exec.signal` is
 * observed before the send rather than forwarded: an in-flight command runs to
 * that bounded settlement and the tool reaches quiescence with it.
 * @param ctx - the plugin context carrying the bridge service.
 * @param type - command name the extension dispatches on.
 * @param payload - command arguments for that command.
 * @param exec - the tool execution whose signal gates the send.
 * @returns the reply text as the declared canonical value.
 * @throws when the caller already cancelled, no browser is connected, the extension reports a failure, or no reply arrives in time.
 */
async function callBrowser(
  ctx: Context,
  type: string,
  payload: Record<string, string | number | boolean>,
  exec: ToolRunContext,
): Promise<{ text: string }> {
  exec.signal.throwIfAborted()
  return { text: replyText(await ctx.browserBridge.call(type, payload)) }
}

/**
 * Resolve the pause `browser_wait` asks the extension for. Defaulting and
 * clamping happen here, once, so the extension receives one explicit duration.
 * @param requested - the model-supplied duration in milliseconds, if any.
 * @returns the duration to send, at most {@link MAX_WAIT_MS}.
 * @throws when the requested duration is negative.
 */
function resolveWaitMs(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_WAIT_MS
  if (requested < 0) throw new Error('ms must not be negative')
  return Math.min(requested, MAX_WAIT_MS)
}

/**
 * Register `browser_navigate`, `browser_snapshot`, `browser_click`,
 * `browser_type`, `browser_scroll`, and `browser_wait` on `ctx.tools`. Each
 * registration is an effect of the calling context, so unloading the bridge
 * withdraws the tools with it.
 * @param ctx - the bridge's context, carrying both the tool registry and `ctx.browserBridge`.
 */
export function registerBrowserTools(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: 'Open a URL in the active browser tab and wait for it to load. '
      + 'Use it to reach a page before reading or acting on it, then call browser_snapshot to see the page and get the refs the other browser tools need.',
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: 'Absolute URL to open, including the scheme (for example https://example.com/docs).',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: value.text === '' ? `Navigated to ${args.url}.` : value.text }],
    },
    execute: (args, exec) => callBrowser(ctx, 'navigate', { url: args.url }, exec),
    presentCall: args => ({ card: 'generic', title: `Navigate to ${args.url}`, kind: 'other', rawInput: args.url }),
  })), 'browser-bridge: browser_navigate')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Read the current page as text, with a numbered `ref` on each interactive element for browser_click and browser_type. '
      + 'Snapshot before you act, and again after anything that changes the page: refs come only from a snapshot and stop being valid once the page navigates, reloads, or updates.',
    parameters: {
      full: {
        type: 'boolean',
        description: 'True to capture the whole page instead of the visible viewport. Defaults to false; use it when the element you need is off-screen and you would otherwise scroll to find it.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text === '' ? 'The page snapshot is empty.' : value.text }],
    },
    execute: (args, exec) => callBrowser(ctx, 'snapshot', { full: args.full ?? false }, exec),
    presentCall: args => ({
      card: 'generic',
      title: args.full === true ? 'Snapshot the full page' : 'Snapshot the page',
      kind: 'other',
      rawInput: args.full ?? false,
    }),
  })), 'browser-bridge: browser_snapshot')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click one element on the current page by its snapshot `ref`. '
      + 'Take a browser_snapshot first — refs come from that snapshot and are only valid until the page changes, so snapshot again after a click that navigates or updates the page before clicking anything else.',
    parameters: {
      ref: {
        type: 'integer',
        required: true,
        description: 'Ref number of the element to click, as printed by the most recent browser_snapshot.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: value.text === '' ? `Clicked element ${String(args.ref)}.` : value.text }],
    },
    execute: (args, exec) => callBrowser(ctx, 'click', { ref: args.ref }, exec),
    presentCall: args => ({ card: 'generic', title: `Click element ${String(args.ref)}`, kind: 'other', rawInput: args.ref }),
  })), 'browser-bridge: browser_click')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Fill a text field on the current page — input, textarea, or editable element — identified by its snapshot `ref`, replacing whatever it holds, and optionally press Enter to submit. '
      + 'Refs come from browser_snapshot and are only valid until the page changes, so snapshot again after a submission before typing anywhere else.',
    parameters: {
      ref: {
        type: 'integer',
        required: true,
        description: 'Ref number of the field to fill, as printed by the most recent browser_snapshot.',
      },
      text: {
        type: 'string',
        required: true,
        description: 'Text to put in the field; it replaces the current value rather than appending to it.',
      },
      submit: {
        type: 'boolean',
        description: 'True to press Enter after typing, submitting the form or search. Defaults to false.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => [{
        type: 'text',
        text: value.text === ''
          ? `Typed into element ${String(args.ref)}${args.submit === true ? ' and pressed Enter' : ''}.`
          : value.text,
      }],
    },
    execute: (args, exec) => callBrowser(ctx, 'type', { ref: args.ref, text: args.text, submit: args.submit ?? false }, exec),
    presentCall: args => ({ card: 'generic', title: `Type into element ${String(args.ref)}`, kind: 'other', rawInput: args.text }),
  })), 'browser-bridge: browser_type')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_scroll',
    description: 'Scroll the current page up or down to bring off-screen content into view, then take a new browser_snapshot to read it. '
      + 'Scrolling changes what the viewport holds, so refs from an earlier snapshot may no longer be valid.',
    parameters: {
      direction: {
        type: 'string',
        required: true,
        enum: ['up', 'down'],
        description: 'Which way to scroll the page.',
      },
      amount: {
        type: 'integer',
        description: 'How far to scroll, in pixels. Omit to let the browser scroll by about one viewport.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: value.text === '' ? `Scrolled ${args.direction}.` : value.text }],
    },
    execute(args, exec) {
      // An omitted `amount` stays omitted: the extension owns how far one
      // viewport-sized step scrolls, so this side names no distance for it.
      const payload: Record<string, string | number> = { direction: args.direction }
      if (args.amount !== undefined) payload.amount = args.amount
      return callBrowser(ctx, 'scroll', payload, exec)
    },
    presentCall: args => ({ card: 'generic', title: `Scroll ${args.direction}`, kind: 'other', rawInput: args.amount ?? args.direction }),
  })), 'browser-bridge: browser_scroll')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_wait',
    description: 'Pause for the page to settle after an action that starts a navigation, a redirect, or asynchronous loading, then take a fresh browser_snapshot. '
      + `Use it when a click or submission has not visibly finished; it waits ${String(DEFAULT_WAIT_MS)}ms unless you ask for longer, and never longer than ${String(MAX_WAIT_MS)}ms.`,
    parameters: {
      ms: {
        type: 'integer',
        description: `Milliseconds to wait. Defaults to ${String(DEFAULT_WAIT_MS)}; a larger request is capped at ${String(MAX_WAIT_MS)}.`,
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      // Presenters must be total on replayed arguments, so this one reports the
      // wait without re-resolving a duration `resolveWaitMs` could reject.
      render: (_args, value) => [{
        type: 'text',
        text: value.text === '' ? 'Waited for the page to settle.' : value.text,
      }],
    },
    execute: (args, exec) => callBrowser(ctx, 'wait', { ms: resolveWaitMs(args.ms) }, exec),
    presentCall: args => ({ card: 'generic', title: 'Wait for the page', kind: 'other', rawInput: args.ms ?? DEFAULT_WAIT_MS }),
  })), 'browser-bridge: browser_wait')
}
