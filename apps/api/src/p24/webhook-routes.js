import { handlePaymentNotification } from './linkage.js'
import { readPaymentNotification } from './notification.js'

export const P24_WEBHOOK_PATH = '/webhooks/payments/przelewy24'
export const P24_WEBHOOK_BODY_LIMIT = 64 * 1024

export function registerP24WebhookRoutes(
  router,
  {
    p24,
    database,
    lockTimeoutMs,
    verifyTransaction,
    beforeVerificationRequestCommit,
    beforeFinalizationStage,
  } = {},
) {
  router.post(P24_WEBHOOK_PATH, async (req, res) => {
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''
    // data.status accepted means the paid update committed with verification_accepted.
    const notification = readPaymentNotification(text, p24)
    const decision = await handlePaymentNotification(database, notification, {
      lockTimeoutMs,
      verifyTransaction,
      beforeVerificationRequestCommit,
      beforeFinalizationStage,
    })

    res.status(202).json({
      data: {
        status: decision.status,
        ...notification,
      },
      meta: {},
    })
  })
}
