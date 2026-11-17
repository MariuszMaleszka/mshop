import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'

describe('GET /api/v1/health', () => {
  let server
  let baseUrl

  before(async () => {
    const app = createApp(
      loadConfig({
        NODE_ENV: 'test',
        WEB_ORIGIN: 'http://localhost:3000',
      }),
    )

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve)
    })

    const address = server.address()
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  })

  it('returns 200 and the health payload', async () => {
    const response = await fetch(`${baseUrl}/api/v1/health`)
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.deepEqual(body, {
      data: { status: 'ok' },
      meta: {},
    })
  })
})
