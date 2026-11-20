export const ADMIN_ORDER_SORT_FIELDS = ['createdAt', 'orderNumber']
export const ADMIN_PAYMENT_STATUSES = [
  'pending',
  'paid',
  'failed',
  'cancelled',
  'refunded',
  'partially_refunded',
]
export const ADMIN_FULFILLMENT_STATUSES = [
  'new',
  'processing',
  'completed',
  'cancelled',
]
export const ADMIN_PAYMENT_METHODS = ['cash', 'online']

export function createAdminOrdersQuery() {
  return {
    page: 1,
    limit: 20,
    sortBy: 'createdAt',
    sortOrder: 'desc',
    search: '',
    paymentStatus: '',
    fulfillmentStatus: '',
    paymentMethod: '',
  }
}

export function withAdminOrdersQuery(current, patch, options = {}) {
  return normalizeAdminOrdersQuery({
    ...current,
    ...patch,
    page: options.resetPage ? 1 : (patch.page ?? current.page),
  })
}

export function normalizeAdminOrdersQuery(input = {}) {
  const page = positiveInteger(input.page, 1)
  const limit = boundedInteger(input.limit, 20, 1, 100)
  const sortBy = ADMIN_ORDER_SORT_FIELDS.includes(input.sortBy)
    ? input.sortBy
    : 'createdAt'
  const sortOrder = input.sortOrder === 'asc' ? 'asc' : 'desc'

  return {
    page,
    limit,
    sortBy,
    sortOrder,
    search: searchText(input.search),
    paymentStatus: allowed(input.paymentStatus, ADMIN_PAYMENT_STATUSES),
    fulfillmentStatus: allowed(
      input.fulfillmentStatus,
      ADMIN_FULFILLMENT_STATUSES,
    ),
    paymentMethod: allowed(input.paymentMethod, ADMIN_PAYMENT_METHODS),
  }
}

export function adminOrdersFiltersActive(query) {
  return Boolean(
    query.search ||
    query.paymentStatus ||
    query.fulfillmentStatus ||
    query.paymentMethod,
  )
}

export function adminOrdersRequestPath(query) {
  const normalized = normalizeAdminOrdersQuery(query)
  const params = new URLSearchParams()
  params.set('page', String(normalized.page))
  params.set('limit', String(normalized.limit))
  params.set('sortBy', normalized.sortBy)
  params.set('sortOrder', normalized.sortOrder)

  if (normalized.search) {
    params.set('search', normalized.search)
  }

  if (normalized.paymentStatus) {
    params.set('paymentStatus', normalized.paymentStatus)
  }

  if (normalized.fulfillmentStatus) {
    params.set('fulfillmentStatus', normalized.fulfillmentStatus)
  }

  if (normalized.paymentMethod) {
    params.set('paymentMethod', normalized.paymentMethod)
  }

  return `admin/orders?${params.toString()}`
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback
}

function boundedInteger(value, fallback, min, max) {
  const parsed = positiveInteger(value, fallback)
  return parsed >= min && parsed <= max ? parsed : fallback
}

function searchText(value) {
  if (typeof value !== 'string') {
    return ''
  }

  return value.trim().slice(0, 80)
}

function allowed(value, values) {
  return values.includes(value) ? value : ''
}
