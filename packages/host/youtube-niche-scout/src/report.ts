/**
 * The weekly report as the owner reads it: a signed web page opened from
 * WhatsApp (ranked niches with their score breakdown, the outlier channels
 * behind each, video ideas, the recommendation and what changed since last
 * week), and the short WhatsApp message that links to it.
 */

import { CATEGORIES, WEIGHTS } from './scoring.ts'
import type { NicheRecord, ReportRecord } from './store.ts'

function html(value: string): string {
  return value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c] ?? c)
}

/**
 * A dollar band as text.
 * @param rpm - low and high, US dollars.
 * @returns `$12–30`, with one decimal under $10 when needed.
 */
export function rpmText(rpm: readonly [number, number]): string {
  const f = (n: number): string => (n >= 10 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(1))
  return `$${f(rpm[0])}–${f(rpm[1])}`
}

/**
 * What moved since the previous report.
 * @param previous - last week's ranked niches, or undefined for the first report.
 * @param current - this week's.
 * @returns one line per change; empty when nothing moved.
 */
export function rankChanges(previous: readonly NicheRecord[] | undefined, current: readonly NicheRecord[]): string[] {
  if (previous === undefined) return ['First report: nothing to compare with yet.']
  const key = (n: NicheRecord): string => n.name.trim().toLowerCase()
  const before = new Map(previous.map((n, i) => [key(n), { rank: i + 1, score: n.score }]))
  const lines: string[] = []
  current.forEach((n, i) => {
    const old = before.get(key(n))
    if (old === undefined) lines.push(`New: ${n.name} at #${String(i + 1)} (${String(n.score)}).`)
    else if (old.rank !== i + 1 || Math.abs(old.score - n.score) >= 3) {
      lines.push(`${n.name}: #${String(old.rank)} → #${String(i + 1)}, score ${String(old.score)} → ${String(n.score)}.`)
    }
  })
  const now = new Set(current.map(key))
  for (const n of previous) if (!now.has(key(n))) lines.push(`Dropped: ${n.name} (was ${String(n.score)}).`)
  return lines
}

/**
 * The WhatsApp message announcing a report.
 * @param report - the report.
 * @param link - its signed page.
 * @returns the text.
 */
export function reportMessage(report: ReportRecord, link: string): string {
  const top = report.niches.find(n => n.name === report.recommendation.niche) ?? report.niches[0]
  const runnersUp = report.niches.filter(n => n !== top).slice(0, 3).map(n => `${n.name} (${String(n.score)})`).join(', ')
  return [
    'YouTube niche scout: this week\'s report is ready.',
    '',
    top === undefined ? '' : `Recommendation: ${top.name} (score ${String(top.score)}/100, RPM ${rpmText(top.rpm)}).`,
    report.recommendation.why.slice(0, 400),
    runnersUp === '' ? '' : `\nAlso considered: ${runnersUp}.`,
    `\nFull report with outlier channels and video ideas: ${link}`,
  ].filter(line => line !== '').join('\n')
}

const PART_LABELS = {
  demand: 'Demand', outliers: 'Outlier evidence', rpm: 'RPM', competition: 'Room (competition)', policyRisk: 'Policy risk', productionFit: 'Production fit',
} as const

function bar(score: number, inverse = false): string {
  const value = Math.min(10, Math.max(0, score))
  const good = inverse ? 10 - value : value
  return `<span class="bar"><span style="width:${String(value * 10)}%" class="${good >= 7 ? 'hi' : good >= 4 ? 'mid' : 'lo'}"></span></span>`
}

function nicheBlock(n: NicheRecord, rank: number, recommended: boolean, ideas: string[] | undefined): string {
  const parts = (Object.keys(PART_LABELS) as (keyof typeof PART_LABELS)[]).map(part => `<tr><th>${PART_LABELS[part]}</th>
<td class="num">${String(n.parts[part])}</td><td>${bar(n.parts[part], part === 'policyRisk')}</td><td>${html(n.evidence[part])}</td></tr>`).join('')
  const examples = n.examples.length === 0 ? '<p class="muted">No outlier channels cited.</p>' : `<ul>${n.examples.map(e => `<li><a href="https://www.youtube.com/channel/${html(e.id)}" target="_blank" rel="noreferrer">${html(e.title)}</a> — ${html(e.note)}</li>`).join('')}</ul>`
  return `<section class="card${recommended ? ' pick' : ''}">
<p class="muted">#${String(rank)}${recommended ? ' · <strong>Recommended</strong>' : ''} · ${html(CATEGORIES[n.category].label)}</p>
<h2>${html(n.name)} <span class="score">${String(n.score)}</span></h2>
<p>RPM ${html(rpmText(n.rpm))} for ${html(n.markets.join(', ') || 'tier-1 viewers')} · keywords: ${html(n.keywords.join(', '))}${n.reliesOnOthersFootage ? ' · <strong>depends on others\' footage</strong>' : ''}</p>
<div class="scroll"><table>${parts}</table></div>
<p><strong>Outlier channels</strong></p>${examples}
${n.gaps === '' ? '' : `<p><strong>Gaps</strong> ${html(n.gaps)}</p>`}
${ideas === undefined || ideas.length === 0 ? '' : `<details${recommended ? ' open' : ''}><summary>${String(ideas.length)} video ideas</summary><ol>${ideas.map(t => `<li>${html(t)}</li>`).join('')}</ol></details>`}
</section>`
}

