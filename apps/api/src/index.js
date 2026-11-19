import { createAccessTokenVerifier } from './auth/tokens.js'
import { registerCartRoutes } from './cart/routes.js'
import { registerCheckoutRoutes } from './checkout/routes.js'
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
const app = createApp(config, {
  logger,
  database,
  accessTokens,
  registerRoutes(router) {
    registerCatalogRoutes(router, { database })
    registerGuestSessionRoutes(router, { nodeEnv: config.nodeEnv })
    registerCartRoutes(router, { database })
    registerCheckoutRoutes(router, { database })
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
