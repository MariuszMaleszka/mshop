import { loadAdminOrderDetail } from '../../../../utils/admin-orders-bff.js'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const result = await loadAdminOrderDetail(event)
  setResponseStatus(event, result.status)
  return result.body
})
