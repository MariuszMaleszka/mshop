const MAX_QUANTITY = 2147483647n
const MAX_AMOUNT = 9223372036854775807n
const STANDARD_RATES = new Map([
  ['23', 23n],
  ['23.00', 23n],
  ['8', 8n],
  ['8.00', 8n],
  ['5', 5n],
  ['5.00', 5n],
])
const ZERO_RATES = new Map([
  ['0', 0n],
  ['0.00', 0n],
])
const RATE_TEXT = new Map([
  [23n, '23.00'],
  [8n, '8.00'],
  [5n, '5.00'],
  [0n, '0.00'],
])

export class OrderAmountError extends Error {
  constructor(code) {
    super(code)
    this.name = 'OrderAmountError'
    this.code = code
  }
}

export function calculateOrderAmounts({
  sellerTaxStatus,
  strategy,
  lines,
} = {}) {
  if (strategy !== 'per_line' && strategy !== 'per_rate') {
    throw new OrderAmountError('INVALID_STRATEGY')
  }

  if (sellerTaxStatus === 'unknown') {
    throw new OrderAmountError('SELLER_TAX_STATUS_UNKNOWN')
  }

  if (sellerTaxStatus !== 'registered' && sellerTaxStatus !== 'exempt') {
    throw new OrderAmountError('INVALID_SELLER_TAX_STATUS')
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    throw new OrderAmountError('EMPTY_LINES')
  }

  const prepared = lines.map((line) => prepareLine(line, sellerTaxStatus))

  if (strategy === 'per_line') {
    return finish(sellerTaxStatus, strategy, calculatePerLine(prepared))
  }

  return finish(sellerTaxStatus, strategy, calculatePerRate(prepared))
}

function prepareLine(line, sellerTaxStatus) {
  if (line === null || typeof line !== 'object' || Array.isArray(line)) {
    throw new OrderAmountError('INVALID_LINE')
  }

  const unitGross = parseAmount(line.unitGross)
  const quantity = parseQuantity(line.quantity)
  const catalog = parseCatalogTax(line.taxStatus, line.vatRate)
  const lineGross = multiply(unitGross, quantity)
  const applied = applySeller(sellerTaxStatus, catalog)

  return {
    catalog,
    applied,
    unitGross,
    quantity,
    lineGross,
  }
}

function parseCatalogTax(taxStatus, vatRate) {
  if (taxStatus === 'standard') {
    const rate = parseStandardRate(vatRate)

    if (rate === null) {
      throw new OrderAmountError('INVALID_TAX')
    }

    return { taxStatus, rate }
  }

  if (taxStatus === 'zero_rated') {
    if (parseZeroRate(vatRate) !== 0n) {
      throw new OrderAmountError('INVALID_TAX')
    }

    return { taxStatus, rate: 0n }
  }

  if (taxStatus === 'exempt' || taxStatus === 'not_subject') {
    if (vatRate !== null && vatRate !== undefined) {
      throw new OrderAmountError('INVALID_TAX')
    }

    return { taxStatus, rate: null }
  }

  throw new OrderAmountError('INVALID_TAX')
}

function applySeller(sellerTaxStatus, catalog) {
  if (sellerTaxStatus === 'exempt') {
    return { taxStatus: 'exempt', rate: null, percent: false }
  }

  if (catalog.taxStatus === 'standard') {
    return { taxStatus: 'standard', rate: catalog.rate, percent: true }
  }

  return {
    taxStatus: catalog.taxStatus,
    rate: catalog.rate,
    percent: false,
  }
}

function calculatePerLine(lines) {
  const quoted = lines.map((line) => {
    const lineTax = line.applied.percent
      ? vatFromGross(line.lineGross, line.applied.rate)
      : 0n
    const lineNet = subtract(line.lineGross, lineTax)

    return {
      ...line,
      lineTax,
      lineNet,
      taxAllocation: line.applied.percent ? 'per_line' : 'exact',
    }
  })

  return {
    lines: quoted,
    groups: null,
    totals: sumAmounts(quoted),
  }
}

