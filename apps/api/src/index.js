import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createLogger } from './http/logger.js'

let config

try {
  config = loadConfig(process.env)
} catch (error) {
  const message = error instanceof Error ? error.message : 'Invalid configuration'
  console.error(message)
  process.exit(1)
}

const logger = createLogger({ nodeEnv: config.nodeEnv })
const app = createApp(config, { logger })

app.listen(config.port, () => {
  logger.info(`API listening on port ${config.port}`)
})
