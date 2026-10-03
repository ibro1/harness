/**
 * Zakat calculator: cash, gold and silver by weight and purity, business stock,
 * money owed to you and deductible debts, measured against the nisab on both the
 * gold and the silver standard. No page code here, so the tests can run it.
 */

/** Zakat rate: one fortieth (2.5%) of zakatable wealth held for a lunar year. */
export const ZAKAT_RATE = 0.025

/**
 * Nisab weights in grams. 85 g / 595 g is the 20 mithqal / 200 dirham reading
 * used by many bodies; 87.48 g / 612.36 g is 7.5 / 52.5 tola, which the
 * National Zakat Foundation and Islamic Relief quote.
 */
export const NISAB_WEIGHTS = Object.freeze({
  '85': Object.freeze({ gold: 85, silver: 595, label: '85 g gold / 595 g silver' }),
  '87.48': Object.freeze({ gold: 87.48, silver: 612.36, label: '87.48 g gold / 612.36 g silver' }),
})

/** Currencies offered for display only; prices are entered in the chosen one. */
export const CURRENCIES = ['GBP', 'USD', 'EUR', 'NGN', 'PKR', 'INR', 'MYR', 'SAR', 'AED', 'CAD', 'AUD']

/**
 * A non-negative finite amount, treating blank as zero.
 * @param {unknown} value
 * @param {string} name - shown in the error.
 * @returns {number}
 */
export function amount(value, name) {
  if (value === undefined || value === null || value === '') return 0
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) throw new RangeError(`${name} must be a number.`)
  if (n < 0) throw new RangeError(`${name} cannot be negative.`)
  return n
}

/**
 * Grams of pure gold in an item of the given weight and karat (24 karat is pure).
 * @param {number} grams
 * @param {number} karat - 1 to 24
 * @returns {number}
 */
export function pureGold(grams, karat) {
  const g = amount(grams, 'Gold weight')
  const k = amount(karat, 'Karat')
  if (k <= 0 || k > 24) throw new RangeError('Karat must be above 0 and at most 24.')
  return (g * k) / 24
}

/**
 * Grams of pure silver in an item of the given weight and millesimal fineness (999 is fine silver, 925 sterling).
 * @param {number} grams
 * @param {number} fineness - parts per thousand, 1 to 1000
 * @returns {number}
 */
export function pureSilver(grams, fineness) {
  const g = amount(grams, 'Silver weight')
  const f = amount(fineness, 'Fineness')
  if (f <= 0 || f > 1000) throw new RangeError('Fineness must be above 0 and at most 1000.')
  return (g * f) / 1000
}

/**
 * The nisab on both standards for the given prices. A standard whose price is missing has a null value.
 * @param {{ goldPrice?: number, silverPrice?: number, weights?: '85' | '87.48' }} input - prices per gram of pure metal.
 * @returns {{ gold: { grams: number, value: number | null }, silver: { grams: number, value: number | null } }}
 */
export function nisab(input) {
  const w = NISAB_WEIGHTS[input.weights ?? '85']
  if (w === undefined) throw new RangeError('Nisab weights must be "85" or "87.48".')
  const gp = amount(input.goldPrice, 'Gold price')
  const sp = amount(input.silverPrice, 'Silver price')
  return {
    gold: { grams: w.gold, value: gp > 0 ? w.gold * gp : null },
    silver: { grams: w.silver, value: sp > 0 ? w.silver * sp : null },
  }
}

