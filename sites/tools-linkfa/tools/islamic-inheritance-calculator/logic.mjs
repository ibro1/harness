/**
 * Islamic inheritance (fara'id): who inherits, each heir's exact share, and the amount.
 *
 * Sunni rules as applied by the Hanafi and Hanbali schools, for the heirs listed in HEIRS. Shares are exact
 * fractions held as BigInt numerator/denominator pairs, so 7/32 stays 7/32. Money is handled in whole pennies
 * (or the smallest unit of whatever currency is used) and split by the largest-remainder method, so the amounts
 * always add up to the net estate exactly.
 */

/** @typedef {{ n: bigint, d: bigint }} Fraction */

/**
 * @typedef {object} HeirsInput
 * @property {boolean} [husband]
 * @property {number} [wives] 0–4
 * @property {number} [sons]
 * @property {number} [daughters]
 * @property {number} [sonsSons] sons of sons
 * @property {number} [sonsDaughters] daughters of sons
 * @property {boolean} [father]
 * @property {boolean} [mother]
 * @property {number} [fullBrothers]
 * @property {number} [fullSisters]
 * @property {number} [paternalBrothers] half-brothers through the father
 * @property {number} [paternalSisters] half-sisters through the father
 * @property {number} [maternalSiblings] half-brothers and half-sisters through the mother
 * @property {boolean} [otherAgnates] other male relatives on the father's side (uncles, nephews, cousins)
 */

/**
 * @typedef {object} Share
 * @property {string} key
 * @property {string} label
 * @property {number} count
 * @property {Fraction} fraction - the group's share of the net estate
 * @property {Fraction} each - one person's share
 * @property {'fixed' | 'residue' | 'fixed+residue' | 'fixed+radd' | 'excluded'} basis
 * @property {Fraction | null} fixed - the Quranic fixed share before any 'awl or radd, if any
 * @property {string} rule - the text or ruling the share comes from
 * @property {string} [reason] - why an excluded heir gets nothing
 * @property {number} amount - the group's amount in minor units (pennies)
 * @property {number[]} amounts - each person's amount in minor units
 */

// ---------------------------------------------------------------- exact fractions

function gcd(a, b) {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y !== 0n) [x, y] = [y, x % y]
  return x
}

/**
 * A reduced fraction.
 * @param {bigint | number} n
 * @param {bigint | number} [d]
 * @returns {Fraction}
 */
export function frac(n, d = 1n) {
  let num = BigInt(n)
  let den = BigInt(d)
  if (den === 0n) throw new RangeError('A fraction cannot have a zero denominator.')
  if (den < 0n) { num = -num; den = -den }
  const g = gcd(num, den) || 1n
  return { n: num / g, d: den / g }
}

const ZERO = frac(0)
const ONE = frac(1)
const add = (a, b) => frac(a.n * b.d + b.n * a.d, a.d * b.d)
const sub = (a, b) => frac(a.n * b.d - b.n * a.d, a.d * b.d)
const mul = (a, b) => frac(a.n * b.n, a.d * b.d)
const div = (a, b) => frac(a.n * b.d, a.d * b.n)
const cmp = (a, b) => { const l = a.n * b.d; const r = b.n * a.d; return l < r ? -1 : l > r ? 1 : 0 }
const sum = list => list.reduce(add, ZERO)
const isZero = a => a.n === 0n

/**
 * A fraction as text, such as `7/32` or `1`.
 * @param {Fraction} f
 * @returns {string}
 */
export function fractionText(f) {
  return f.d === 1n ? String(f.n) : `${f.n}/${f.d}`
}

/**
 * The fraction as a decimal, for percentages on screen.
 * @param {Fraction} f
 * @returns {number}
 */
export function fractionValue(f) {
  return Number(f.n * 1_000_000_000n / f.d) / 1_000_000_000
}

// ---------------------------------------------------------------- input checks

