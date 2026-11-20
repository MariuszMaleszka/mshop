export const ORDER_SORT_FIELDS = [
  'orderNumber',
  'createdAt',
  'customerName',
  'grossAmount',
  'fulfillmentStatus',
  'paymentStatus',
  'deliveryMethod',
]

const FULFILLMENT = ['new', 'processing', 'completed', 'cancelled']
const PAYMENT = [
  'pending',
  'paid',
  'failed',
  'cancelled',
  'refunded',
  'partially_refunded',
]

export function normalizeOrdersQuery(input = {}) {
  const errors = []
  const page = integerField(input.page, 1)
  const limit = integerField(input.limit, 10)
  const sortField = input.sortField ?? 'createdAt'
  const sortOrder = input.sortOrder ?? 'desc'
  const fulfillmentStatus = emptyToNull(input.fulfillmentStatus)
  const paymentStatus = emptyToNull(input.paymentStatus)
  const search = typeof input.search === 'string' ? input.search.trim() : ''
  const dateFrom = dateField(input.dateFrom)
  const dateTo = dateField(input.dateTo)

  if (page === null || page < 1) {
    errors.push('page')
  }

  if (limit === null || limit < 1 || limit > 100) {
    errors.push('limit')
  }

  if (!ORDER_SORT_FIELDS.includes(sortField)) {
    errors.push('sortField')
  }

  if (sortOrder !== 'asc' && sortOrder !== 'desc') {
    errors.push('sortOrder')
  }

  if (fulfillmentStatus && !FULFILLMENT.includes(fulfillmentStatus)) {
    errors.push('fulfillmentStatus')
  }

  if (paymentStatus && !PAYMENT.includes(paymentStatus)) {
    errors.push('paymentStatus')
  }

  if (input.dateFrom && !dateFrom) {
    errors.push('dateFrom')
  }

  if (input.dateTo && !dateTo) {
    errors.push('dateTo')
  }

  if (dateFrom && dateTo && dateFrom > dateTo) {
    errors.push('dateRange')
  }

  if (search.length > 100) {
    errors.push('search')
  }

  return {
    ok: errors.length === 0,
    errors,
    query: {
      page: page ?? 1,
      limit: limit ?? 10,
      sortField,
      sortOrder,
      search,
      fulfillmentStatus,
      paymentStatus,
      dateFrom,
      dateTo,
    },
  }
}

export function applyOrdersQuery(records, query) {
  const search = query.search.toLowerCase()
  const filtered = records.filter((record) => {
    if (
      query.fulfillmentStatus &&
      record.fulfillmentStatus !== query.fulfillmentStatus
    ) {
      return false
    }

    if (query.paymentStatus && record.paymentStatus !== query.paymentStatus) {
      return false
    }

    if (query.dateFrom && record.createdAt < query.dateFrom) {
      return false
    }

    if (query.dateTo && record.createdAt > query.dateTo) {
      return false
    }

    if (!search) {
      return true
    }

    return [record.orderNumber, record.customerName, record.deliveryMethod]
      .join(' ')
      .toLowerCase()
      .includes(search)
  })
  const sorted = [...filtered].sort((left, right) =>
    compareRecords(left, right, query.sortField, query.sortOrder),
  )
  const start = (query.page - 1) * query.limit

  return {
    records: sorted.slice(start, start + query.limit),
    total: filtered.length,
  }
}

function compareRecords(left, right, field, order) {
  const direction = order === 'asc' ? 1 : -1
  const a = left[field]
  const b = right[field]

  if (typeof a === 'number' && typeof b === 'number') {
    return (a - b) * direction
  }

  return String(a).localeCompare(String(b), 'pl') * direction
}

function integerField(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback
  }

  const parsed = Number(value)

  if (!Number.isInteger(parsed)) {
    return null
  }

  return parsed
}

function emptyToNull(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  return String(value)
}

function dateField(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDate(value)
  }

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value
  }

  return null
}

function formatDate(value) {
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')

  return `${value.getFullYear()}-${month}-${day}`
}
