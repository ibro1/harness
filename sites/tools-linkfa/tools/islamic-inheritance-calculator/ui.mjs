import { calculate, fractionText, fractionValue } from './logic.mjs'

const form = document.getElementById('calc')
const out = document.getElementById('result')
let shown = false

const BASIS = { fixed: 'Fixed share', residue: 'Takes what is left', 'fixed+residue': 'Fixed share and what is left', 'fixed+radd': 'Fixed share plus the return (radd)', excluded: 'Excluded' }

function el(tag, text, cls) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (cls) node.className = cls
  return node
}

function read() {
  const v = id => form.elements[id].value.trim()
  const spouse = form.elements.spouse.value
  return {
    estate: { gross: v('gross'), funeral: v('funeral'), debts: v('debts'), bequest: v('bequest') },
    heirs: {
      husband: spouse === 'husband',
      wives: /^[1-4]$/u.test(spouse) ? Number(spouse) : 0,
      sons: v('sons'), daughters: v('daughters'), sonsSons: v('sonsSons'), sonsDaughters: v('sonsDaughters'),
      father: form.elements.father.checked, mother: form.elements.mother.checked,
      fullBrothers: v('fullBrothers'), fullSisters: v('fullSisters'),
      paternalBrothers: v('paternalBrothers'), paternalSisters: v('paternalSisters'),
      maternalSiblings: v('maternalSiblings'), otherAgnates: form.elements.otherAgnates.checked,
    },
  }
}

function table(caption, rows, numeric) {
  const t = el('table')
  t.append(el('caption', caption))
  for (const cells of rows) {
    const tr = el('tr')
    cells.forEach((c, i) => {
      const cell = el(i === 0 ? 'th' : 'td', undefined, numeric.includes(i) ? 'num' : undefined)
      for (const part of [].concat(c)) cell.append(typeof part === 'string' ? document.createTextNode(part) : part)
      tr.append(cell)
    })
    t.append(tr)
  }
  const wrap = el('div', undefined, 'scroll')
  wrap.append(t)
  return wrap
}

function render() {
  out.textContent = ''
  let r
  try {
    r = calculate(read())
  } catch (error) {
    out.append(el('p', error instanceof Error ? error.message : String(error), 'error'))
    return
  }
  const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: form.elements.currency.value })
  const pct = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 2 })
  const m = minor => money.format(Number(minor) / 100)
  const e = r.estate

  out.append(el('p', 'Net estate for the heirs', 'note'))
  out.append(el('p', m(e.net), 'big'))
  const estateRows = [['Estate', m(e.gross)]]
  if (e.funeral > 0n) estateRows.push(['Less funeral costs', `− ${m(e.funeral)}`])
  if (e.debts > 0n) estateRows.push(['Less debts', `− ${m(e.debts)}`])
  if (e.bequestAsked > 0n) estateRows.push([e.capped ? 'Less bequest (capped at one third)' : 'Less bequest', `− ${m(e.bequest)}`])
  estateRows.push(['Left for the heirs', m(e.net)])
  out.append(table('From estate to inheritance', estateRows, [1]))
  if (e.capped) out.append(el('p', `The will asks for ${m(e.bequestAsked)}, but a bequest may not pass one third of what is left after funeral costs and debts (${m(e.bequestMax)}). The calculator uses the one-third limit.`, 'error'))

  const inherit = r.shares.filter(s => s.basis !== 'excluded')
  const rows = inherit.map((s) => {
    const name = s.count > 1 ? `${s.count} ${s.label.toLowerCase()}` : s.label
    const shareText = s.count > 1 ? `${fractionText(s.fraction)} (${fractionText(s.each)} each)` : fractionText(s.fraction)
    const lo = Math.min(...s.amounts)
    const hi = Math.max(...s.amounts)
    const amount = s.count > 1 ? `${m(s.amount)} (${lo === hi ? m(lo) : `${m(lo)} to ${m(hi)}`} each)` : m(s.amount)
    const fixedNote = s.fixed !== null && fractionText(s.fixed) !== fractionText(s.fraction) ? ` Fixed share ${fractionText(s.fixed)}.` : ''
    return [[name, el('span', `${BASIS[s.basis]}. ${s.rule}.${fixedNote}`, 'hint')], [shareText, el('span', pct.format(fractionValue(s.fraction)), 'hint')], amount]
  })
  if (r.unallocatedAmount > 0 || r.unallocated.n > 0n) rows.push([['Unallocated', el('span', 'See the note below.', 'hint')], fractionText(r.unallocated), m(r.unallocatedAmount)])
  out.append(table(`Shares (the estate in ${r.base} equal parts)`, rows, [2]))

  const excluded = r.shares.filter(s => s.basis === 'excluded')
  if (excluded.length > 0) {
    out.append(el('h3', 'Who inherits nothing, and why'))
    const ul = el('ul')
    for (const s of excluded) ul.append(el('li', `${s.label}: ${s.reason ?? 'Excluded.'}`))
    out.append(ul)
  }
  for (const note of r.notes) out.append(el('p', note, 'callout'))
  out.append(el('p', 'Check the result with a scholar or a Shari\'ah court before dividing a real estate, especially if anyone is missing from this list.', 'note'))
  shown = true
}

form.addEventListener('submit', (event) => { event.preventDefault(); render() })
form.addEventListener('input', () => { if (shown) render() })
form.addEventListener('change', () => { if (shown) render() })
form.addEventListener('reset', () => { shown = false; out.textContent = '' })