/** The heirs the calculator handles, in display order, with their singular and plural names. */
export const HEIRS = [
  ['husband', 'Husband', 'Husband'],
  ['wives', 'Wife', 'Wives'],
  ['sons', 'Son', 'Sons'],
  ['daughters', 'Daughter', 'Daughters'],
  ['sonsSons', 'Son\'s son', 'Sons\' sons'],
  ['sonsDaughters', 'Son\'s daughter', 'Sons\' daughters'],
  ['father', 'Father', 'Father'],
  ['mother', 'Mother', 'Mother'],
  ['fullBrothers', 'Full brother', 'Full brothers'],
  ['fullSisters', 'Full sister', 'Full sisters'],
  ['paternalBrothers', 'Paternal half-brother', 'Paternal half-brothers'],
  ['paternalSisters', 'Paternal half-sister', 'Paternal half-sisters'],
  ['maternalSiblings', 'Maternal half-sibling', 'Maternal half-siblings'],
  ['otherAgnates', 'Other male relatives on the father\'s side', 'Other male relatives on the father\'s side'],
]

const MAX_COUNT = 50

function count(value, name, max = MAX_COUNT) {
  if (value === undefined || value === null || value === '') return 0
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > max) throw new RangeError(`${name} must be a whole number from 0 to ${max}.`)
  return n
}

function flag(value) {
  return value === true || value === 'true' || value === 'on' || value === 1
}

/**
 * Check and normalise the heirs.
 * @param {HeirsInput} input
 * @returns {Required<HeirsInput>}
 */
export function normaliseHeirs(input) {
  const h = {
    husband: flag(input.husband),
    wives: count(input.wives, 'Wives', 4),
    sons: count(input.sons, 'Sons'),
    daughters: count(input.daughters, 'Daughters'),
    sonsSons: count(input.sonsSons, 'Sons\' sons'),
    sonsDaughters: count(input.sonsDaughters, 'Sons\' daughters'),
    father: flag(input.father),
    mother: flag(input.mother),
    fullBrothers: count(input.fullBrothers, 'Full brothers'),
    fullSisters: count(input.fullSisters, 'Full sisters'),
    paternalBrothers: count(input.paternalBrothers, 'Paternal half-brothers'),
    paternalSisters: count(input.paternalSisters, 'Paternal half-sisters'),
    maternalSiblings: count(input.maternalSiblings, 'Maternal half-siblings'),
    otherAgnates: flag(input.otherAgnates),
  }
  if (h.husband && h.wives > 0) throw new RangeError('The deceased cannot leave both a husband and a wife.')
  const anyone = Object.entries(h).some(([, v]) => v === true || (typeof v === 'number' && v > 0))
  if (!anyone) throw new RangeError('Add at least one surviving relative.')
  return h
}

/**
 * Money in minor units (pennies) from a decimal amount.
 * @param {unknown} value
 * @param {string} name
 * @returns {bigint}
 */
export function toMinor(value, name) {
  if (value === undefined || value === null || value === '') return 0n
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`${name} must be zero or a positive amount.`)
  if (n > 1e15) throw new RangeError(`${name} is too large.`)
  return BigInt(Math.round(n * 100))
}

/**
 * The estate left for the heirs: funeral costs, then debts, then a bequest of at most one third of what remains.
 * @param {{ gross: unknown, funeral?: unknown, debts?: unknown, bequest?: unknown }} input - decimal amounts
 * @returns {{ gross: bigint, funeral: bigint, debts: bigint, afterDebts: bigint, bequestAsked: bigint, bequestMax: bigint, bequest: bigint, capped: boolean, net: bigint }}
 *   in minor units; `bequestMax` is one third of `afterDebts`, rounded down to the penny.
 */
