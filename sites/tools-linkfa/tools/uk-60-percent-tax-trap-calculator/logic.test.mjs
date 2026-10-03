import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calculate, employeeNI, escapeTheTrap, marginalRate, personalAllowance } from './logic.mjs'

// Known answers worked by hand from the GOV.UK 2026/27 figures: Personal Allowance £12,570 tapered by £1 per £2 of
// adjusted net income over £100,000; 20% on the first £37,700 of taxable income, 40% to £125,140, 45% above;
// employee NI 8% from £12,570 to £50,270 and 2% above (gov.uk/income-tax-rates,
// gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027).

const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.005, `${label}: ${actual} ≠ ${expected}`)

test('£100,000 salary keeps the full allowance', () => {
  // Taxable 100,000 − 12,570 = 87,430. Tax 37,700 × 20% = 7,540 + 49,730 × 40% = 19,892 → 27,432.
  // NI 37,700 × 8% = 3,016 + 49,730 × 2% = 994.60 → 4,010.60.
  const r = calculate({ salary: 100_000 })
  near(r.personalAllowance, 12_570, 'allowance')
  near(r.incomeTax, 27_432, 'tax')
  near(r.nationalInsurance, 4_010.6, 'NI')
  near(r.takeHome, 68_557.4, 'take-home')
  assert.equal(r.overChildcareLimit, false)
})

test('£110,000 salary: allowance £7,570', () => {
  // Excess 10,000 → allowance 12,570 − 5,000 = 7,570. Taxable 102,430. Tax 7,540 + 64,730 × 40% = 25,892 → 33,432.
  // NI 3,016 + 59,730 × 2% = 1,194.60 → 4,210.60.
  const r = calculate({ salary: 110_000 })
  near(r.personalAllowance, 7_570, 'allowance')
  near(r.allowanceLost, 5_000, 'lost')
  near(r.incomeTax, 33_432, 'tax')
  near(r.nationalInsurance, 4_210.6, 'NI')
  assert.equal(r.overChildcareLimit, true)
})

test('£125,140 salary: allowance gone', () => {
  // Excess 25,140 → allowance 0 (GOV.UK: "your allowance is zero if your income is £125,140 or above").
  // Tax 7,540 + 87,440 × 40% = 34,976 → 42,516. NI 3,016 + 74,870 × 2% = 1,497.40 → 4,513.40.
  const r = calculate({ salary: 125_140 })
  near(r.personalAllowance, 0, 'allowance')
  near(r.incomeTax, 42_516, 'tax')
  near(r.nationalInsurance, 4_513.4, 'NI')
})

test('£150,000 salary reaches the additional rate', () => {
  // Tax 7,540 + 34,976 + (150,000 − 125,140) × 45% = 11,187 → 53,703. NI 3,016 + 99,730 × 2% = 1,994.60 → 5,010.60.
  const r = calculate({ salary: 150_000 })
  near(r.incomeTax, 53_703, 'tax')
  near(r.nationalInsurance, 5_010.6, 'NI')
})

test('the taper itself: £1 off for every £2 over £100,000', () => {
  // GOV.UK rule applied directly.
  near(personalAllowance(100_000), 12_570, 'at 100k')
  near(personalAllowance(101_000), 12_070, 'at 101k')
  near(personalAllowance(125_140), 0, 'at 125,140')
  near(personalAllowance(200_000), 0, 'at 200k')
})

test('marginal rate between £100,000 and £125,140 is 60% tax + 2% NI', () => {
  // Each extra £1 is taxed at 40% and takes 50p of allowance into tax at 40% (another 20%) = 60%; NI above UEL is 2%.
  const m = marginalRate({ salary: 105_000 })
  near(m.tax, 0.6, 'tax rate')
  near(m.ni, 0.02, 'NI rate')
  near(m.total, 0.62, 'total')
  near(marginalRate({ salary: 90_000 }).total, 0.42, 'below the trap')
  near(marginalRate({ salary: 130_000 }).total, 0.47, 'above the trap')
})

