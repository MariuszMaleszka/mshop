const SORT_COLUMNS = {
  createdAt: 'created_at',
  orderNumber: 'order_number',
}

const SORT_DIRECTIONS = {
  asc: 'ASC',
  desc: 'DESC',
}

const FILTER_COLUMNS = {
  paymentStatus: 'payment_status',
  fulfillmentStatus: 'fulfillment_status',
  paymentMethod: 'payment_method',
}

const DETAIL_SQL = `
  SELECT
    o.id,
    o.order_number,
    o.created_at,
    o.updated_at,
    o.customer_id,
    o.customer_email,
    o.customer_type,
    o.billing_snapshot,
    o.seller_tax_status_snapshot,
    o.seller_business_name_snapshot,
    o.seller_nip_snapshot,
    o.seller_street_snapshot,
    o.seller_building_number_snapshot,
    o.seller_unit_number_snapshot,
    o.seller_postal_code_snapshot,
    o.seller_city_snapshot,
    o.seller_country_code_snapshot,
    btrim(o.currency) AS currency,
    o.net_amount::text AS net_amount,
    o.tax_amount::text AS tax_amount,
    o.gross_amount::text AS gross_amount,
    o.payment_method,
    o.payment_status,
    o.fulfillment_status,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'id', oi.id,
            'productId', oi.product_id,
            'name', oi.product_name_snapshot,
            'productType', oi.product_type_snapshot,
            'sku', oi.sku_snapshot,
            'quantity', oi.quantity,
            'currency', btrim(oi.currency),
            'catalogTaxStatus', oi.catalog_tax_status_snapshot,
            'catalogVatRate', oi.catalog_vat_rate_snapshot::text,
            'taxStatus', oi.tax_status_snapshot,
            'vatRate', oi.vat_rate_snapshot::text,
            'unitGrossAmount', oi.unit_gross_amount::text,
            'lineNetAmount', oi.line_net_amount::text,
            'lineTaxAmount', oi.line_tax_amount::text,
            'lineGrossAmount', oi.line_gross_amount::text
          )
          ORDER BY oi.id
        )
        FROM public.order_items AS oi
        WHERE oi.order_id = o.id
      ),
      '[]'::json
    ) AS items,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'id', p.id,
            'method', p.method,
            'provider', p.provider,
            'providerTransactionId', p.provider_transaction_id,
            'status', p.status,
            'amount', p.amount::text,
            'refundedAmount', p.refunded_amount::text,
            'currency', btrim(p.currency),
            'paidAt', p.paid_at,
            'createdAt', p.created_at,
            'updatedAt', p.updated_at,
            'initializationStatus', p.initialization_status
          )
          ORDER BY p.created_at, p.id
        )
        FROM public.payments AS p
        WHERE p.order_id = o.id
      ),
      '[]'::json
    ) AS payments,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'id', r.id,
            'orderItemId', r.order_item_id,
            'productId', r.product_id,
            'quantity', r.quantity,
            'status', r.status,
            'paymentMethod', r.payment_method,
            'createdAt', r.created_at,
            'updatedAt', r.updated_at,
            'expiresAt', r.expires_at
          )
          ORDER BY r.created_at, r.id
        )
        FROM public.inventory_reservations AS r
        WHERE r.order_id = o.id
      ),
      '[]'::json
    ) AS reservations,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'id', h.id,
            'statusType', h.status_type,
            'oldStatus', h.old_status,
            'newStatus', h.new_status,
            'createdAt', h.created_at,
            'changedBy', h.changed_by,
            'note', h.note
          )
          ORDER BY h.created_at, h.id
        )
        FROM public.order_status_history AS h
        WHERE h.order_id = o.id
      ),
      '[]'::json
    ) AS history,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'id', e.id,
            'paymentId', e.payment_id,
            'provider', e.provider,
            'eventType', e.event_type,
            'providerEventId', e.provider_event_id,
            'createdAt', e.created_at,
            'processedAt', e.processed_at
          )
          ORDER BY e.created_at, e.id
        )
        FROM public.payment_events AS e
        JOIN public.payments AS p ON p.id = e.payment_id
        WHERE p.order_id = o.id
      ),
      '[]'::json
    ) AS payment_events
  FROM public.orders AS o
  WHERE o.id = $1::uuid
`

export async function findAdminOrder(database, orderId) {
  const result = await database.query(DETAIL_SQL, [orderId])
  const row = result.rows[0]
  return row ? mapDetail(row) : null
}