export function netEstate(input) {
  const gross = toMinor(input.gross, 'The estate')
  const funeral = toMinor(input.funeral, 'Funeral costs')
  const debts = toMinor(input.debts, 'Debts')
  const bequestAsked = toMinor(input.bequest, 'The bequest')
  if (gross === 0n) throw new RangeError('Enter the value of the estate.')
  if (funeral + debts > gross) throw new RangeError('Funeral costs and debts are more than the estate, so nothing is left to inherit. Debts are paid only as far as the estate goes.')
  const afterDebts = gross - funeral - debts
  const bequestMax = afterDebts / 3n
  const capped = bequestAsked > bequestMax
  const bequest = capped ? bequestMax : bequestAsked
  return { gross, funeral, debts, afterDebts, bequestAsked, bequestMax, bequest, capped, net: afterDebts - bequest }
}

// ---------------------------------------------------------------- the shares

const RULE = {
  spouse: 'Quran 4:12',
  children: 'Quran 4:11: a son takes twice a daughter\'s share',
  daughters: 'Quran 4:11: one daughter 1/2, two or more share 2/3',
  sonsSons: 'Sahih al-Bukhari 6732: what is left goes to the nearest male relative',
  sonsDaughtersAlone: 'Son\'s daughters stand in for daughters when there are none (scholarly agreement; Quran 4:11)',
  sonsDaughterSixth: 'Sahih al-Bukhari 6736: 1/6 beside one daughter, completing 2/3',
  sonsChildren: 'Sahih al-Bukhari 6732; a son\'s son shares with his sisters and cousins 2:1',
  fatherFixed: 'Quran 4:11: each parent 1/6 when there are children',
  fatherFixedResidue: 'Quran 4:11 (1/6) and Sahih al-Bukhari 6732 (what is left)',
  fatherResidue: 'Sahih al-Bukhari 6732: what is left goes to the nearest male relative',
  motherSixth: 'Quran 4:11: 1/6 with children or with brothers and sisters',
  motherThird: 'Quran 4:11: 1/3 when there are no children and fewer than two siblings',
  umariyya: 'The \'Umariyyatan ruling of \'Umar: 1/3 of what is left after the spouse',
  sistersFixed: 'Quran 4:176: one sister 1/2, two or more share 2/3',
  siblingsResidue: 'Quran 4:176: a brother takes twice a sister\'s share',
  sistersWithDaughters: 'Sahih al-Bukhari 6736: sisters take what is left after daughters',
  paternalSisterSixth: '1/6 beside one full sister, completing 2/3 (by the ruling in Sahih al-Bukhari 6736)',
  maternal: 'Quran 4:12: one takes 1/6, two or more share 1/3 equally',
  others: 'Sahih al-Bukhari 6732: what is left goes to the nearest male relative',
}

/**
 * Work out every heir's share of the net estate as an exact fraction.
 *
 * Order of work: exclusions (hajb), fixed shares (fard), 'awl if the fixed shares pass the whole, the residue to the
 * nearest residuary ('asaba), and radd (returning a surplus to the fixed-share heirs other than a spouse) when no
 * residuary is left. If only a spouse remains, the rest is reported as unallocated.
 * @param {HeirsInput} input
 * @returns {{ shares: Share[], fixedTotal: Fraction, awl: boolean, radd: boolean, unallocated: Fraction, notes: string[], base: bigint }}
 */
