// @vitest-environment jsdom
/**
 * The extension's page-reading code, exercised against a DOM.
 *
 * It runs in the operator's browser, not in this process, so nothing else here
 * covers it; the snapshot's shape is what an agent reads and acts on, and a
 * regression in it is invisible until a model misreads a page. jsdom lays
 * nothing out, so every box is stubbed on-screen and only the walk, the naming,
 * the budgets and the rendering are under test.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

const CONTENT_SCRIPT = join(
  dirname(new URL(import.meta.url).pathname),
  '../../../../deploy/browser-extension/content.js',
)

type Handler = (
  message: { command: string; payload?: unknown },
  sender: unknown,
  respond: (reply: { result?: string; error?: string }) => void,
) => void

/** Load the content script against `html` and return its snapshot text. */
async function snapshot(html: string, payload: Record<string, unknown> = {}): Promise<string> {
  document.body.innerHTML = html
  const box = { top: 10, left: 10, bottom: 40, right: 300, width: 290, height: 30, x: 10, y: 10 }
  Element.prototype.getBoundingClientRect = () => box as DOMRect
  Range.prototype.getBoundingClientRect = () => box as DOMRect

  let handler: Handler | undefined
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { onMessage: { addListener: (fn: Handler) => { handler = fn } } },
  }
  // A fresh evaluation per test: the script guards against double installation.
  delete (window as unknown as Record<string, unknown>).__AGENT_CONTENT_SCRIPT_INSTALLED__
  // eslint-disable-next-line no-eval
  ;(0, eval)(readFileSync(CONTENT_SCRIPT, 'utf8'))

  // The listener answers asynchronously, as the extension messaging API expects.
  const reply = await new Promise<{ result?: string; error?: string }>((resolve) => {
    handler?.({ command: 'snapshot', payload }, {}, resolve)
  })
  if (reply.error !== undefined) throw new Error(reply.error)
  return reply.result ?? ''
}

const TODO_ITEM = `
  <main>
    <ul><li><div class="view">
      <input class="toggle" type="checkbox">
      <label>buy milk</label>
      <button class="destroy"></button>
    </div></li></ul>
    <span><strong>1</strong> item left!</span>
  </main>`

describe('page snapshot', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('reports text the page shows, not only the controls it offers', async () => {
    // A walk over elements alone reported every control and none of the
    // content: a todo added through the UI was invisible to the agent that
    // added it, because its title is a label no control is named by.
    const text = await snapshot(TODO_ITEM)
    expect(text).toContain('"buy milk"')
    expect(text).toMatch(/\[\d+\] checkbox/)
  })

  it('joins one sentence split across inline markup', async () => {
    expect(await snapshot(TODO_ITEM)).toContain('"1 item left!"')
  })

  it('does not repeat a heading as text beneath itself', async () => {
    const text = await snapshot('<h1>todos</h1>')
    expect(text).toContain('h1 "todos"')
    expect(text.match(/todos/g)).toHaveLength(1)
  })

  it('does not repeat a control label already carried by its name', async () => {
    const text = await snapshot('<button>Save changes</button>')
    expect(text).toContain('[1] button "Save changes"')
    expect(text.match(/Save changes/g)).toHaveLength(1)
  })

  it('keeps room for the controls when the page is mostly prose', async () => {
    const prose = Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${String(i)} ${'lorem ipsum '.repeat(20)}</p>`).join('')
    const text = await snapshot(`<main>${prose}<a href="/next">Next page</a><button>Subscribe</button></main>`)
    // The controls sit after every paragraph, so they only survive if text is
    // bounded separately rather than sharing one budget with them.
    expect(text).toContain('Next page')
    expect(text).toContain('Subscribe')
    expect(text).toContain('some page text was left out')
  })

  it('masks a password field rather than reporting what it holds', async () => {
    const text = await snapshot('<input type="password" value="hunter2">')
    expect(text).not.toContain('hunter2')
    expect(text).toContain('***')
  })

  it('numbers refs so a click can name one', async () => {
    const text = await snapshot('<a href="/a">First</a><a href="/b">Second</a>')
    expect(text).toContain('[1] link "First"')
    expect(text).toContain('[2] link "Second"')
  })
})