function calculatePerRate(lines) {
  const groups = new Map()

  for (const line of lines) {
    const key = groupKey(line.applied)
    const current = groups.get(key) ?? {
      applied: line.applied,
      gross: 0n,
    }
    current.gross = add(current.gross, line.lineGross)
    groups.set(key, current)
  }

  const quotedGroups = []

  for (const group of groups.values()) {
    const tax = group.applied.percent
      ? vatFromGross(group.gross, group.applied.rate)
      : 0n
    quotedGroups.push({
      appliedTaxStatus: group.applied.taxStatus,
      appliedVatRate: rateText(group.applied.rate),
      gross: group.gross,
      tax,
      net: subtract(group.gross, tax),
    })
  }

  const quotedLines = lines.map((line) => {
    if (line.applied.percent) {
      return {
        ...line,
        lineTax: null,
        lineNet: null,
        taxAllocation: 'unresolved',
      }
    }

    return {
      ...line,
      lineTax: 0n,
      lineNet: line.lineGross,
      taxAllocation: 'exact',
    }
  })

  return {
    lines: quotedLines,
    groups: quotedGroups,
    totals: {
      gross: quotedGroups.reduce((sum, group) => add(sum, group.gross), 0n),
      tax: quotedGroups.reduce((sum, group) => add(sum, group.tax), 0n),
      net: quotedGroups.reduce((sum, group) => add(sum, group.net), 0n),
    },
  }
}

function finish(sellerTaxStatus, strategy, quote) {
  if (quote.totals.gross !== add(quote.totals.net, quote.totals.tax)) {
    throw new OrderAmountError('INVALID_TOTAL')
  }

  return {
    strategy,
    sellerTaxStatus,
    lineAmountsComplete: quote.lines.every(
      (line) => line.lineTax !== null && line.lineNet !== null,
    ),
    lines: quote.lines.map(serializeLine),
    groups: quote.groups?.map(serializeGroup) ?? null,
    totals: {
      gross: amountText(quote.totals.gross),
      tax: amountText(quote.totals.tax),
      net: amountText(quote.totals.net),
    },
  }
}

function serializeLine(line) {
  return {
    catalogTaxStatus: line.catalog.taxStatus,
    catalogVatRate: rateText(line.catalog.rate),
    appliedTaxStatus: line.applied.taxStatus,
    appliedVatRate: rateText(line.applied.rate),
    unitGross: amountText(line.unitGross),
    quantity: Number(line.quantity),
    lineGross: amountText(line.lineGross),
    lineTax: line.lineTax === null ? null : amountText(line.lineTax),
    lineNet: line.lineNet === null ? null : amountText(line.lineNet),
    taxAllocation: line.taxAllocation,
  }
}

function serializeGroup(group) {
  return {
    appliedTaxStatus: group.appliedTaxStatus,
    appliedVatRate: group.appliedVatRate,
    gross: amountText(group.gross),
    tax: amountText(group.tax),
    net: amountText(group.net),
  }
}

function sumAmounts(lines) {
  return {
    gross: lines.reduce((sum, line) => add(sum, line.lineGross), 0n),
    tax: lines.reduce((sum, line) => add(sum, line.lineTax), 0n),
    net: lines.reduce((sum, line) => add(sum, line.lineNet), 0n),
  }
}

function groupKey(applied) {
  return `${applied.taxStatus}:${rateText(applied.rate)}`
}

function vatFromGross(gross, rate) {
  return divideHalfUp(gross * rate, 100n + rate)
}

function divideHalfUp(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator
}

function parseAmount(value) {
  const amount = parseWhole(value)

  if (amount === null || amount <= 0n || amount > MAX_AMOUNT) {
    throw new OrderAmountError('INVALID_PRICE')
  }

  return amount
}

function parseQuantity(value) {
  const quantity = parseWhole(value)

  if (quantity === null || quantity <= 0n || quantity > MAX_QUANTITY) {
    throw new OrderAmountError('INVALID_QUANTITY')
  }

  return quantity
}

function parseWhole(value) {
  if (typeof value === 'bigint' && value >= 0n) {
    return value
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      return null
    }

    return BigInt(value)
  }

  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    return BigInt(value)
  }

  return null
}

function parseStandardRate(value) {
  return STANDARD_RATES.get(rateToken(value)) ?? null
}

function parseZeroRate(value) {
  return ZERO_RATES.get(rateToken(value)) ?? null
}

function rateToken(value) {
  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      return ''
    }

    return String(value)
  }

  if (typeof value === 'string') {
    return value.trim()
  }

  return ''
}

function rateText(rate) {
  if (rate === null) {
    return null
  }

  return RATE_TEXT.get(rate) ?? null
}

function multiply(left, right) {
  if (left !== 0n && right > MAX_AMOUNT / left) {
    throw new OrderAmountError('OVERFLOW')
  }

  return left * right
}

function add(left, right) {
  if (left > MAX_AMOUNT - right) {
    throw new OrderAmountError('OVERFLOW')
  }

  return left + right
}

function subtract(gross, tax) {
  if (tax > gross) {
    throw new OrderAmountError('INVALID_TOTAL')
  }

  return gross - tax
}

function amountText(amount) {
  return amount.toString()
}
