const UNKNOWN = { label: 'Nierozpoznany', tone: 'danger' }

const PAYMENT = {
  pending: { label: 'Oczekuje', tone: 'warning' },
  paid: { label: 'Opłacone', tone: 'success' },
  failed: { label: 'Nieudane', tone: 'danger' },
  cancelled: { label: 'Anulowana', tone: 'neutral' },
  refunded: { label: 'Zwrot', tone: 'info' },
  partially_refunded: { label: 'Częściowy zwrot', tone: 'info' },
}

const FULFILLMENT = {
  new: { label: 'Nowe', tone: 'info' },
  processing: { label: 'W realizacji', tone: 'warning' },
  completed: { label: 'Zrealizowane', tone: 'success' },
  cancelled: { label: 'Anulowane', tone: 'neutral' },
}

const METHOD = {
  cash: 'Gotówka',
  online: 'Płatność online',
}

const dateFormat = new Intl.DateTimeFormat('pl-PL', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Warsaw',
})

export function paymentStatusView(value) {
  return PAYMENT[value] ?? UNKNOWN
}

export function fulfillmentStatusView(value) {
  return FULFILLMENT[value] ?? UNKNOWN
}

export function paymentMethodLabel(value) {
  return METHOD[value] ?? 'Nierozpoznana'
}

export function formatOrderDate(value) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return 'Nieznana data'
  }

  return dateFormat.format(date)
}