test('£110,000: salary sacrifice of £10,000 restores the allowance', () => {
  // After sacrifice the figures are those of a £100,000 salary: tax 27,432 and NI 4,010.60.
  // Tax saved 33,432 − 27,432 = 6,000; NI saved 4,210.60 − 4,010.60 = 200; take-home falls 10,000 − 6,200 = 3,800.
  const { excess, options } = escapeTheTrap({ salary: 110_000 })
  near(excess, 10_000, 'excess')
  const s = options.find(o => o.method === 'salary-sacrifice')
  near(s.youPay, 10_000, 'sacrifice')
  near(s.taxSaved, 6_000, 'tax saved')
  near(s.niSaved, 200, 'NI saved')
  near(s.takeHomeCost, 3_800, 'cost')
  near(s.effectiveRelief, 0.62, 'relief')
  assert.equal(s.after.overChildcareLimit, false)
})

test('£110,000: relief at source needs £8,000 paid in, grossed up to £10,000', () => {
  // Pay £8,000; provider adds £2,000 basic rate relief (×1.25). ANI 110,000 − 10,000 = 100,000 → allowance 12,570.
  // Taxable 97,430; basic band extended to 47,700: 47,700 × 20% = 9,540 + 49,730 × 40% = 19,892 → 29,432.
  // Tax saved 33,432 − 29,432 = 4,000; NI unchanged; take-home falls 8,000 − 4,000 = 4,000 for £10,000 in the pension.
  const r = escapeTheTrap({ salary: 110_000 }).options.find(o => o.method === 'relief-at-source')
  near(r.youPay, 8_000, 'net paid')
  near(r.grossIntoPension, 10_000, 'gross')
  near(r.after.adjustedNetIncome, 100_000, 'ANI')
  near(r.after.basicRateLimit, 47_700, 'basic band')
  near(r.taxSaved, 4_000, 'tax saved')
  near(r.niSaved, 0, 'NI saved')
  near(r.takeHomeCost, 4_000, 'cost')
  near(r.effectiveRelief, 0.6, 'relief')
})

test('relief at source extends the higher rate limit too (PTM056120)', () => {
  // £150,000 salary, £20,000 paid in → gross 25,000. ANI 125,000 → allowance 12,570 − 12,500 = 70.
  // Taxable 149,930. Basic limit 62,700, higher limit 150,140.
  // Tax 62,700 × 20% = 12,540 + 87,230 × 40% = 34,892 → 47,432; nothing at 45%.
  const r = calculate({ salary: 150_000, reliefAtSourceNet: 20_000 })
  near(r.personalAllowance, 70, 'allowance')
  near(r.higherRateLimit, 150_140, 'higher limit')
  near(r.incomeTax, 47_432, 'tax')
  near(r.bands[3].amount, 0, 'additional band')
})

test('Gift Aid is grossed up in adjusted net income (GOV.UK: £1 donated counts as £1.25)', () => {
  // £104,000 salary, £3,200 Gift Aid → gross 4,000 → ANI 100,000, full allowance.
  const r = calculate({ salary: 104_000, giftAidNet: 3_200 })
  near(r.adjustedNetIncome, 100_000, 'ANI')
  near(r.personalAllowance, 12_570, 'allowance')
})

test('net pay pension cuts tax but not NI; other income has no NI', () => {
  // NI on £110,000 pay is 4,210.60 whatever the net pay deduction; ANI 110,000 − 10,000 = 100,000.
  const r = calculate({ salary: 110_000, netPayPension: 10_000 })
  near(r.adjustedNetIncome, 100_000, 'ANI')
  near(r.incomeTax, 27_432, 'tax')
  near(r.nationalInsurance, 4_210.6, 'NI')
  near(employeeNI(12_570), 0, 'NI at threshold')
  const o = calculate({ salary: 0, otherIncome: 20_000 })
  near(o.nationalInsurance, 0, 'no NI on other income')
  near(o.incomeTax, (20_000 - 12_570) * 0.2, 'basic tax on other income')
})

test('no escape needed at or below £100,000', () => {
  const r = escapeTheTrap({ salary: 100_000 })
  assert.equal(r.excess, 0)
  assert.equal(r.options.length, 0)
})

test('rejects bad input', () => {
  assert.throws(() => calculate({ salary: -1 }), RangeError)
  assert.throws(() => calculate({ salary: 'abc' }), RangeError)
  assert.throws(() => calculate({}), RangeError)
  assert.throws(() => calculate({ salary: 50_000, salarySacrifice: 60_000 }), RangeError)
  assert.throws(() => calculate(null), TypeError)
})
