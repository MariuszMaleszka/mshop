import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createDatabase } from './db/pool.js'
import { createLogger } from './http/logger.js'
import { createShutdown } from './shutdown.js'

let config

try {
  config = loadConfig(process.env)
} catch (error) {
  const message = error instanceof Error ? error.message : 'Invalid configuration'
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
const app = createApp(config, { logger, database })
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
