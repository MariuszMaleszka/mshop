import { createAccessTokenVerifier } from './auth/tokens.js'
import { registerCartRoutes } from './cart/routes.js'
import { registerCheckoutRoutes } from './checkout/routes.js'
import { registerAdminOrderRoutes } from './admin-orders/routes.js'
import { registerCashReceiptRoutes } from './cash-payment/routes.js'
import { registerOrderRoutes } from './orders/routes.js'
import { createP24Client } from './p24/client.js'
import { registerP24WebhookRoutes } from './p24/webhook-routes.js'
import { registerCatalogRoutes } from './catalog/routes.js'
import { registerGuestSessionRoutes } from './session/routes.js'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createDatabase } from './db/pool.js'
import { createLogger } from './http/logger.js'
import { createShutdown } from './shutdown.js'

let config

try {
  config = loadConfig(process.env)
} catch (error) {
  const message =
    error instanceof Error ? error.message : 'Invalid configuration'
  console.error(message)
  process.exit(1)
}

const logger = createLogger({ nodeEnv: config.nodeEnv })
const database = createDatabase({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
  connectionTimeoutMs: config.databaseConnectionTimeoutMs,
  idleTimeoutMs: config.databaseIdleTimeoutMs,
  logger,
})
const accessTokens = createAccessTokenVerifier({
  supabaseUrl: config.supabaseUrl,
})
const p24Client = config.p24 ? createP24Client(config.p24) : null
const app = createApp(config, {
  logger,
  database,
  accessTokens,
  registerRoutes(router) {
    registerCatalogRoutes(router, { database })
    registerGuestSessionRoutes(router, { nodeEnv: config.nodeEnv })
    registerCartRoutes(router, { database })
    registerCheckoutRoutes(router, { database, p24: config.p24 })
    registerOrderRoutes(router, { database })
    registerCashReceiptRoutes(router, { database })
    registerAdminOrderRoutes(router, { database })
    registerP24WebhookRoutes(router, {
      p24: config.p24,
      database,
      verifyTransaction: p24Client
        ? (input) => p24Client.verifyTransaction(input)
        : undefined,
    })
  },
})
const server = app.listen(config.port, () => {
  logger.info(`API listening on port ${config.port}`)
})
const shutdown = createShutdown({ server, database, logger })

process.on('SIGINT', () => {
  void shutdown()
})
process.on('SIGTERM', () => {
  void shutdown()
})