/**
 * The report page.
 * @param report - the report.
 * @param history - earlier reports' dates and recommendations, newest first, with their signed links.
 * @returns the HTML document.
 */
export function reportPage(report: ReportRecord, history: { createdAt: string; niche: string; link: string }[] = []): string {
  const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()
  const ideasFor = (name: string): string[] | undefined => report.ideas.find(i => same(i.niche, name))?.titles
  const weights = `Demand ${String(WEIGHTS.demand * 100)}%, outlier evidence ${String(WEIGHTS.outliers * 100)}%, RPM ${String(WEIGHTS.rpm * 100)}%, room ${String(WEIGHTS.competition * 100)}%, safety (10 − policy risk) ${String(WEIGHTS.safety * 100)}%, production fit ${String(WEIGHTS.productionFit * 100)}%.`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Niche report</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#17171a;--muted:#5d5d66;--line:#d9d7d1;--card:#fff;--accent:#c4302b;--hi:#2e7d32;--mid:#b7791f;--lo:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#f1f1f3;--muted:#a3a3ad;--line:#2c2c33;--card:#1b1b1f;--hi:#66bb6a;--mid:#f6ad55;--lo:#ef5350}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}h1{font-size:22px;margin:4px 0}h2{font-size:18px;margin:4px 0}p{margin:6px 0}
.muted{color:var(--muted);font-size:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:12px 0}
.pick{border:2px solid var(--accent)}.score{float:right;background:var(--accent);color:#fff;border-radius:999px;padding:0 10px;font-size:15px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;vertical-align:top;padding:4px 6px;border-top:1px solid var(--line)}
th{white-space:nowrap;font-weight:600}.num{text-align:right}.bar{display:inline-block;width:64px;height:8px;border-radius:4px;background:var(--line);overflow:hidden}
.bar span{display:block;height:100%}.hi{background:var(--hi)}.mid{background:var(--mid)}.lo{background:var(--lo)}
a{color:inherit}ol,ul{padding-left:20px;margin:6px 0}li{margin:3px 0;overflow-wrap:anywhere}
</style></head><body><main>
<p class="muted">YouTube niche scout · ${html(report.createdAt.slice(0, 10))} · ${String(report.searches)} searches, ${String(report.units)} quota units</p>
<h1>Recommendation: ${html(report.recommendation.niche)}</h1>
<p>${html(report.recommendation.why)}</p>
${report.recommendation.firstSteps.length === 0 ? '' : `<p><strong>First steps</strong></p><ol>${report.recommendation.firstSteps.map(s => `<li>${html(s)}</li>`).join('')}</ol>`}
<div class="card"><strong>Summary</strong><p>${html(report.summary)}</p>
${report.changes.length === 0 ? '' : `<p><strong>Since last report</strong></p><ul>${report.changes.map(c => `<li>${html(c)}</li>`).join('')}</ul>`}</div>
${report.niches.map((n, i) => nicheBlock(n, i + 1, n.name === report.recommendation.niche, ideasFor(n.name))).join('\n')}
${report.risks === '' ? '' : `<div class="card"><strong>Risks</strong><p>${html(report.risks)}</p></div>`}
<div class="card"><strong>How this was scored</strong><p class="muted">${html(weights)} RPM bands come from the scout's maintained table, adjusted for the audience's countries; they are estimates, not quotes.</p>
<p class="muted">${html(report.method)}</p></div>
${history.length === 0 ? '' : `<div class="card"><strong>Earlier reports</strong><ul>${history.map(h => `<li><a href="${html(h.link)}">${html(h.createdAt.slice(0, 10))}</a> — ${html(h.niche)}</li>`).join('')}</ul></div>`}
</main></body></html>`
}
