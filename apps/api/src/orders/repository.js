const ORDER_SQL = `
  SELECT
    o.id,
    o.order_number,
    o.payment_status,
    o.fulfillment_status,
    o.payment_method,
    btrim(o.currency) AS currency,
    o.net_amount::text AS net_amount,
    o.tax_amount::text AS tax_amount,
    o.gross_amount::text AS gross_amount,
    (
      SELECT p.initialization_status
      FROM public.payments AS p
      WHERE p.order_id = o.id
        AND p.method = o.payment_method
      ORDER BY p.created_at, p.id
      LIMIT 1
    ) AS initialization_status,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'name', oi.product_name_snapshot,
            'quantity', oi.quantity,
            'unitGrossAmount', oi.unit_gross_amount::text,
            'lineGrossAmount', oi.line_gross_amount::text,
            'currency', btrim(oi.currency)
          )
          ORDER BY oi.id
        )
        FROM public.order_items AS oi
        WHERE oi.order_id = o.id
      ),
      '[]'::json
    ) AS items
  FROM public.orders AS o
  WHERE o.id = $1::uuid
    AND (
      ($2::uuid IS NOT NULL AND o.user_id = $2::uuid)
      OR ($3::char(64) IS NOT NULL AND o.session_id = $3::char(64))
    )
`

export async function findOwnedOrder(database, { orderId, userId, sessionId }) {
  const result = await database.query(ORDER_SQL, [
    orderId,
    userId ?? null,
    sessionId ?? null,
  ])
  const row = result.rows[0]

  if (!row) {
    return null
  }

  return publicOrder(row)
}

function publicOrder(row) {
  const order = {
    id: row.id,
    orderNumber: row.order_number,
    paymentStatus: row.payment_status,
    fulfillmentStatus: row.fulfillment_status,
    paymentMethod: row.payment_method,
    currency: row.currency,
    netAmount: row.net_amount,
    taxAmount: row.tax_amount,
    grossAmount: row.gross_amount,
    items: row.items,
  }

  if (row.payment_method === 'online' && row.initialization_status) {
    order.payment = { initializationStatus: row.initialization_status }
  }

  return order
}
