import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  OrderAmountError,
  calculateOrderAmounts,
} from '../src/order-amounts/calculate.js'

const MAX_AMOUNT = 9223372036854775807n

function line(overrides = {}) {
  return {
    unitGross: '100',
    quantity: 1,
    taxStatus: 'standard',
    vatRate: '23.00',
    ...overrides,
  }
}

function quote(overrides = {}) {
  return calculateOrderAmounts({
    sellerTaxStatus: 'registered',
    strategy: 'per_line',
    lines: [line()],
    ...overrides,
  })
}

function expectedVat(gross, rate) {
  const numerator = BigInt(gross) * BigInt(rate)
  const denominator = 100n + BigInt(rate)
  return ((numerator + denominator / 2n) / denominator).toString()
}

function assertMoneyBalance(result) {
  assert.equal(
    BigInt(result.totals.gross),
    BigInt(result.totals.net) + BigInt(result.totals.tax),
  )

  for (const entry of result.lines) {
    if (entry.lineTax === null) {
      assert.equal(entry.lineNet, null)
      continue
    }

    assert.equal(
      BigInt(entry.lineGross),
      BigInt(entry.lineNet) + BigInt(entry.lineTax),
    )
  }

  for (const group of result.groups ?? []) {
    assert.equal(BigInt(group.gross), BigInt(group.net) + BigInt(group.tax))
  }

  JSON.parse(JSON.stringify(result))
}

