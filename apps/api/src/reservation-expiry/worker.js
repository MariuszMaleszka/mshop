import { pathToFileURL } from 'node:url'
import { loadConfig } from '../config.js'
import { createDatabase } from '../db/pool.js'
import { createLogger } from '../http/logger.js'
import { EXPIRY_INTERVAL_MS, runExpiryPass } from './expire.js'

export function startReservationExpiryWorker({
  database,
  logger,
  intervalMs = EXPIRY_INTERVAL_MS,
  runPass = runExpiryPass,
  closeDatabase = true,
} = {}) {
  let stopped = false
  let pass = null
  const abort = new AbortController()

  async function loop() {
    while (!stopped) {
      pass = Promise.resolve().then(() =>
        runPass(database, {
          logger,
          shouldStop: () => stopped,
        }),
      )

      try {
        await pass
      } catch {
        logger?.error('reservation_expiry.pass_failed')
      } finally {
        pass = null
      }

      if (stopped) {
        break
      }

      await wait(intervalMs, abort.signal)
    }

    if (closeDatabase) {
      await database.close()
    }
  }

  const done = loop()

  return {
    requestStop() {
      stopped = true
      abort.abort()
    },
    finished: done,
  }
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

function isDirectRun() {
  const entry = process.argv[1]

  if (!entry) {
    return false
  }

  return import.meta.url === pathToFileURL(entry).href
}

if (isDirectRun()) {
  const config = loadConfig(process.env)
  const logger = createLogger({ nodeEnv: config.nodeEnv })
  const database = createDatabase({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMs: config.databaseConnectionTimeoutMs,
    idleTimeoutMs: config.databaseIdleTimeoutMs,
    logger,
  })
  const worker = startReservationExpiryWorker({ database, logger })

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      worker.requestStop()
    })
  }

  await worker.finished
}