export async function listAdminOrders(database, query) {
  const filters = orderFilters(query)
  const orderBy = sortClause(query.sortBy, query.sortOrder)
  const params = [...filters.params, query.limit, query.offset]
  const limitIndex = filters.params.length + 1
  const offsetIndex = filters.params.length + 2
  const listed = await database.query(
    `
      SELECT
        id,
        order_number,
        created_at,
        customer_email,
        customer_type,
        gross_amount::text AS gross_amount,
        btrim(currency) AS currency,
        payment_method,
        payment_status,
        fulfillment_status
      FROM public.orders
      WHERE ${filters.where}
      ${orderBy}
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
    `,
    params,
  )
  const counted = await database.query(
    `
      SELECT count(*)::int AS total
      FROM public.orders
      WHERE ${filters.where}
    `,
    filters.params,
  )

  return {
    rows: listed.rows.map(mapOrder),
    total: readTotal(counted),
  }
}

function orderFilters(query) {
  const clauses = []
  const params = []

  if (query.search) {
    params.push(likeContains(query.search))
    clauses.push(`order_number ILIKE $${params.length} ESCAPE '\\'`)
  }

  for (const [field, column] of Object.entries(FILTER_COLUMNS)) {
    if (query[field]) {
      params.push(query[field])
      clauses.push(`${column} = $${params.length}`)
    }
  }

  return {
    where: clauses.length > 0 ? clauses.join(' AND ') : 'TRUE',
    params,
  }
}

function likeContains(value) {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_')
  return `%${escaped}%`
}

function sortClause(sortBy, sortOrder) {
  const column = SORT_COLUMNS[sortBy]
  const direction = SORT_DIRECTIONS[sortOrder]

  if (!column || !direction) {
    throw new TypeError('Unsupported order sort')
  }

  return `ORDER BY ${column} ${direction}, id ${direction}`
}

function mapOrder(row) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    customer: {
      email: row.customer_email,
      type: row.customer_type,
    },
    grossAmount: row.gross_amount,
    currency: row.currency,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    fulfillmentStatus: row.fulfillment_status,
  }
}

function readTotal(result) {
  const total = result.rows[0]?.total
  return Number.isInteger(total) && total >= 0 ? total : 0
}

function mapDetail(row) {
  return {
    order: {
      id: row.id,
      orderNumber: row.order_number,
      createdAt: isoTime(row.created_at),
      updatedAt: isoTime(row.updated_at),
      paymentMethod: row.payment_method,
      paymentStatus: row.payment_status,
      fulfillmentStatus: row.fulfillment_status,
      currency: row.currency,
      netAmount: row.net_amount,
      taxAmount: row.tax_amount,
      grossAmount: row.gross_amount,
      seller: {
        taxStatus: row.seller_tax_status_snapshot,
        businessName: row.seller_business_name_snapshot,
        nip: row.seller_nip_snapshot,
        street: row.seller_street_snapshot,
        buildingNumber: row.seller_building_number_snapshot,
        unitNumber: row.seller_unit_number_snapshot,
        postalCode: row.seller_postal_code_snapshot,
        city: row.seller_city_snapshot,
        countryCode: row.seller_country_code_snapshot,
      },
    },
    customer: {
      id: row.customer_id,
      email: row.customer_email,
      type: row.customer_type,
      ...billingContact(row.billing_snapshot),
    },
    items: asArray(row.items),
    payments: asArray(row.payments).map(withIsoTimes),
    reservations: asArray(row.reservations).map(withIsoTimes),
    history: asArray(row.history).map(withIsoTimes),
    paymentEvents: asArray(row.payment_events).map(withIsoTimes),
  }
}

function billingContact(snapshot) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {}
  return {
    firstName: textOrNull(source.first_name),
    lastName: textOrNull(source.last_name),
    companyName: textOrNull(source.company_name),
    nip: textOrNull(source.nip),
    phone: textOrNull(source.phone),
    recipient: textOrNull(source.recipient),
    street: textOrNull(source.street),
    buildingNumber: textOrNull(source.building_number),
    apartmentNumber: textOrNull(source.apartment_number),
    postalCode: textOrNull(source.postal_code),
    city: textOrNull(source.city),
    countryCode: textOrNull(source.country_code),
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function withIsoTimes(record) {
  const next = { ...record }

  for (const key of [
    'paidAt',
    'createdAt',
    'updatedAt',
    'expiresAt',
    'processedAt',
  ]) {
    if (key in next) {
      next[key] = isoTime(next[key])
    }
  }

  return next
}

function isoTime(value) {
  if (value instanceof Date) {
    return value.toISOString()
  }

  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function textOrNull(value) {
  return typeof value === 'string' ? value : null
}
