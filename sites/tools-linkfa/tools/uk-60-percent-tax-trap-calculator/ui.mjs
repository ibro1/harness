import { calculate, escapeTheTrap, marginalRate, RATES, TAX_YEAR } from './logic.mjs'

const form = document.getElementById('calc')
const out = document.getElementById('result')
const FIELDS = ['salary', 'otherIncome', 'salarySacrifice', 'netPayPension', 'reliefAtSourceNet', 'giftAidNet']
const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 1 })
const money = n => gbp.format(Math.round(n * 100) / 100 + 0)
let shown = false

function el(tag, text, cls) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (cls) node.className = cls
  return node
}

function table(rows, head) {
  const wrap = el('div', undefined, 'scroll')
  const t = el('table')
  if (head) {
    const tr = el('tr')
    head.forEach((h, i) => tr.append(el('th', h, i === 0 ? undefined : 'num')))
    t.append(el('thead')); t.tHead.append(tr)
  }
  const body = el('tbody')
  for (const row of rows) {
    const tr = el('tr')
    row.forEach((c, i) => tr.append(el(i === 0 ? 'th' : 'td', c, i === 0 ? undefined : 'num')))
    body.append(tr)
  }
  t.append(body)
  wrap.append(t)
  return wrap
}

function read() {
  const input = {}
  for (const id of FIELDS) {
    const v = form.elements[id].value.trim()
    if (v !== '') input[id] = Number(v)
  }
  return input
}

function render() {
  out.textContent = ''
  let input; let r; let esc; let m
  try {
    input = read()
    r = calculate(input)
    esc = escapeTheTrap(input)
    m = marginalRate(input)
  } catch (error) {
    out.append(el('p', error instanceof Error ? error.message : String(error), 'error'))
    return
  }
  shown = true
  out.append(el('p', `Take-home after tax, NI and the payments above (${TAX_YEAR})`, 'note'))
  out.append(el('p', money(r.takeHome), 'big'))
  out.append(table([
    ['Adjusted net income', money(r.adjustedNetIncome)],
    ['Personal Allowance', money(r.personalAllowance)],
    ['Allowance lost to the taper', money(r.allowanceLost)],
    ['Income tax', money(r.incomeTax)],
    ['Employee National Insurance', money(r.nationalInsurance)],
    ['Rate on your next £100 of salary', `${pct.format(m.tax)} tax + ${pct.format(m.ni)} NI`],
  ]))
  out.append(el('h3', 'Income tax by band'))
  out.append(table(r.bands.map(b => [b.band, pct.format(b.rate), money(b.amount), money(b.tax)]), ['Band', 'Rate', 'Income', 'Tax']))
  if (r.allowanceLost > 0) {
    out.append(el('p', `Taper: ${money(r.adjustedNetIncome)} − ${money(RATES.taperStart)} = ${money(r.adjustedNetIncome - RATES.taperStart)} over the limit; half of that, capped at ${money(RATES.personalAllowance)}, is ${money(r.allowanceLost)} of allowance lost.`, 'note'))
  }
  if (esc.excess === 0) {
    out.append(el('p', 'Your adjusted net income is £100,000 or less, so you keep the full Personal Allowance and are under the childcare limit.'))
    return
  }
  out.append(el('h3', `Bringing adjusted net income down to ${money(RATES.taperStart)}`))
  out.append(el('p', `You are ${money(esc.excess)} over. Either route below puts ${money(esc.excess)} into your pension.`))
  const labels = { 'salary-sacrifice': 'Salary sacrifice', 'relief-at-source': 'Personal (relief at source)' }
  const rows = esc.options.filter(o => !o.problem)
  out.append(table([
    ['You give up or pay', ...rows.map(o => money(o.youPay))],
    ['Reaches the pension', ...rows.map(o => money(o.grossIntoPension))],
    ['Income tax saved', ...rows.map(o => money(o.taxSaved))],
    ['NI saved', ...rows.map(o => money(o.niSaved))],
    ['Cost in take-home pay', ...rows.map(o => money(o.takeHomeCost))],
    ['Effective relief', ...rows.map(o => pct.format(o.effectiveRelief))],
  ], ['', ...rows.map(o => labels[o.method])]))
  for (const o of esc.options.filter(x => x.problem)) out.append(el('p', `${labels[o.method]}: ${o.problem}`, 'note'))
  out.append(el('p', 'Relief at source: your provider adds 20% to the pension. The rest of the saving comes back through Self Assessment or your tax code, not straight away.', 'note'))
  if (r.overChildcareLimit) {
    const warn = el('p', 'Childcare: with adjusted net income over £100,000 you cannot get Tax-Free Childcare or the working-parent free hours in England. Bringing it to £100,000 or less restores eligibility; the test is on your expected income for the tax year.', 'callout')
    out.append(warn)
  }
}

form.addEventListener('submit', (event) => { event.preventDefault(); render() })
form.addEventListener('input', () => { if (shown) render() })
form.addEventListener('reset', () => { shown = false; out.textContent = '' })