describe('order amount calculator', () => {
  it('calculates 23 percent from gross without choosing a production strategy', () => {
    const result = quote()

    assert.equal(result.strategy, 'per_line')
    assert.equal(result.lines[0].catalogVatRate, '23.00')
    assert.equal(result.lines[0].appliedVatRate, '23.00')
    assert.equal(result.lines[0].lineTax, expectedVat(100, 23))
    assert.equal(result.lines[0].lineTax, '19')
    assert.equal(result.lines[0].lineNet, '81')
    assert.equal(result.groups, null)
    assert.equal(result.lineAmountsComplete, true)
    assertMoneyBalance(result)
  })

  it('calculates 8 percent and 5 percent', () => {
    const eight = quote({
      lines: [line({ vatRate: 8 })],
    })
    const five = quote({
      lines: [line({ vatRate: '5.00' })],
    })

    assert.equal(eight.lines[0].lineTax, expectedVat(100, 8))
    assert.equal(eight.lines[0].lineTax, '7')
    assert.equal(eight.lines[0].lineNet, '93')
    assert.equal(five.lines[0].lineTax, expectedVat(100, 5))
    assert.equal(five.lines[0].lineTax, '5')
    assert.equal(five.lines[0].lineNet, '95')
    assertMoneyBalance(eight)
    assertMoneyBalance(five)
  })

  it('keeps zero-rated, exempt, and not-subject amounts free of extracted tax', () => {
    for (const entry of [
      { taxStatus: 'zero_rated', vatRate: '0.00' },
      { taxStatus: 'exempt', vatRate: null },
      { taxStatus: 'not_subject', vatRate: null },
    ]) {
      const result = quote({ lines: [line(entry)] })

      assert.equal(result.lines[0].appliedTaxStatus, entry.taxStatus)
      assert.equal(result.lines[0].lineTax, '0')
      assert.equal(result.lines[0].lineNet, '100')
      assert.equal(result.lines[0].taxAllocation, 'exact')
      assertMoneyBalance(result)
    }
  })

  it('applies seller exemption without changing the catalog snapshot', () => {
    const result = quote({
      sellerTaxStatus: 'exempt',
      strategy: 'per_rate',
      lines: [line(), line({ taxStatus: 'zero_rated', vatRate: 0 })],
    })

    assert.equal(result.lines[0].catalogTaxStatus, 'standard')
    assert.equal(result.lines[0].catalogVatRate, '23.00')
    assert.equal(result.lines[0].appliedTaxStatus, 'exempt')
    assert.equal(result.lines[0].appliedVatRate, null)
    assert.equal(result.lines[0].lineTax, '0')
    assert.equal(result.lines[0].lineNet, result.lines[0].lineGross)
    assert.equal(result.groups.length, 1)
    assert.equal(result.groups[0].tax, '0')
    assert.equal(result.lineAmountsComplete, true)
    assertMoneyBalance(result)
  })

  it('multiplies the unit gross by a quantity above one before rounding', () => {
    const result = quote({
      lines: [line({ unitGross: 100, quantity: 3 })],
    })

    assert.equal(result.lines[0].lineGross, '300')
    assert.equal(result.lines[0].lineTax, expectedVat(300, 23))
    assert.equal(result.lines[0].lineTax, '56')
    assertMoneyBalance(result)
  })

  it('sums several lines of one rate and keeps separate rates apart', () => {
    const sameRate = quote({
      lines: [line(), line({ unitGross: 50 })],
    })
    const mixed = quote({
      lines: [line(), line({ vatRate: '8.00' })],
    })

    assert.equal(sameRate.totals.tax, '28')
    assert.equal(mixed.totals.gross, '200')
    assert.equal(mixed.totals.tax, '26')
    assert.equal(mixed.lines[0].appliedVatRate, '23.00')
    assert.equal(mixed.lines[1].appliedVatRate, '8.00')
    assertMoneyBalance(sameRate)
    assertMoneyBalance(mixed)
  })

  it('shows the grosz difference and does not allocate grouped VAT onto lines', () => {
    const input = {
      sellerTaxStatus: 'registered',
      lines: [line(), line()],
    }
    const perLine = calculateOrderAmounts({ ...input, strategy: 'per_line' })
    const perRate = calculateOrderAmounts({ ...input, strategy: 'per_rate' })

    assert.equal(perLine.totals.tax, '38')
    assert.equal(perRate.totals.tax, '37')
    assert.equal(perRate.groups.length, 1)
    assert.equal(perRate.groups[0].gross, '200')
    assert.equal(perRate.groups[0].tax, '37')
    assert.equal(perRate.groups[0].net, '163')
    assert.equal(perRate.lineAmountsComplete, false)
    assert.deepEqual(
      perRate.lines.map((entry) => entry.lineTax),
      [null, null],
    )
    assert.deepEqual(
      perRate.lines.map((entry) => entry.lineNet),
      [null, null],
    )
    assert.equal(perRate.lines[0].taxAllocation, 'unresolved')
    assert.equal(perRate.lines[0].lineGross, '100')
    assertMoneyBalance(perLine)
    assertMoneyBalance(perRate)
  })

  it('rounds a one-grosz standard amount down to zero tax', () => {
    const result = quote({ lines: [line({ unitGross: 1 })] })

    assert.equal(result.lines[0].lineGross, '1')
    assert.equal(result.lines[0].lineTax, '0')
    assert.equal(result.lines[0].lineNet, '1')
    assertMoneyBalance(result)
  })

  it('rejects an unknown seller and any strategy that was not requested', () => {
    assert.throws(
      () => quote({ sellerTaxStatus: 'unknown' }),
      (error) => error.code === 'SELLER_TAX_STATUS_UNKNOWN',
    )
    assert.throws(
      () => quote({ strategy: undefined }),
      (error) => error.code === 'INVALID_STRATEGY',
    )
  })

  it('rejects invalid tax combinations, prices, and quantities', () => {
    const cases = [
      { lines: [line({ vatRate: '7.00' })] },
      { lines: [line({ vatRate: null })] },
      { lines: [line({ taxStatus: 'zero_rated', vatRate: '23.00' })] },
      { lines: [line({ taxStatus: 'exempt', vatRate: '0.00' })] },
      { lines: [line({ taxStatus: 'not_subject', vatRate: 5 })] },
      { lines: [line({ taxStatus: 'reduced' })] },
      { lines: [line({ unitGross: 0 })] },
      { lines: [line({ unitGross: -1 })] },
      { lines: [line({ quantity: 0 })] },
      { lines: [line({ quantity: -2 })] },
      { lines: [line({ quantity: 1.5 })] },
      { lines: [] },
    ]

    for (const entry of cases) {
      assert.throws(() => quote(entry), OrderAmountError)
    }
  })

  it('rejects values outside the signed bigint amount range', () => {
    const largest = quote({
      lines: [line({ unitGross: MAX_AMOUNT.toString(), quantity: 1 })],
    })

    assert.equal(largest.lines[0].lineGross, MAX_AMOUNT.toString())
    assert.equal(largest.lines[0].lineTax, expectedVat(MAX_AMOUNT, 23))
    assertMoneyBalance(largest)
    assert.throws(
      () =>
        quote({
          lines: [line({ unitGross: MAX_AMOUNT.toString(), quantity: 2 })],
        }),
      (error) => error.code === 'OVERFLOW',
    )
    assert.throws(
      () =>
        quote({ lines: [line({ unitGross: Number.MAX_SAFE_INTEGER + 1 })] }),
      OrderAmountError,
    )
  })
})
