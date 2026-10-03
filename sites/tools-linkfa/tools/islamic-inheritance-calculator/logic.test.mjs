import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calculate, distribute, fractionText, frac, netEstate, splitMinor } from './logic.mjs'

/** Each heir's group share as text, keyed by heir, for compact assertions. */
function shares(heirs) {
  const r = distribute(heirs)
  return Object.fromEntries(r.shares.map(s => [s.key, fractionText(s.fraction)]))
}

function each(heirs, key) {
  return fractionText(distribute(heirs).shares.find(s => s.key === key).each)
}

// Quran 4:12 (husband 1/4 with a child), 4:11 (one daughter 1/2, father 1/6 with a child) and Bukhari 6732
// (what is left to the nearest male, here the father): 1/4 + 1/2 + 1/6 = 11/12, so the father takes 1/6 + 1/12 = 1/4.
test('husband, one daughter and father: 1/4, 1/2, 1/4', () => {
  assert.deepEqual(shares({ husband: true, daughters: 1, father: true }), { husband: '1/4', daughters: '1/2', father: '1/4' })
})

// The second 'Umariyya (IslamWeb fatwa 88267, quoting Khalil: the mother takes a third of what is left after the
// wife): wife 1/4, mother 1/3 × 3/4 = 1/4, father the rest = 1/2.
test('wife, mother and father (\'Umariyya): 1/4, 1/4, 1/2', () => {
  const r = distribute({ wives: 1, mother: true, father: true })
  assert.deepEqual(Object.fromEntries(r.shares.map(s => [s.key, fractionText(s.fraction)])), { wives: '1/4', father: '1/2', mother: '1/4' })
  assert.match(r.notes.join(' '), /'Umariyyatan/u)
})

// The first 'Umariyya: husband 1/2, mother 1/3 × 1/2 = 1/6, father the rest = 1/3.
test('husband, mother and father (\'Umariyya): 1/2, 1/6, 1/3', () => {
  assert.deepEqual(shares({ husband: true, mother: true, father: true }), { husband: '1/2', father: '1/3', mother: '1/6' })
})

// The case put to 'Umar (IslamQA 131556): husband 1/2 + two sisters 2/3 = 7/6, so 'awl scales by 6/7:
// husband 3/7, sisters 4/7 (2/7 each).
test('husband and two full sisters (\'awl): 3/7, 4/7', () => {
  const r = distribute({ husband: true, fullSisters: 2 })
  assert.equal(r.awl, true)
  assert.equal(fractionText(r.fixedTotal), '7/6')
  assert.deepEqual(Object.fromEntries(r.shares.map(s => [s.key, fractionText(s.fraction)])), { husband: '3/7', fullSisters: '4/7' })
  assert.equal(each({ husband: true, fullSisters: 2 }, 'fullSisters'), '2/7')
})

// By hand: husband 1/2 = 3/6, mother 1/6 (two or more siblings), two full sisters 2/3 = 4/6, two maternal half-siblings
// 1/3 = 2/6; total 10/6, so the base 6 rises to 10: 3/10, 1/10, 4/10, 2/10.
test('husband, mother, two full sisters, two maternal half-siblings (\'awl to 10)', () => {
  assert.deepEqual(shares({ husband: true, mother: true, fullSisters: 2, maternalSiblings: 2 }), {
    husband: '3/10', mother: '1/10', fullSisters: '2/5', maternalSiblings: '1/5',
  })
})

// Quran 4:11, "the share of the male will be twice that of the female": 2 units + 1 unit.
test('son and daughter: 2/3, 1/3', () => {
  assert.deepEqual(shares({ sons: 1, daughters: 1 }), { sons: '2/3', daughters: '1/3' })
})

// By hand: wife 1/8 (Quran 4:12, with children); 7/8 left over 4 units (son 2, each daughter 1):
// son 7/16, each daughter 7/32. Compare IslamWeb's wife-son-daughters fatwas (base 32).
test('wife, son and two daughters: 1/8, 7/16, 7/32 each', () => {
  const heirs = { wives: 1, sons: 1, daughters: 2 }
  assert.deepEqual(shares(heirs), { wives: '1/8', sons: '7/16', daughters: '7/16' })
  assert.equal(each(heirs, 'daughters'), '7/32')
})

// Radd, the textbook example: mother 1/6 and daughter 1/2 leave 1/3 with no residuary; the whole goes back in the
// ratio 1:3, so mother 1/4 and daughter 3/4.
test('mother and daughter (radd): 1/4, 3/4', () => {
  const r = distribute({ mother: true, daughters: 1 })
  assert.equal(r.radd, true)
  assert.deepEqual(Object.fromEntries(r.shares.map(s => [s.key, fractionText(s.fraction)])), { daughters: '3/4', mother: '1/4' })
  assert.ok(r.shares.every(s => s.basis === 'fixed+radd'))
})

// Radd without the spouse (IslamWeb 333970: spouses are not included in radd). Wife keeps 1/8; the other 7/8 goes
// to mother and daughter in the ratio 1/6 : 1/2 = 1:3, so mother 7/32 and daughter 21/32.
test('wife, mother and daughter (radd excludes the wife): 1/8, 7/32, 21/32', () => {
  assert.deepEqual(shares({ wives: 1, mother: true, daughters: 1 }), { wives: '1/8', daughters: '21/32', mother: '7/32' })
})

// IslamWeb 333970 itself: wife 2/16 and two daughters 7/16 each after radd.
test('wife and two daughters (IslamWeb 333970): 1/8 and 7/16 each', () => {
  assert.equal(each({ wives: 1, daughters: 2 }, 'daughters'), '7/16')
  assert.equal(shares({ wives: 1, daughters: 2 }).wives, '1/8')
})

// Sahih al-Bukhari 6736 (Ibn Mas'ud's ruling, as the Prophet ruled): daughter 1/2, son's daughter 1/6 completing 2/3,
// and the rest (1/3) to the sister. A paternal half-brother added is excluded by that sister.
test('daughter, son\'s daughter and full sister (Bukhari 6736): 1/2, 1/6, 1/3', () => {
  assert.deepEqual(shares({ daughters: 1, sonsDaughters: 1, fullSisters: 1 }), { daughters: '1/2', sonsDaughters: '1/6', fullSisters: '1/3' })
  const r = distribute({ daughters: 1, sonsDaughters: 1, fullSisters: 1, paternalBrothers: 1 })
  assert.equal(r.shares.find(s => s.key === 'paternalBrothers').basis, 'excluded')
})

// IslamWeb 187729 (siblings "prevented by the existence of the father") and Quran 4:11 (mother 1/6 when there are
// siblings): mother 1/6, father the remaining 5/6, the two brothers nothing.
test('mother, father and two full brothers: 1/6, 5/6, 0', () => {
  assert.deepEqual(shares({ mother: true, father: true, fullBrothers: 2 }), { father: '5/6', mother: '1/6', fullBrothers: '0' })
})

// IslamWeb 187729: father 1/6 + 1/24 residue = 5/24, mother 4/24, wife 3/24, daughter 12/24.
test('father, mother, wife and one daughter (IslamWeb 187729): 5/24, 4/24, 3/24, 12/24', () => {
  assert.deepEqual(shares({ father: true, mother: true, wives: 1, daughters: 1 }), { wives: '1/8', daughters: '1/2', father: '5/24', mother: '1/6' })
})

// IslamWeb 192707: wife 1/4, mother 1/6, two sisters 2/3 = 13/12, divided into 13: 3/13, 2/13, 8/13.
test('wife, mother and two sisters (IslamWeb 192707, \'awl to 13)', () => {
  assert.deepEqual(shares({ wives: 1, mother: true, fullSisters: 2 }), { wives: '3/13', mother: '2/13', fullSisters: '8/13' })
})

// IslamWeb 91857: one full sister 1/2 and paternal half-sisters share 1/6; two full sisters exclude them.
test('paternal half-sisters: 1/6 beside one full sister, nothing beside two', () => {
  const one = shares({ fullSisters: 1, paternalSisters: 2, otherAgnates: true })
  assert.equal(one.fullSisters, '1/2')
  assert.equal(one.paternalSisters, '1/6')
  assert.equal(one.otherAgnates, '1/3')
  assert.equal(shares({ fullSisters: 2, paternalSisters: 1, otherAgnates: true }).paternalSisters, '0')
})

// IslamWeb 228811: two daughters exclude the son's daughter unless a son's son makes her residuary. By hand with a
// son's son: daughters 2/3, the 1/3 left over 3 units (son's son 2, son's daughter 1): 2/9 and 1/9.
test('son\'s daughter beside two daughters: excluded alone, residuary with a son\'s son', () => {
  assert.equal(shares({ daughters: 2, sonsDaughters: 1, otherAgnates: true }).sonsDaughters, '0')
  assert.deepEqual(shares({ daughters: 2, sonsDaughters: 1, sonsSons: 1 }), { daughters: '2/3', sonsSons: '2/9', sonsDaughters: '1/9' })
})

// IslamQA 496015 (Mushtaraka): husband 1/2, mother 1/6, maternal siblings 1/3; on the Hanafi and Hanbali view the full
// brother, a residuary, gets nothing.
test('Mushtaraka: full brother gets nothing (Hanafi and Hanbali)', () => {
  const r = distribute({ husband: true, mother: true, maternalSiblings: 2, fullBrothers: 1 })
  assert.deepEqual(Object.fromEntries(r.shares.map(s => [s.key, fractionText(s.fraction)])), {
    husband: '1/2', mother: '1/6', fullBrothers: '0', maternalSiblings: '1/3',
  })
  assert.match(r.notes.join(' '), /Mushtaraka/u)
})

// IslamQA 193158: a spouse takes no share of the remainder. Wife alone: 1/4, and 3/4 is unallocated.
test('wife alone: 1/4 and 3/4 unallocated', () => {
  const r = distribute({ wives: 1 })
  assert.equal(fractionText(r.unallocated), '3/4')
  assert.equal(r.radd, false)
})

// Bukhari 2742 ("one third, yet even one third is too much"): a bequest is capped at a third of what is left after
// funeral costs and debts. £120,000 − £3,000 − £9,000 = £108,000; cap £36,000; net £72,000.
test('bequest is capped at one third after funeral costs and debts', () => {
  const e = netEstate({ gross: 120000, funeral: 3000, debts: 9000, bequest: 50000 })
  assert.equal(e.capped, true)
  assert.equal(e.bequest, 3_600_000n)
  assert.equal(e.net, 7_200_000n)
  assert.equal(netEstate({ gross: 120000, funeral: 3000, debts: 9000, bequest: 10000 }).capped, false)
  assert.throws(() => netEstate({ gross: 1000, debts: 2000 }), /more than the estate/u)
})

// By hand: £100,000.01 split 1/3 and 2/3 is 3,333,333.67p and 6,666,667.33p; the extra penny goes to the larger
// remainder (the 2/3 side's .33 loses to the 1/3 side's .67).
test('amounts are whole pennies that add up to the net estate exactly', () => {
  assert.deepEqual(splitMinor(10_000_001n, [frac(1, 3), frac(2, 3)]), [3_333_334n, 6_666_667n])
  const r = calculate({ estate: { gross: 100000.01 }, heirs: { wives: 1, sons: 1, daughters: 2 } })
  const total = r.shares.reduce((t, s) => t + s.amount, 0) + r.unallocatedAmount
  assert.equal(total, 10_000_001)
  assert.deepEqual(r.shares.find(s => s.key === 'daughters').amounts, [2_187_500, 2_187_500])
})

test('rejects impossible or empty input', () => {
  assert.throws(() => distribute({ husband: true, wives: 1 }), /both a husband and a wife/u)
  assert.throws(() => distribute({ wives: 5 }), /0 to 4/u)
  assert.throws(() => distribute({ sons: 1.5 }), /whole number/u)
  assert.throws(() => distribute({}), /at least one/u)
})

// The page's worked example, by hand: £150,000 − £3,000 − £12,000 = £135,000; bequest £20,000 is under the £45,000
// cap; net £115,000. Wife 1/8 = £14,375; mother 7/32 = £25,156.25; daughter 21/32 = £75,468.75.
test('worked example on the page: £115,000 to wife, mother and daughter', () => {
  const r = calculate({ estate: { gross: 150000, funeral: 3000, debts: 12000, bequest: 20000 }, heirs: { wives: 1, mother: true, daughters: 1 } })
  assert.equal(r.estate.net, 11_500_000n)
  assert.equal(r.estate.capped, false)
  const amount = Object.fromEntries(r.shares.map(s => [s.key, s.amount]))
  assert.deepEqual(amount, { wives: 1_437_500, daughters: 7_546_875, mother: 2_515_625 })
  assert.equal(r.base, 32n)
})
