/**
 * UK 60% tax trap calculator: income tax and employee Class 1 National Insurance for England, Wales and
 * Northern Ireland in the 2026 to 2027 tax year, the Personal Allowance taper above £100,000 of adjusted net
 * income, and the pension contribution that brings adjusted net income back to £100,000.
 *
 * Figures (GOV.UK, checked 3 October 2026): Personal Allowance £12,570, reduced by £1 for every £2 of adjusted
 * net income over £100,000; basic rate 20% on the first £37,700 of taxable income; higher rate 40% up to
 * £125,140; additional rate 45% above. Employee NI (category A): 8% between £12,570 and £50,270 a year, 2% above.
 * Relief at source contributions and Gift Aid are grossed up by the basic rate (×1.25) and extend both the
 * basic rate limit and the higher rate limit (HMRC Pensions Tax Manual PTM056120).
 */

/** The tax year these figures belong to. */
export const TAX_YEAR = '2026 to 2027'

/** Rates and thresholds for 2026/27, England, Wales and Northern Ireland. */
export const RATES = Object.freeze({
  personalAllowance: 12_570,
  taperStart: 100_000,
  basicRateLimit: 37_700,
  higherRateLimit: 125_140,
  basicRate: 0.20,
  higherRate: 0.40,
  additionalRate: 0.45,
  niPrimaryThreshold: 12_570,
  niUpperEarningsLimit: 50_270,
  niMainRate: 0.08,
  niUpperRate: 0.02,
  /** Relief at source and Gift Aid: what you pay plus basic rate relief, so £1 paid counts as £1.25. */
  grossUp: 1.25,
})

/**
 * @typedef {object} TrapInput
 * @property {number} salary - yearly pay from employment before any salary sacrifice, in pounds.
 * @property {number} [otherIncome] - other taxable non-savings income with no National Insurance, such as rental profit.
 * @property {number} [salarySacrifice] - pay given up each year for employer pension contributions.
 * @property {number} [netPayPension] - pension your employer takes from pay before tax (a net pay arrangement).
 * @property {number} [reliefAtSourceNet] - what you pay yourself into a relief at source pension in the year (before the 25% top-up).
 * @property {number} [giftAidNet] - Gift Aid donations you made in the year (what you paid).
 */

/**
 * @typedef {object} TrapResult
 * @property {number} employmentPay - pay after salary sacrifice; National Insurance is charged on this.
 * @property {number} totalIncome - taxable income before allowances.
 * @property {number} adjustedNetIncome
 * @property {number} allowanceLost - how much of the Personal Allowance the taper removes.
 * @property {number} personalAllowance
 * @property {number} taxableIncome
 * @property {number} basicRateLimit - after extension by grossed-up relief at source and Gift Aid.
 * @property {number} higherRateLimit - after the same extension.
 * @property {{ band: string, rate: number, amount: number, tax: number }[]} bands
 * @property {number} incomeTax
 * @property {number} nationalInsurance
 * @property {number} takeHome - cash left after tax, NI, pension payments you make and Gift Aid.
 * @property {number} pensionAdded - salary sacrifice + net pay + grossed-up relief at source.
 * @property {boolean} overChildcareLimit - adjusted net income over £100,000 (Tax-Free Childcare and working-parent hours lost).
 */

function amount(value, name, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new RangeError(`${name} is required.`)
    return 0
  }
  const n = Number(value)
  if (!Number.isFinite(n)) throw new RangeError(`${name} must be a number.`)
  if (n < 0) throw new RangeError(`${name} cannot be negative.`)
  if (n > 1e9) throw new RangeError(`${name} is too large.`)
  return n
}

/**
 * Validate and fill in a TrapInput.
 * @param {TrapInput} input
 * @returns {Required<TrapInput>}
 */
export function normalise(input) {
  if (input === null || typeof input !== 'object') throw new TypeError('Input must be an object.')
  const out = {
    salary: amount(input.salary, 'Salary', true),
    otherIncome: amount(input.otherIncome, 'Other income'),
    salarySacrifice: amount(input.salarySacrifice, 'Salary sacrifice'),
    netPayPension: amount(input.netPayPension, 'Net pay pension'),
    reliefAtSourceNet: amount(input.reliefAtSourceNet, 'Relief at source contribution'),
    giftAidNet: amount(input.giftAidNet, 'Gift Aid'),
  }
  if (out.salarySacrifice > out.salary) throw new RangeError('Salary sacrifice cannot be more than the salary.')
  if (out.netPayPension > out.salary - out.salarySacrifice) throw new RangeError('Net pay pension cannot be more than the pay left after salary sacrifice.')
  return out
}

/**
 * The Personal Allowance after the taper: £1 less for every £2 of adjusted net income over £100,000.
 * @param {number} adjustedNetIncome
 * @returns {number}
 */
export function personalAllowance(adjustedNetIncome) {
  const excess = Math.max(0, adjustedNetIncome - RATES.taperStart)
  return Math.max(0, RATES.personalAllowance - excess / 2)
}

/**
 * Employee Class 1 National Insurance for a year, assuming pay is spread evenly over the year.
 * @param {number} pay - earnings after salary sacrifice.
 * @returns {number}
 */
export function employeeNI(pay) {
  const main = Math.max(0, Math.min(pay, RATES.niUpperEarningsLimit) - RATES.niPrimaryThreshold)
  const upper = Math.max(0, pay - RATES.niUpperEarningsLimit)
  return main * RATES.niMainRate + upper * RATES.niUpperRate
}

