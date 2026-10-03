import { calculateZakat, NISAB_WEIGHTS } from './logic.mjs'

const form = document.getElementById('calc')
const out = document.getElementById('result')
let shown = false

const num = id => form.elements[id].value.trim()

function el(tag, text, cls) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (cls) node.className = cls
  return node
}

function read() {
  return {
    cash: num('cash'), receivables: num('receivables'), stock: num('stock'), otherAssets: num('otherAssets'), debts: num('debts'),
    goldPrice: num('goldPrice'), silverPrice: num('silverPrice'),
    standard: form.elements.standard.value, weights: form.elements.weights.value,
    includeJewellery: form.elements.includeJewellery.checked,
    gold: [
      { grams: num('goldGrams'), karat: form.elements.goldKarat.value },
      { grams: num('jewelGrams'), karat: form.elements.jewelKarat.value, jewellery: true },
    ],
    silver: [
      { grams: num('silverGrams'), fineness: form.elements.silverFine.value },
      { grams: num('silverJewelGrams'), fineness: form.elements.silverJewelFine.value, jewellery: true },
    ],
  }
}

function render() {
  out.textContent = ''
  const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: form.elements.currency.value })
  const grams = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 })
  let r
  try {
    r = calculateZakat(read())
  } catch (error) {
    out.append(el('p', error instanceof Error ? error.message : String(error), 'error'))
    return
  }
  out.append(el('p', r.due ? 'Zakat due' : 'No zakat due', 'note'))
  out.append(el('p', money.format(r.zakat), 'big'))
  out.append(el('p', r.due
    ? `2.5% of ${money.format(r.net)}, which is at or above the ${r.standard} nisab of ${money.format(r.threshold)}.`
    : `Your zakatable wealth of ${money.format(r.net)} is below the ${r.standard} nisab of ${money.format(r.threshold)}.`))

  const nisabTable = el('table')
  const w = NISAB_WEIGHTS[form.elements.weights.value]
  nisabTable.append(el('caption', 'Nisab on both standards at your prices'))
  for (const [name, n] of [['Gold', r.nisab.gold], ['Silver', r.nisab.silver]]) {
    const row = el('tr')
    row.append(el('th', `${name} (${grams.format(name === 'Gold' ? w.gold : w.silver)} g)`))
    const cell = el('td', n.value === null ? 'enter a price' : money.format(n.value), 'num')
    row.append(cell)
    row.append(el('td', n.value !== null && r.net > 0 && Math.round(r.net * 100) >= Math.round(n.value * 100) ? 'met' : 'not met'))
    nisabTable.append(row)
  }
  const wrapN = el('div', undefined, 'scroll')
  wrapN.append(nisabTable)
  out.append(wrapN)

  const table = el('table')
  table.append(el('caption', 'Working'))
  const add = (label, value, strong) => {
    const row = el('tr')
    row.append(el(strong ? 'th' : 'td', label))
    row.append(el('td', value, 'num'))
    table.append(row)
  }
  for (const line of r.lines) if (line.value > 0) add(line.label, money.format(line.value))
  add('Total assets', money.format(r.assets), true)
  if (r.debts > 0) add('Less deductible debts', `− ${money.format(r.debts)}`)
  add('Zakatable wealth', money.format(r.net), true)
  add('Zakat at 2.5%', money.format(r.zakat), true)
  const wrap = el('div', undefined, 'scroll')
  wrap.append(table)
  out.append(wrap)

  if (r.pureGoldGrams > 0 || r.pureSilverGrams > 0) {
    out.append(el('p', `Counted metal: ${grams.format(r.pureGoldGrams)} g of pure gold and ${grams.format(r.pureSilverGrams)} g of fine silver.`, 'note'))
  }
  if (r.excludedJewelleryValue > 0) {
    out.append(el('p', `Jewellery worth ${money.format(r.excludedJewelleryValue)} was left out, following the majority view that personal jewellery is exempt. A Hanafi would include it.`, 'note'))
  }
}

form.addEventListener('submit', (event) => { event.preventDefault(); shown = true; render() })
form.addEventListener('input', () => { if (shown) render() })
form.addEventListener('change', () => { if (shown) render() })
form.addEventListener('reset', () => { shown = false; out.textContent = '' })
