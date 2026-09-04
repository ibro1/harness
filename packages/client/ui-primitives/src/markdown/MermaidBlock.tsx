/**
 * A settled ```mermaid fence rendered as a diagram.
 *
 * Mermaid is large and most conversations never contain a diagram, so it is
 * imported on first use and shared process-wide from then on. Until it renders
 * — and whenever it cannot — the caller's ordinary highlighted code block
 * stands, so a malformed diagram still shows its source rather than an error.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import css from './MermaidBlock.module.css'

/** The one in-flight or settled mermaid import for this page. */
let loading: Promise<typeof import('mermaid').default> | undefined

/**
 * Load and configure mermaid once.
 *
 * `securityLevel: 'strict'` is mermaid's own sanitizing mode: it strips markup
 * in labels and refuses click bindings, so a diagram authored by a model cannot
 * introduce script or navigation into the page that holds the session.
 * @returns the configured mermaid API.
 */
async function loadMermaid(): Promise<typeof import('mermaid').default> {
  loading ??= import('mermaid').then((module) => {
    const dark = globalThis.matchMedia('(prefers-color-scheme: dark)').matches
    module.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
    })
    return module.default
  })
  return loading
}

/** Inputs for {@link MermaidBlock}. */
export interface MermaidBlockProps {
  /** Fence body, verbatim. */
  code: string
  /** Rendered while loading, and kept when the diagram cannot be drawn. */
  fallback: ReactNode
}

/**
 * Render one mermaid diagram.
 * @param props - the fence body and the code block standing in for it.
 * @returns the diagram, or the fallback.
 */
export function MermaidBlock({ code, fallback }: MermaidBlockProps): ReactNode {
  const [svg, setSvg] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  // Mermaid needs a DOM id unique per render; a ref keeps it stable across the
  // effect's reruns so a re-render cannot collide with its own previous pass.
  const id = useRef(`dsh-mermaid-${Math.random().toString(36).slice(2)}`)

  useEffect(() => {
    // A mutable cell, not a local flag: the compiler cannot see the cleanup
    // mutate a `let` from inside the async closure and narrows it away.
    const alive = { current: true }
    setFailed(false)
    void (async () => {
      try {
        const mermaid = await loadMermaid()
        const { svg: rendered } = await mermaid.render(id.current, code)
        if (alive.current) setSvg(rendered)
      } catch {
        // A diagram the parser rejects is a source block, not an error banner.
        if (alive.current) setFailed(true)
      }
    })()
    return () => { alive.current = false }
  }, [code])

  if (failed || svg === undefined) return fallback
  // Mermaid's own sanitized SVG output, not model-authored markup.
  return <div className={css.diagram} dangerouslySetInnerHTML={{ __html: svg }} />
}