export function distribute(input) {
  const h = normaliseHeirs(input)
  /** @type {Map<string, { count: number, fixed: Fraction | null, residueWeight: number, basis: string, rule: string, reason?: string, share: Fraction }>} */
  const rows = new Map()
  const notes = []
  const set = (key, count, data) => rows.set(key, { count, fixed: null, residueWeight: 0, basis: 'excluded', rule: '', share: ZERO, ...data })

  const maleDescendant = h.sons > 0 || h.sonsSons > 0
  const descendants = maleDescendant || h.daughters > 0 || h.sonsDaughters > 0
  const siblings = h.fullBrothers + h.fullSisters + h.paternalBrothers + h.paternalSisters + h.maternalSiblings
  const spouseCount = h.husband ? 1 : h.wives

  // Spouse.
  if (h.husband) set('husband', 1, { fixed: descendants ? frac(1, 4) : frac(1, 2), basis: 'fixed', rule: RULE.spouse })
  if (h.wives > 0) set('wives', h.wives, { fixed: descendants ? frac(1, 8) : frac(1, 4), basis: 'fixed', rule: RULE.spouse })
  const spouseShare = rows.get('husband')?.fixed ?? rows.get('wives')?.fixed ?? ZERO

  // Children.
  if (h.sons > 0) {
    set('sons', h.sons, { residueWeight: 2, basis: 'residue', rule: RULE.children })
    if (h.daughters > 0) set('daughters', h.daughters, { residueWeight: 1, basis: 'residue', rule: RULE.children })
  } else if (h.daughters > 0) {
    set('daughters', h.daughters, { fixed: h.daughters === 1 ? frac(1, 2) : frac(2, 3), basis: 'fixed', rule: RULE.daughters })
  }

  // Sons' children.
  if (h.sonsSons > 0) {
    if (h.sons > 0) set('sonsSons', h.sonsSons, { reason: 'Excluded by the son.', rule: RULE.sonsSons })
    else set('sonsSons', h.sonsSons, { residueWeight: 2, basis: 'residue', rule: h.sonsDaughters > 0 ? RULE.sonsChildren : RULE.sonsSons })
  }
  if (h.sonsDaughters > 0) {
    if (h.sons > 0) set('sonsDaughters', h.sonsDaughters, { reason: 'Excluded by the son.', rule: RULE.sonsDaughterSixth })
    else if (h.sonsSons > 0) set('sonsDaughters', h.sonsDaughters, { residueWeight: 1, basis: 'residue', rule: RULE.sonsChildren })
    else if (h.daughters >= 2) set('sonsDaughters', h.sonsDaughters, { reason: 'Excluded: two or more daughters have taken the full 2/3, and no son\'s son is there to make them residuary.', rule: RULE.sonsDaughterSixth })
    else if (h.daughters === 1) set('sonsDaughters', h.sonsDaughters, { fixed: frac(1, 6), basis: 'fixed', rule: RULE.sonsDaughterSixth })
    else set('sonsDaughters', h.sonsDaughters, { fixed: h.sonsDaughters === 1 ? frac(1, 2) : frac(2, 3), basis: 'fixed', rule: RULE.sonsDaughtersAlone })
  }
  const femaleDescendant = h.daughters > 0 || h.sonsDaughters > 0

  // Father.
  if (h.father) {
    if (maleDescendant) set('father', 1, { fixed: frac(1, 6), basis: 'fixed', rule: RULE.fatherFixed })
    else if (femaleDescendant) set('father', 1, { fixed: frac(1, 6), residueWeight: 1, basis: 'fixed+residue', rule: RULE.fatherFixedResidue })
    else set('father', 1, { residueWeight: 1, basis: 'residue', rule: RULE.fatherResidue })
  }

  // Mother.
  const umariyya = h.mother && h.father && spouseCount > 0 && !descendants && siblings < 2
  if (h.mother) {
    if (umariyya) {
      set('mother', 1, { fixed: mul(frac(1, 3), sub(ONE, spouseShare)), basis: 'fixed', rule: RULE.umariyya })
      notes.push(`This is one of the two 'Umariyyatan cases (a spouse and both parents, no children): the mother takes one third of what is left after the ${h.husband ? 'husband' : (h.wives > 1 ? 'wives' : 'wife')}, not one third of the whole, so the father still takes twice her share. 'Umar ruled this way first, and most jurists follow him.`)
    } else if (descendants || siblings >= 2) {
      set('mother', 1, { fixed: frac(1, 6), basis: 'fixed', rule: RULE.motherSixth })
      if (!descendants && h.father) notes.push('The brothers and sisters inherit nothing here because the father excludes them, but they still reduce the mother from 1/3 to 1/6.')
    } else {
      set('mother', 1, { fixed: frac(1, 3), basis: 'fixed', rule: RULE.motherThird })
    }
  }

  // Full siblings.
  const blockSiblings = maleDescendant ? 'a son or son\'s son' : h.father ? 'the father' : null
  let fullSistersWithDaughters = false
  if (h.fullBrothers > 0) {
    if (blockSiblings) set('fullBrothers', h.fullBrothers, { reason: `Excluded by ${blockSiblings}.`, rule: RULE.siblingsResidue })
    else set('fullBrothers', h.fullBrothers, { residueWeight: 2, basis: 'residue', rule: RULE.siblingsResidue })
  }
  if (h.fullSisters > 0) {
    if (blockSiblings) set('fullSisters', h.fullSisters, { reason: `Excluded by ${blockSiblings}.`, rule: RULE.sistersFixed })
    else if (h.fullBrothers > 0) set('fullSisters', h.fullSisters, { residueWeight: 1, basis: 'residue', rule: RULE.siblingsResidue })
    else if (femaleDescendant) {
      fullSistersWithDaughters = true
      set('fullSisters', h.fullSisters, { residueWeight: 1, basis: 'residue', rule: RULE.sistersWithDaughters })
    } else set('fullSisters', h.fullSisters, { fixed: h.fullSisters === 1 ? frac(1, 2) : frac(2, 3), basis: 'fixed', rule: RULE.sistersFixed })
  }

  // Paternal half-siblings.
  const blockPaternal = blockSiblings ? blockSiblings
    : h.fullBrothers > 0 ? 'the full brother'
      : fullSistersWithDaughters ? 'the full sister, who takes what is left beside the daughters'
        : null
  if (h.paternalBrothers > 0) {
    if (blockPaternal) set('paternalBrothers', h.paternalBrothers, { reason: `Excluded by ${blockPaternal}.`, rule: RULE.siblingsResidue })
    else set('paternalBrothers', h.paternalBrothers, { residueWeight: 2, basis: 'residue', rule: RULE.siblingsResidue })
  }
  if (h.paternalSisters > 0) {
    if (blockPaternal) set('paternalSisters', h.paternalSisters, { reason: `Excluded by ${blockPaternal}.`, rule: RULE.sistersFixed })
    else if (h.paternalBrothers > 0) set('paternalSisters', h.paternalSisters, { residueWeight: 1, basis: 'residue', rule: RULE.siblingsResidue })
    else if (h.fullSisters >= 2) set('paternalSisters', h.paternalSisters, { reason: 'Excluded: two or more full sisters have taken the full 2/3, and no paternal half-brother is there to make them residuary.', rule: RULE.paternalSisterSixth })
    else if (h.fullSisters === 1) set('paternalSisters', h.paternalSisters, { fixed: frac(1, 6), basis: 'fixed', rule: RULE.paternalSisterSixth })
    else if (femaleDescendant) set('paternalSisters', h.paternalSisters, { residueWeight: 1, basis: 'residue', rule: RULE.sistersWithDaughters })
    else set('paternalSisters', h.paternalSisters, { fixed: h.paternalSisters === 1 ? frac(1, 2) : frac(2, 3), basis: 'fixed', rule: RULE.sistersFixed })
  }

  // Maternal half-siblings.
  if (h.maternalSiblings > 0) {
    if (descendants) set('maternalSiblings', h.maternalSiblings, { reason: 'Excluded by the deceased\'s children or sons\' children.', rule: RULE.maternal })
    else if (h.father) set('maternalSiblings', h.maternalSiblings, { reason: 'Excluded by the father.', rule: RULE.maternal })
    else set('maternalSiblings', h.maternalSiblings, { fixed: h.maternalSiblings === 1 ? frac(1, 6) : frac(1, 3), basis: 'fixed', rule: RULE.maternal })
  }

  // The Mushtaraka (Himariyya): husband, mother, two or more maternal siblings and full brothers.
  if (h.husband && h.mother && h.maternalSiblings >= 2 && h.fullBrothers > 0 && !descendants && !h.father) {
    notes.push('This is the Mushtaraka (or Himariyya) case. The fixed shares of the husband (1/2), mother (1/6) and maternal half-siblings (1/3) use up the whole estate, so the full brothers, who only take what is left, get nothing. That is the Hanafi and Hanbali view, followed here. The Maliki and Shafi\'i schools, following \'Umar\'s later ruling, let the full siblings share the third equally with the maternal half-siblings.')
  }

  // 'Awl: scale fixed shares down if they pass the whole.
  const fixedRows = [...rows.values()].filter(r => r.fixed !== null)
  const fixedTotal = sum(fixedRows.map(r => r.fixed))
  const awl = cmp(fixedTotal, ONE) > 0
  for (const r of fixedRows) r.share = awl ? div(r.fixed, fixedTotal) : r.fixed
  if (awl) {
    notes.push(`'Awl: the fixed shares add up to ${fractionText(fixedTotal)} of the estate, more than the whole. Every fixed share is scaled down in the same proportion (divided by ${fractionText(fixedTotal)}), as 'Umar ruled when a husband and two sisters were left.`)
  }

  // Residue to the nearest residuary class.
  let residue = awl ? ZERO : sub(ONE, fixedTotal)
  const classes = [
    ['sons', 'daughters'],
    ['sonsSons', 'sonsDaughters'],
    ['father'],
    ['fullBrothers', 'fullSisters'],
    ['paternalBrothers', 'paternalSisters'],
  ]
  let residuaryFound = false
  for (const keys of classes) {
    const members = keys.map(k => rows.get(k)).filter(r => r !== undefined && r.residueWeight > 0)
    if (members.length === 0) continue
    residuaryFound = true
    const units = members.reduce((t, r) => t + r.residueWeight * r.count, 0)
    for (const r of members) {
      const part = mul(residue, frac(r.residueWeight * r.count, units))
      r.share = add(r.share, part)
    }
    // Lower residuary classes get nothing.
    for (const lower of classes.slice(classes.indexOf(keys) + 1)) {
      for (const k of lower) {
        const r = rows.get(k)
        if (r !== undefined && r.residueWeight > 0 && r.fixed === null) {
          r.residueWeight = 0
          r.basis = 'excluded'
          r.reason = `Excluded by a nearer residuary heir (${members.map(m => labelFor(rows, m)).join(', ').toLowerCase()}).`
        }
      }
    }
    if (isZero(residue)) {
      for (const r of members) if (r.fixed === null) r.reason = 'Takes only what is left after the fixed shares, and nothing is left.'
    }
    residue = ZERO
    break
  }

  if (h.otherAgnates) {
    if (!residuaryFound && !isZero(residue)) {
      set('otherAgnates', 1, { basis: 'residue', rule: RULE.others, share: residue })
      notes.push('What is left goes to the nearest male relative on the father\'s side. Who that is (an uncle, a nephew, a cousin) and how they share it needs a scholar: the nearest class takes it all.')
      residue = ZERO
    } else {
      set('otherAgnates', 1, { rule: RULE.others, reason: residuaryFound ? 'Excluded by a nearer residuary heir.' : 'The fixed shares use up the whole estate.' })
    }
  }

  // Radd: return a surplus to the fixed-share heirs except a spouse.
  let radd = false
  let unallocated = ZERO
  if (!isZero(residue)) {
    const returnees = fixedRows.filter(r => !['husband', 'wives'].includes(keyOf(rows, r)))
    if (returnees.length > 0) {
      radd = true
      const pool = sum(returnees.map(r => r.fixed))
      for (const r of returnees) r.share = add(r.share, mul(residue, div(r.fixed, pool)))
      const keeps = h.husband ? ' The husband keeps only his fixed share' : h.wives > 1 ? ' The wives keep only their fixed share' : h.wives === 1 ? ' The wife keeps only her fixed share' : ''
      notes.push(`Radd: ${fractionText(residue)} is left and there is no residuary heir, so it goes back to the fixed-share heirs in proportion to their fixed shares.${keeps === '' ? '' : `${keeps}: a spouse takes no part of the return.`}`)
      for (const r of returnees) r.basis = 'fixed+radd'
      residue = ZERO
    } else {
      unallocated = residue
      notes.push(`${fractionText(residue)} of the estate has no heir in this calculator. A spouse takes no share of the return (radd), so it goes to more distant relatives (dhawu al-arham, such as a daughter's children or a maternal half-brother's sons) if there are any, or otherwise according to the scholars' differing views and local law. Ask a scholar or a Shari'ah court about this remainder.`)
    }
  }

  for (const r of rows.values()) {
    if (r.basis !== 'excluded' && isZero(r.share) && r.reason === undefined) r.reason = 'Nothing is left for this heir.'
  }

  const shares = HEIRS.filter(([key]) => rows.has(key)).map(([key, one, many]) => {
    const r = rows.get(key)
    const share = r.share
    return {
      key, label: r.count === 1 ? one : many, count: r.count, fraction: share, each: div(share, frac(r.count)),
      basis: isZero(share) ? 'excluded' : /** @type {Share['basis']} */ (r.basis), fixed: r.fixed, rule: r.rule,
      ...(r.reason !== undefined && isZero(share) ? { reason: r.reason } : {}),
      amount: 0, amounts: [],
    }
  })
  const total = add(sum(shares.map(s => s.fraction)), unallocated)
  if (cmp(total, ONE) !== 0) throw new Error(`Internal error: shares add up to ${fractionText(total)}, not 1.`)
  const lcm = (a, b) => a / gcd(a, b) * b
  const base = [...shares.map(s => s.each.d), unallocated.d].reduce(lcm, 1n)
  return { shares, fixedTotal, awl, radd, unallocated, notes, base }
}

