/**
 * What the owner reads: the shortlist review page opened from WhatsApp
 * (each proposed tool with its keyword, demand evidence, first-page verdict,
 * audience and RPM band, difficulty, and a checkbox to approve it), the
 * WhatsApp messages, and the AdSense readiness verdict.
 */

import type { Shortlist, SiteCheck, ToolRecord } from './store.ts'

function html(value: string): string {
  return value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c] ?? c)
}

const STYLE = `:root{color-scheme:light dark;--bg:#f7f8fa;--fg:#14171c;--muted:#535a66;--line:#d9dde3;--card:#fff;--accent:#0058b3}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#eef0f3;--muted:#a6adb8;--line:#2a2f37;--card:#171a20;--accent:#5aa6ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}h1{font-size:22px;margin:4px 0 8px}h2{font-size:18px;margin:2px 0 6px}p{margin:6px 0}
.muted{color:var(--muted);font-size:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:12px 0}
label.pick{display:flex;gap:10px;align-items:flex-start;cursor:pointer}label.pick input{width:22px;height:22px;margin-top:2px;flex:none}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 10px;margin:8px 0;font-size:14px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:12px 20px;background:var(--accent);color:#fff;cursor:pointer;min-height:44px}
.done{border-color:var(--accent)}`

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${html(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`
}

/**
 * The shortlist review page.
 * @param shortlist - the shortlist.
 * @param action - where the form posts (signed).
 * @returns the HTML document.
 */
export function shortlistPage(shortlist: Shortlist, action: string): string {
  const pending = shortlist.status === 'pending'
  const items = shortlist.items.map(item => `<div class="card${item.approved === true ? ' done' : ''}">
<label class="pick">${pending ? `<input type="checkbox" name="n" value="${String(item.n)}" aria-label="Build ${html(item.tool)}">` : ''}
<span><h2>${String(item.n)}. ${html(item.tool)}</h2><span class="muted">tools.linkfa.de/${html(item.slug)}/</span></span></label>
<dl><dt>Keyword</dt><dd>${html(item.keyword)}</dd><dt>Demand</dt><dd>${html(item.demand)}</dd><dt>Google page 1</dt><dd>${html(item.verdict)}</dd>
<dt>Audience</dt><dd>${html(item.market)} · RPM ${html(item.rpm)} (estimate)</dd><dt>Difficulty</dt><dd>${String(item.difficulty)}/10</dd><dt>Better because</dt><dd>${html(item.differentiator)}</dd>
${pending ? '' : `<dt>Decision</dt><dd>${item.approved === true ? `approved${item.publishedAt === undefined ? (item.builtAt === undefined ? ', not built yet' : ', built') : ', published'}` : 'not approved'}</dd>`}</dl></div>`).join('\n')
  const body = `<p class="muted">Tools employee · shortlist ${html(shortlist.createdAt.slice(0, 10))}</p>
<h1>${pending ? 'Which tools should I build?' : 'Shortlist decided'}</h1>
${shortlist.note === '' ? '' : `<p>${html(shortlist.note)}</p>`}
${pending ? `<p class="muted">Tick the tools to build and press Approve, or reply on WhatsApp "build 1,3" (or "build all", "build none"). New tools go out at the weekly pace you set.</p><form method="post" action="${html(action)}">${items}<p><button type="submit">Approve the ticked tools</button></p></form>` : items}`
  return page('Tools shortlist', body)
}

/**
 * The page shown after the owner decides.
 * @param approved - the approved tools' names.
 * @returns the HTML document.
 */
export function decidedPage(approved: string[]): string {
  return page('Shortlist decided', approved.length === 0
    ? '<h1>Nothing approved</h1><p>No tool will be built from this shortlist. The next weekly run proposes new ones.</p>'
    : `<h1>Approved</h1><p>I will build and test these, then publish them at the weekly pace:</p><ul>${approved.map(a => `<li>${html(a)}</li>`).join('')}</ul>`)
}

/**
 * The WhatsApp message announcing a shortlist.
 * @param shortlist - the shortlist.
 * @param link - its signed page.
 * @returns the text.
 */
export function shortlistMessage(shortlist: Shortlist, link: string): string {
  return [
    `Tools employee: ${String(shortlist.items.length)} tool${shortlist.items.length === 1 ? '' : 's'} I can build for tools.linkfa.de.`,
    ...shortlist.items.map(i => `${String(i.n)}. ${i.tool} — "${i.keyword}", ${i.verdict.split(':')[0] ?? i.verdict}, ${i.market} RPM ${i.rpm}, difficulty ${String(i.difficulty)}/10`),
    '',
    `Review: ${link}`,
    `Or reply "build 1,3" (or "build all" / "build none"). You can start the reply with ${shortlist.tag}.`,
  ].join('\n')
}

/** Readiness thresholds. */
export interface ReadinessRules {
  minTools: number
  minClicks28: number
}

/** One readiness check. */
export interface ReadinessCheck {
  label: string
  ok: boolean
  detail: string
}

/**
 * Whether the site is ready for an AdSense application.
 * @param input - the live check, the standing pages' status, the tools, Search Console clicks and the rules.
 * @returns the checks, the verdict and whether to apply now.
 */
export function adsenseReadiness(input: {
  site: SiteCheck | undefined
  pages: Record<string, boolean> | undefined
  tools: ToolRecord[]
  clicks28: number | undefined
  clientSet: boolean
  rules: ReadinessRules
}): { ready: boolean; verdict: string; checks: ReadinessCheck[] } {
  const live = input.site?.state === 'live' || input.site?.state === 'outdated'
  const quality = input.tools.filter(t => t.firstPublishedAt !== undefined && t.tests?.status === 'passed')
  const failing = input.tools.filter(t => t.tests?.status === 'failed')
  const missingPages = Object.entries(input.pages ?? {}).filter(([, ok]) => !ok).map(([path]) => path)
  const checks: ReadinessCheck[] = [
    { label: 'Site live', ok: live, detail: input.site?.detail ?? 'Not checked yet.' },
    {
      label: 'About, Contact, Privacy and Terms pages',
      ok: live && input.pages !== undefined && missingPages.length === 0,
      detail: input.pages === undefined ? 'Checked once the site is live.' : missingPages.length === 0 ? 'All present.' : `Missing: ${missingPages.join(', ')}.`,
    },
    {
      label: `At least ${String(input.rules.minTools)} published tools with passing tests`,
      ok: quality.length >= input.rules.minTools && failing.length === 0,
      detail: `${String(quality.length)} published and passing${failing.length === 0 ? '' : `; ${String(failing.length)} failing tests`}.`,
    },
    {
      label: `Search traffic (${String(input.rules.minClicks28)}+ clicks in 28 days)`,
      ok: input.clicks28 !== undefined && input.clicks28 >= input.rules.minClicks28,
      detail: input.clicks28 === undefined ? 'Search Console is not connected, so traffic is unknown.' : `${String(input.clicks28)} clicks from Google search in the last 28 days.`,
    },
  ]
  const ready = checks.every(c => c.ok)
  const verdict = input.clientSet
    ? 'AdSense client set: ads and ads.txt go out with the next publish.'
    : ready
      ? 'Ready: apply for AdSense now. AdSense adds sites by root domain, so apply with linkfa.de and put the ads.txt line on linkfa.de too.'
      : `Missing: ${checks.filter(c => !c.ok).map(c => c.label.toLowerCase()).join('; ')}.`
  return { ready, verdict, checks }
}