/**
 * Income tax, National Insurance and the Personal Allowance taper for one set of inputs.
 * @param {TrapInput} input
 * @returns {TrapResult}
 */
export function calculate(input) {
  const i = normalise(input)
  const rasGross = i.reliefAtSourceNet * RATES.grossUp
  const giftGross = i.giftAidNet * RATES.grossUp
  const employmentPay = i.salary - i.salarySacrifice
  const totalIncome = employmentPay - i.netPayPension + i.otherIncome
  const adjustedNetIncome = Math.max(0, totalIncome - rasGross - giftGross)
  const pa = personalAllowance(adjustedNetIncome)
  const usedAllowance = Math.min(pa, totalIncome)
  const taxableIncome = Math.max(0, totalIncome - pa)
  const basicRateLimit = RATES.basicRateLimit + rasGross + giftGross
  const higherRateLimit = RATES.higherRateLimit + rasGross + giftGross
  const inBasic = Math.min(taxableIncome, basicRateLimit)
  const inHigher = Math.max(0, Math.min(taxableIncome, higherRateLimit) - basicRateLimit)
  const inAdditional = Math.max(0, taxableIncome - higherRateLimit)
  const bands = [
    { band: 'Personal Allowance', rate: 0, amount: usedAllowance, tax: 0 },
    { band: 'Basic rate', rate: RATES.basicRate, amount: inBasic, tax: inBasic * RATES.basicRate },
    { band: 'Higher rate', rate: RATES.higherRate, amount: inHigher, tax: inHigher * RATES.higherRate },
    { band: 'Additional rate', rate: RATES.additionalRate, amount: inAdditional, tax: inAdditional * RATES.additionalRate },
  ]
  const incomeTax = bands.reduce((sum, b) => sum + b.tax, 0)
  const nationalInsurance = employeeNI(employmentPay)
  const takeHome = totalIncome - incomeTax - nationalInsurance - i.reliefAtSourceNet - i.giftAidNet
  return {
    employmentPay,
    totalIncome,
    adjustedNetIncome,
    allowanceLost: RATES.personalAllowance - pa,
    personalAllowance: pa,
    taxableIncome,
    basicRateLimit,
    higherRateLimit,
    bands,
    incomeTax,
    nationalInsurance,
    takeHome,
    pensionAdded: i.salarySacrifice + i.netPayPension + rasGross,
    overChildcareLimit: adjustedNetIncome > RATES.taperStart,
  }
}

/**
 * The share of the next pounds of salary lost to income tax and NI, measured over a £100 step.
 * @param {TrapInput} input
 * @param {number} [step]
 * @returns {{ tax: number, ni: number, total: number }} rates as fractions (0.6 = 60%).
 */
export function marginalRate(input, step = 100) {
  const now = calculate(input)
  const next = calculate({ ...input, salary: Number(input.salary) + step })
  const tax = (next.incomeTax - now.incomeTax) / step
  const ni = (next.nationalInsurance - now.nationalInsurance) / step
  return { tax, ni, total: tax + ni }
}

/**
 * @typedef {object} EscapeOption
 * @property {'salary-sacrifice' | 'relief-at-source'} method
 * @property {number} youPay - salary given up, or the net amount you pay in.
 * @property {number} grossIntoPension - what reaches the pension from this extra contribution.
 * @property {number} taxSaved
 * @property {number} niSaved
 * @property {number} takeHomeCost - how much less cash you keep.
 * @property {number} effectiveRelief - (grossIntoPension − takeHomeCost) / grossIntoPension.
 * @property {TrapResult} after
 * @property {string} [problem] - why the option is not possible, if it is not.
 */

/**
 * The extra pension contribution that brings adjusted net income down to exactly £100,000, by salary sacrifice
 * and by a relief at source personal contribution, and what each costs and saves.
 * @param {TrapInput} input
 * @returns {{ excess: number, before: TrapResult, options: EscapeOption[] }} excess is 0 (and options empty) when
 *   adjusted net income is already £100,000 or less.
 */
export function escapeTheTrap(input) {
  const i = normalise(input)
  const before = calculate(i)
  const excess = Math.max(0, before.adjustedNetIncome - RATES.taperStart)
  if (excess === 0) return { excess, before, options: [] }
  const option = (method, youPay, grossIntoPension, next) => {
    const after = calculate(next)
    const takeHomeCost = before.takeHome - after.takeHome
    return {
      method, youPay, grossIntoPension,
      taxSaved: before.incomeTax - after.incomeTax,
      niSaved: before.nationalInsurance - after.nationalInsurance,
      takeHomeCost,
      effectiveRelief: (grossIntoPension - takeHomeCost) / grossIntoPension,
      after,
    }
  }
  const options = []
  const room = i.salary - i.salarySacrifice - i.netPayPension
  if (excess <= room) options.push(option('salary-sacrifice', excess, excess, { ...i, salarySacrifice: i.salarySacrifice + excess }))
  else options.push({ method: 'salary-sacrifice', youPay: excess, grossIntoPension: excess, taxSaved: 0, niSaved: 0, takeHomeCost: 0, effectiveRelief: 0, after: before, problem: 'Your salary is too small to sacrifice this much; the excess comes from other income.' })
  const net = excess / RATES.grossUp
  options.push(option('relief-at-source', net, excess, { ...i, reliefAtSourceNet: i.reliefAtSourceNet + net }))
  return { excess, before, options }
}
