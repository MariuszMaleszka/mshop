import { applyOrdersQuery, normalizeOrdersQuery } from './query.js'

export async function loadOrdersPreview({ records, query, fail = false }) {
  const normalized = normalizeOrdersQuery(query)

  if (!normalized.ok) {
    return { ok: false, errors: normalized.errors, records: [], total: 0 }
  }

  if (fail) {
    return {
      ok: false,
      errors: ['unavailable'],
      records: [],
      total: 0,
    }
  }

  const page = applyOrdersQuery(records, normalized.query)

  return { ok: true, errors: [], ...page }
}
