import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calculateZakat, nisab, pureGold, pureSilver } from './logic.mjs'

// Known answers, all worked by hand. Prices are illustrative, not market prices:
// pure gold £96 a gram, fine silver £1.20 a gram. Rate 2.5% (NZF, Islamic Relief);
// nisab 85 g / 595 g (Mufti of the Federal Territories, Malaysia) or 87.48 g / 612.36 g (NZF, Islamic Relief).
const GOLD = 96
const SILVER = 1.2
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`)

test('22 karat gold: 100 g holds 100 × 22/24 = 91.666… g of pure gold; 18 karat 50 g holds 37.5 g', () => {
  near(pureGold(100, 22), 275 / 3)
  near(pureGold(50, 18), 37.5)
  near(pureGold(10, 24), 10)
})

test('sterling silver: 200 g at 925 fineness holds 185 g of fine silver', () => {
  near(pureSilver(200, 925), 185)
})

test('the page example: £10,000 cash + 100 g of 22k gold − £2,000 debts gives £420', () => {
  // Gold: 91.666… g × £96 = £8,800. Net: 10,000 + 8,800 − 2,000 = £16,800. Zakat: 16,800 × 2.5% = £420.
  const r = calculateZakat({ cash: 10000, gold: [{ grams: 100, karat: 22 }], goldPrice: GOLD, silverPrice: SILVER, debts: 2000, standard: 'silver' })
  near(r.lines.find(l => l.key === 'gold').value, 8800)
  near(r.net, 16800)
  near(r.zakat, 420)
  assert.equal(r.due, true)
})

test('nisab on both standards side by side: 85 × £96 = £8,160 and 595 × £1.20 = £714', () => {
  const n = nisab({ goldPrice: GOLD, silverPrice: SILVER, weights: '85' })
  near(n.gold.value, 8160)
  near(n.silver.value, 714)
})

test('nisab with the 87.48 g / 612.36 g weights: £8,398.08 gold and £734.832 silver', () => {
  const n = nisab({ goldPrice: GOLD, silverPrice: SILVER, weights: '87.48' })
  near(n.gold.value, 8398.08)
  near(n.silver.value, 734.832)
})

test('£5,000 cash: below the gold nisab (£8,160) so nothing is due; above the silver nisab (£714) so £125 is due', () => {
  const base = { cash: 5000, goldPrice: GOLD, silverPrice: SILVER }
  const g = calculateZakat({ ...base, standard: 'gold' })
  assert.equal(g.due, false)
  assert.equal(g.zakat, 0)
  const s = calculateZakat({ ...base, standard: 'silver' })
  assert.equal(s.due, true)
  near(s.zakat, 125)
})

test('£8,300 cash on the gold standard: due at 85 g (£8,160) but not at 87.48 g (£8,398.08)', () => {
  const base = { cash: 8300, goldPrice: GOLD, silverPrice: SILVER, standard: 'gold' }
  near(calculateZakat({ ...base, weights: '85' }).zakat, 207.5)
  assert.equal(calculateZakat({ ...base, weights: '87.48' }).zakat, 0)
})

test('wealth exactly at the nisab is zakatable: £714 on the silver standard gives £17.85', () => {
  near(calculateZakat({ cash: 714, goldPrice: GOLD, silverPrice: SILVER }).zakat, 17.85)
})

test('personal jewellery: 50 g of 18k counted (Hanafi) adds £3,600; excluded (majority) it is set aside', () => {
  // 37.5 g × £96 = £3,600. Included: (10,000 + 3,600) × 2.5% = £340. Excluded: 10,000 × 2.5% = £250.
  const base = { cash: 10000, gold: [{ grams: 50, karat: 18, jewellery: true }], goldPrice: GOLD, silverPrice: SILVER }
  near(calculateZakat({ ...base, includeJewellery: true }).zakat, 340)
  const ex = calculateZakat({ ...base, includeJewellery: false })
  near(ex.zakat, 250)
  near(ex.excludedJewelleryValue, 3600)
})

test('jewellery exemption leaves gold held as savings counted', () => {
  // Bar 20 g 24k = £1,920 counted; ring 10 g 24k = £960 excluded. (1,920 + 1,000) × 2.5% = £73.
  const r = calculateZakat({
    cash: 1000, goldPrice: GOLD, silverPrice: SILVER, includeJewellery: false,
    gold: [{ grams: 20, karat: 24 }, { grams: 10, karat: 24, jewellery: true }],
  })
  near(r.zakat, 73)
  near(r.excludedJewelleryValue, 960)
})

test('a shop: £40,000 stock at sale value + £5,000 receivable + £3,000 cash − £8,000 due to suppliers gives £1,000', () => {
  const r = calculateZakat({ stock: 40000, receivables: 5000, cash: 3000, debts: 8000, goldPrice: GOLD, silverPrice: SILVER })
  near(r.net, 40000)
  near(r.zakat, 1000)
})

test('1,000 g of sterling silver at £1.20 a fine gram is worth £1,110, so £27.75 is due', () => {
  near(calculateZakat({ silver: [{ grams: 1000, fineness: 925 }], silverPrice: SILVER }).zakat, 27.75)
})

test('debts larger than assets leave nothing zakatable', () => {
  const r = calculateZakat({ cash: 3000, debts: 5000, goldPrice: GOLD, silverPrice: SILVER })
  assert.equal(r.net, 0)
  assert.equal(r.zakat, 0)
  assert.equal(r.due, false)
})

test('bad input is refused with a clear message', () => {
  assert.throws(() => calculateZakat({ cash: -1, silverPrice: SILVER }), /cannot be negative/u)
  assert.throws(() => pureGold(10, 25), /Karat/u)
  assert.throws(() => calculateZakat({ gold: [{ grams: 10, karat: 22 }], silverPrice: SILVER }), /gold price/u)
  assert.throws(() => calculateZakat({ cash: 100, goldPrice: GOLD, standard: 'silver' }), /silver price/u)
  assert.throws(() => calculateZakat({ cash: 'abc', silverPrice: SILVER }), /must be a number/u)
})