function keyOf(rows, row) {
  for (const [k, v] of rows) if (v === row) return k
  return ''
}

function labelFor(rows, row) {
  const key = keyOf(rows, row)
  const heir = HEIRS.find(([k]) => k === key)
  return heir === undefined ? key : (row.count === 1 ? heir[1] : heir[2])
}

/**
 * Split whole minor units by exact fractions so the parts add up to the total exactly (largest remainder;
 * ties go to the earlier item).
 * @param {bigint} total
 * @param {Fraction[]} parts - fractions that add up to 1
 * @returns {bigint[]}
 */
export function splitMinor(total, parts) {
  if (total < 0n) throw new RangeError('Cannot split a negative amount.')
  const floors = parts.map(p => (p.n * total) / p.d)
  const rems = parts.map((p, i) => ({ i, r: frac((p.n * total) % p.d, p.d) }))
  let left = total - floors.reduce((a, b) => a + b, 0n)
  rems.sort((a, b) => cmp(b.r, a.r) || a.i - b.i)
  for (const { i } of rems) {
    if (left <= 0n) break
    floors[i] += 1n
    left -= 1n
  }
  return floors
}

/**
 * The full calculation: the estate after funeral costs, debts and bequest, and each heir's share and amount.
 * @param {{ estate: { gross: unknown, funeral?: unknown, debts?: unknown, bequest?: unknown }, heirs: HeirsInput }} input
 * @returns {ReturnType<typeof distribute> & { estate: ReturnType<typeof netEstate>, unallocatedAmount: number }}
 *   with every Share's `amount` and `amounts` filled in minor units.
 */
export function calculate(input) {
  const estate = netEstate(input.estate ?? {})
  const result = distribute(input.heirs ?? {})
  // One item per person, plus the unallocated remainder, so pennies are shared fairly between people too.
  const items = []
  for (const s of result.shares) for (let k = 0; k < s.count; k++) items.push({ s, f: s.each })
  items.push({ s: null, f: result.unallocated })
  const split = splitMinor(estate.net, items.map(it => it.f))
  for (const s of result.shares) { s.amounts = []; s.amount = 0 }
  let unallocatedAmount = 0
  items.forEach((it, i) => {
    const value = Number(split[i])
    if (it.s === null) unallocatedAmount = value
    else { it.s.amounts.push(value); it.s.amount += value }
  })
  return { ...result, estate, unallocatedAmount }
}