/**
 * @typedef {object} ZakatInput
 * @property {number} [cash] - cash in hand and in bank accounts, including business cash.
 * @property {number} [receivables] - money owed to you that you expect to be repaid.
 * @property {number} [stock] - business stock at its current sale value.
 * @property {number} [otherAssets] - other zakatable wealth already valued (e.g. shares held for sale).
 * @property {{ grams: number, karat: number, jewellery?: boolean }[]} [gold]
 * @property {{ grams: number, fineness: number, jewellery?: boolean }[]} [silver]
 * @property {number} [goldPrice] - price per gram of pure (24 karat) gold.
 * @property {number} [silverPrice] - price per gram of fine (999) silver.
 * @property {number} [debts] - debts deductible now: arrears and amounts due within the next 12 lunar months.
 * @property {'gold' | 'silver'} [standard] - which nisab decides whether zakat is due.
 * @property {'85' | '87.48'} [weights]
 * @property {boolean} [includeJewellery] - count gold and silver worn as personal jewellery (the Hanafi position).
 */

/**
 * Work out zakat due.
 * @param {ZakatInput} input
 * @returns {{
 *   lines: { key: string, label: string, value: number }[],
 *   assets: number, debts: number, net: number,
 *   pureGoldGrams: number, pureSilverGrams: number, excludedJewelleryValue: number,
 *   nisab: ReturnType<typeof nisab>, standard: 'gold' | 'silver', threshold: number,
 *   due: boolean, zakat: number
 * }}
 */
export function calculateZakat(input) {
  const standard = input.standard ?? 'silver'
  if (standard !== 'gold' && standard !== 'silver') throw new RangeError('Standard must be "gold" or "silver".')
  const includeJewellery = input.includeJewellery !== false
  const goldPrice = amount(input.goldPrice, 'Gold price')
  const silverPrice = amount(input.silverPrice, 'Silver price')
  const cash = amount(input.cash, 'Cash')
  const receivables = amount(input.receivables, 'Money owed to you')
  const stock = amount(input.stock, 'Business stock')
  const otherAssets = amount(input.otherAssets, 'Other assets')
  const debts = amount(input.debts, 'Debts')

  let goldCounted = 0
  let goldExcluded = 0
  for (const item of input.gold ?? []) {
    const pure = pureGold(item.grams, item.karat)
    if (item.jewellery === true && !includeJewellery) goldExcluded += pure
    else goldCounted += pure
  }
  let silverCounted = 0
  let silverExcluded = 0
  for (const item of input.silver ?? []) {
    const pure = pureSilver(item.grams, item.fineness)
    if (item.jewellery === true && !includeJewellery) silverExcluded += pure
    else silverCounted += pure
  }
  if (goldCounted + goldExcluded > 0 && goldPrice === 0) throw new RangeError('Enter the gold price per gram to value your gold.')
  if (silverCounted + silverExcluded > 0 && silverPrice === 0) throw new RangeError('Enter the silver price per gram to value your silver.')

  const n = nisab({ goldPrice, silverPrice, weights: input.weights })
  const threshold = n[standard].value
  if (threshold === null) throw new RangeError(`Enter the ${standard} price per gram: the ${standard} standard nisab needs it.`)

  const lines = [
    { key: 'cash', label: 'Cash and bank balances', value: cash },
    { key: 'gold', label: 'Gold (pure content)', value: goldCounted * goldPrice },
    { key: 'silver', label: 'Silver (pure content)', value: silverCounted * silverPrice },
    { key: 'stock', label: 'Business stock at sale value', value: stock },
    { key: 'receivables', label: 'Money owed to you', value: receivables },
    { key: 'other', label: 'Other zakatable assets', value: otherAssets },
  ]
  const assets = lines.reduce((sum, l) => sum + l.value, 0)
  const net = Math.max(0, assets - debts)
  // Compare in minor units so float noise (595 × 1.2 = 714.0000000000001) cannot flip a boundary case.
  const due = net > 0 && Math.round(net * 100) >= Math.round(threshold * 100)
  return {
    lines, assets, debts, net,
    pureGoldGrams: goldCounted, pureSilverGrams: silverCounted,
    excludedJewelleryValue: goldExcluded * goldPrice + silverExcluded * silverPrice,
    nisab: n, standard, threshold, due,
    zakat: due ? net * ZAKAT_RATE : 0,
  }
}
