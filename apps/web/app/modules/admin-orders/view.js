import { formatGrosze } from '../../utils/money.js'
import {
  fulfillmentStatusView,
  formatOrderDate,
  paymentMethodLabel,
  paymentStatusView,
} from './labels.js'

export function readAdminOrders(result, filtersActive) {
  if (result?.status === 401) {
    return { state: 'unauthorized' }
  }

  if (result?.status === 403) {
    return { state: 'forbidden' }
  }

  if (!result || result.error || !Array.isArray(result.data?.data)) {
    return { state: 'error' }
  }

  const meta = result.data.meta

  if (!validMeta(meta)) {
    return { state: 'error' }
  }

  if (result.data.data.length === 0) {
    return { state: filtersActive ? 'filtered' : 'empty', meta }
  }

  return {
    state: 'ready',
    meta,
    rows: result.data.data.map(presentRow),
  }
}

export function readAdminOrder(result) {
  if (result?.status === 401) {
    return { state: 'unauthorized' }
  }

  if (result?.status === 403) {
    return { state: 'forbidden' }
  }

  if (result?.status === 404) {
    return { state: 'missing' }
  }

  const order = result?.data?.data?.order

  if (!result || result.error || !order || typeof order.id !== 'string') {
    return { state: 'error' }
  }

  return { state: 'ready', order: presentDetail(result.data.data) }
}

function presentRow(row) {
  const source = row && typeof row === 'object' ? row : {}
  return {
    id: typeof source.id === 'string' ? source.id : '',
    orderNumber:
      typeof source.orderNumber === 'string' && source.orderNumber
        ? source.orderNumber
        : 'Brak numeru',
    createdAt: formatOrderDate(source.createdAt),
    email:
      typeof source.customer?.email === 'string' && source.customer.email
        ? source.customer.email
        : 'Brak adresu e-mail',
    amount:
      formatGrosze(source.grossAmount, source.currency) ?? 'Nieznana kwota',
    method: paymentMethodLabel(source.paymentMethod),
    payment: paymentStatusView(source.paymentStatus),
    fulfillment: fulfillmentStatusView(source.fulfillmentStatus),
  }
}

function presentDetail(data) {
  const order = data.order
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    createdAt: formatOrderDate(order.createdAt),
    amount: formatGrosze(order.grossAmount, order.currency) ?? 'Nieznana kwota',
    method: paymentMethodLabel(order.paymentMethod),
    payment: paymentStatusView(order.paymentStatus),
    fulfillment: fulfillmentStatusView(order.fulfillmentStatus),
    email:
      typeof data.customer?.email === 'string' && data.customer.email
        ? data.customer.email
        : 'Brak adresu e-mail',
    payments: Array.isArray(data.payments)
      ? data.payments.map((payment) => ({
          id: payment.id,
          status: paymentStatusView(payment.status),
          initialization:
            typeof payment.initializationStatus === 'string'
              ? payment.initializationStatus
              : null,
        }))
      : [],
  }
}

function validMeta(meta) {
  return (
    meta &&
    Number.isSafeInteger(meta.page) &&
    Number.isSafeInteger(meta.limit) &&
    Number.isSafeInteger(meta.total) &&
    Number.isSafeInteger(meta.totalPages) &&
    meta.page >= 1 &&
    meta.limit >= 1 &&
    meta.total >= 0 &&
    meta.totalPages >= 0
  )
}
