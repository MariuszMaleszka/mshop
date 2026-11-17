export function createShutdown({
  server,
  database,
  logger,
  timeoutMs = 10000,
  exit = process.exit,
}) {
  let started = false

  return async function shutdown() {
    if (started) {
      return
    }

    started = true
    logger.info('API shutting down')

    const timer = setTimeout(() => {
      logger.error('shutdown.timeout')
      exit(1)
    }, timeoutMs)
    timer.unref?.()

    try {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
      await database.close()
      clearTimeout(timer)
      exit(0)
    } catch {
      clearTimeout(timer)
      logger.error('shutdown.failed')
      exit(1)
    }
  }
}
