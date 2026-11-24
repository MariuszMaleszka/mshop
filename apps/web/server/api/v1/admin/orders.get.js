import { loadAdminOrderList } from '../../../utils/admin-orders-bff.js'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const result = await loadAdminOrderList(event)
  setResponseStatus(event, result.status)
  return result.body
})
