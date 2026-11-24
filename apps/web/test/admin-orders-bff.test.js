import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'
import { sha256Hex } from '../../api/src/account-session/repository.js'
import { accountSessionCookieName } from '../server/utils/account-login.js'
import {
  loadAdminOrderDetail,
  loadAdminOrderList,
} from '../server/utils/admin-orders-bff.js'

const secret = randomBytes(32).toString('base64')
const sessionId = randomBytes(32).toString('base64url')
const accessToken = 'access-token-value'
const refreshToken = 'refresh-token-value'
const browserToken = 'browser-bearer-token'
const userId = randomUUID()
const orderId = '6f1c2a40-1c0e-4d0a-9a31-0b5e2f6a7c11'
const apiBase = 'http://127.0.0.1:3001/api/v1'
const cookieName = accountSessionCookieName(process.env.NODE_ENV)
const calls = []
const originalFetch = globalThis.fetch

globalThis.defineEventHandler = (handler) => handler
globalThis.setResponseHeader = (event, name, value) => {
  event.node.res.setHeader(name, value)
}
globalThis.setResponseStatus = (event, status) => {
  event.status = status
}
globalThis.getQuery = (event) => event.query ?? {}
globalThis.getRouterParam = (event, name) => event.params?.[name]
globalThis.useRuntimeConfig = () => ({
  bffInternalSecret: secret,
  public: { apiBase },
})

const { default: listHandler } =
  await import('../server/api/v1/admin/orders.get.js')
const { default: detailHandler } =
  await import('../server/api/v1/admin/orders/[id].get.js')

function orderList() {
  return {
    data: [
      {
        id: orderId,
        orderNumber: 'M1',
        customer: { email: 'anna@example.com' },
      },
    ],
    meta: { page: 2, limit: 20, total: 1, totalPages: 1 },
  }
}

function orderDetail() {
  return {
    data: {
      order: { id: orderId, orderNumber: 'M1' },
      customer: { email: 'anna@example.com' },
      payments: [],
    },
    meta: {},
  }
}

function readySession() {
  return {
    status: 'ready',
    userId,
    accessToken,
    refreshToken,
    keyVersion: 1,
  }
}

function expressError(code, message = 'Safe upstream message', extra) {
  return {
    error: {
      code,
      message,
      details: extra ? [{ message: extra }] : [],
    },
  }
}

function eventFor({ cookie = `${cookieName}=${sessionId}`, query, id } = {}) {
  return {
    status: undefined,
    query,
    params: { id },
    node: {
      req: {
        socket: { remoteAddress: '203.0.113.10' },
        headers: {
          cookie,
          authorization: `Bearer ${browserToken}`,
          'x-forwarded-for': '192.0.2.20',
          'x-mshop-client-ip': '198.51.100.8',
        },
      },
      res: headerStore(),
    },
  }
}

function headerStore() {
  const headers = new Map()
  return {
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value)
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase())
    },
  }
}

function hidden(body) {
  const visible = JSON.stringify(body)
  assert.equal(visible.includes(accessToken), false)
  assert.equal(visible.includes(refreshToken), false)
  assert.equal(visible.includes(secret), false)
  assert.equal(visible.includes(sessionId), false)
  assert.equal(visible.includes(sha256Hex(sessionId)), false)
  assert.equal(visible.includes(browserToken), false)
}

function installFetch(admin) {
  calls.length = 0
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: options.signal,
    })

    if (String(url).endsWith('/internal/account-sessions/inspect')) {
      return Response.json(readySession())
    }

    return admin(url, options)
  }
}

function adminCalls() {
  return calls.filter((call) => call.url.includes('/admin/orders'))
}

describe('admin order BFF routes', () => {
  after(() => {
    globalThis.fetch = originalFetch
  })

  it('rejects a missing, duplicated, or invalid session cookie', async () => {
    installFetch(async () => Response.json(orderList()))
    const name = cookieName
    const cookies = [
      '',
      `${name}=${sessionId}; ${name}=${sessionId}`,
      `${name}=`,
      `${name}=%ZZ`,
      `${name}=not-a-session`,
    ]

    for (const cookie of cookies) {
      calls.length = 0
      const event = eventFor({ cookie })
      const body = await listHandler(event)

      assert.equal(event.status, 401)
      assert.equal(event.node.res.getHeader('cache-control'), 'no-store')
      assert.deepEqual(body, {
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          details: [],
        },
      })
      hidden(body)
      assert.equal(calls.length, 0)
    }
  })

  it('stops before the order request when inspection is not ready', async () => {
    const cases = [
      [401, { code: 'invalid_session' }, 401, 'UNAUTHORIZED'],
      [429, { code: 'rate_limited' }, 429, 'RATE_LIMITED'],
      [503, { code: 'session_pending' }, 503, 'SERVICE_UNAVAILABLE'],
      [503, { code: 'service_unavailable' }, 503, 'SERVICE_UNAVAILABLE'],
    ]

    for (const [status, payload, expected, code] of cases) {
      installFetch(async () => Response.json(orderList()))
      globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), options })
        assert.equal(String(url).includes('/admin/orders'), false)
        return Response.json(payload, { status })
      }
      calls.length = 0
      const list = eventFor()
      const detail = eventFor({ id: orderId })
      const listBody = await listHandler(list)
      const detailCalls = calls.length
      const detailBody = await detailHandler(detail)

      assert.equal(list.status, expected)
      assert.equal(detail.status, expected)
      assert.equal(listBody.error.code, code)
      assert.equal(detailBody.error.code, code)
      assert.equal(list.node.res.getHeader('cache-control'), 'no-store')
      assert.equal(detail.node.res.getHeader('cache-control'), 'no-store')
      hidden(listBody)
      hidden(detailBody)
      assert.equal(detailCalls, 1)
      assert.equal(calls.length, 2)
    }
  })

  it('reads the list and the detail once with the session bearer', async () => {
    installFetch(async (url) =>
      Response.json(
        String(url).endsWith(orderId) ? orderDetail() : orderList(),
      ),
    )
    const listEvent = eventFor({
      query: {
        page: '2',
        limit: '20',
        search: 'M2026',
        paymentStatus: 'pending',
        clientIp: '192.0.2.9',
        accessToken: browserToken,
      },
    })
    const detailEvent = eventFor({ id: orderId })
    const listBody = await listHandler(listEvent)
    const detailBody = await detailHandler(detailEvent)
    const orders = adminCalls()

    assert.equal(listEvent.status, 200)
    assert.equal(detailEvent.status, 200)
    assert.equal(listEvent.node.res.getHeader('cache-control'), 'no-store')
    assert.equal(detailEvent.node.res.getHeader('cache-control'), 'no-store')
    assert.deepEqual(listBody, orderList())
    assert.deepEqual(detailBody, orderDetail())
    assert.equal(orders.length, 2)
    assert.equal(orders[0].method, 'GET')
    assert.equal(orders[0].body, undefined)
    assert.equal(orders[0].headers.authorization, `Bearer ${accessToken}`)
    assert.equal(orders[1].headers.authorization, `Bearer ${accessToken}`)
    assert.equal(orders[0].headers['x-mshop-internal-secret'], undefined)
    assert.equal(orders[0].headers['x-mshop-client-ip'], undefined)
    assert.equal(
      JSON.stringify(orders[0].headers).includes(browserToken),
      false,
    )
    const listUrl = new URL(orders[0].url)
    assert.equal(listUrl.origin + listUrl.pathname, `${apiBase}/admin/orders`)
    assert.equal(listUrl.searchParams.get('page'), '2')
    assert.equal(listUrl.searchParams.get('limit'), '20')
    assert.equal(listUrl.searchParams.get('search'), 'M2026')
    assert.equal(listUrl.searchParams.get('paymentStatus'), 'pending')
    assert.equal(listUrl.searchParams.get('clientIp'), null)
    assert.equal(listUrl.searchParams.get('accessToken'), null)
    assert.equal(orders[1].url, `${apiBase}/admin/orders/${orderId}`)
    hidden({ list: listBody, detail: detailBody })
  })

  it('maps Express statuses and rejects an unexpected body', async () => {
    const cases = [
      [400, expressError('VALIDATION_ERROR'), 400, 'VALIDATION_ERROR'],
      [401, expressError('UNAUTHORIZED'), 401, 'UNAUTHORIZED'],
      [403, expressError('FORBIDDEN'), 403, 'FORBIDDEN'],
      [404, expressError('NOT_FOUND'), 404, 'NOT_FOUND'],
      [503, expressError('SERVICE_UNAVAILABLE'), 503, 'SERVICE_UNAVAILABLE'],
      [
        401,
        expressError('UNAUTHORIZED', `bad ${accessToken}`),
        503,
        'SERVICE_UNAVAILABLE',
      ],
      [
        200,
        { data: orderList().data, meta: orderList().meta, accessToken },
        503,
        'SERVICE_UNAVAILABLE',
      ],
      [500, expressError('INTERNAL_ERROR'), 503, 'SERVICE_UNAVAILABLE'],
      [200, { data: { id: orderId } }, 503, 'SERVICE_UNAVAILABLE'],
    ]

    for (const [status, payload, expected, code] of cases) {
      installFetch(async () => Response.json(payload, { status }))
      const list = eventFor()
      const detail = eventFor({ id: orderId })
      const listBody = await listHandler(list)
      const detailBody = await detailHandler(detail)

      assert.equal(list.status, expected)
      assert.equal(detail.status, expected)
      assert.equal(listBody.error.code, code)
      assert.equal(detailBody.error.code, code)
      assert.equal(list.node.res.getHeader('cache-control'), 'no-store')
      hidden(listBody)
      hidden(detailBody)
      assert.equal(adminCalls().length, 2)
    }
  })

  it('returns 400 for an invalid order id without calling Express', async () => {
    installFetch(async () => Response.json(orderDetail()))
    const event = eventFor({ id: '../admin' })
    const body = await detailHandler(event)

    assert.equal(event.status, 400)
    assert.equal(event.node.res.getHeader('cache-control'), 'no-store')
    assert.equal(body.error.code, 'VALIDATION_ERROR')
    hidden(body)
    assert.equal(calls.length, 0)
  })

  it('stops after one network failure or timeout on each route', async () => {
    installFetch(async () => {
      throw new Error(`network ${accessToken} ${sessionId}`)
    })
    const list = await listHandler(eventFor())
    const detail = await detailHandler(eventFor({ id: orderId }))

    assert.equal(list.error.code, 'SERVICE_UNAVAILABLE')
    assert.equal(detail.error.code, 'SERVICE_UNAVAILABLE')
    hidden(list)
    hidden(detail)
    assert.equal(adminCalls().length, 2)

    let timeouts = 0
    const fetchImpl = (url, options) => {
      if (String(url).endsWith('/internal/account-sessions/inspect')) {
        return Response.json(readySession())
      }

      timeouts += 1
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('hung')), 1000)
        options.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(options.signal.reason)
        })
      })
    }
    const timedList = await loadAdminOrderList(eventFor(), {
      fetchImpl,
      timeoutMs: 20,
    })
    const timedDetail = await loadAdminOrderDetail(eventFor({ id: orderId }), {
      fetchImpl,
      timeoutMs: 20,
    })

    assert.equal(timedList.status, 503)
    assert.equal(timedDetail.status, 503)
    hidden(timedList.body)
    hidden(timedDetail.body)
    assert.equal(timeouts, 2)
  })

  it('keeps two parallel list reads on their own sessions', async () => {
    const sessions = ['A', 'B'].map((label) => {
      const id = randomBytes(32).toString('base64url')
      const token = `access-token-${label}`
      const refresh = `refresh-token-${label}`
      const email = `customer-${label}@example.com`
      const orderNumber = `ORDER-${label}`
      return {
        id,
        token,
        refresh,
        email,
        orderNumber,
        hash: sha256Hex(id),
        calls: [],
      }
    })
    let inspectsStarted = 0
    let releaseInspects
    const bothInspectsStarted = new Promise((resolve) => {
      releaseInspects = resolve
    })

    function transport(session) {
      return async (url, options) => {
        const target = String(url)
        session.calls.push({
          url: target,
          authorization: options.headers?.authorization,
          body: options.body,
        })

        if (target.endsWith('/internal/account-sessions/inspect')) {
          inspectsStarted += 1
          if (inspectsStarted === sessions.length) {
            releaseInspects()
          }
          await bothInspectsStarted
          const parsed = JSON.parse(options.body)
          assert.equal(parsed.sessionHash, session.hash)
          return Response.json({
            status: 'ready',
            userId: randomUUID(),
            accessToken: session.token,
            refreshToken: session.refresh,
            keyVersion: 1,
          })
        }

        assert.equal(options.headers.authorization, `Bearer ${session.token}`)
        assert.equal(options.body, undefined)
        return Response.json({
          data: [
            {
              id: orderId,
              orderNumber: session.orderNumber,
              customer: { email: session.email },
            },
          ],
          meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
        })
      }
    }

    const [first, second] = await Promise.all(
      sessions.map((session) =>
        loadAdminOrderList(
          eventFor({ cookie: `${cookieName}=${session.id}` }),
          { fetchImpl: transport(session) },
        ),
      ),
    )
    const results = [first, second]

    assert.equal(inspectsStarted, 2)
    for (const [index, session] of sessions.entries()) {
      const other = sessions[1 - index]
      const result = results[index]
      const visible = JSON.stringify(result)

      assert.equal(result.status, 200)
      assert.equal(result.body.data[0].orderNumber, session.orderNumber)
      assert.equal(result.body.data[0].customer.email, session.email)
      assert.equal(visible.includes(other.orderNumber), false)
      assert.equal(visible.includes(other.email), false)
      assert.equal(visible.includes(session.token), false)
      assert.equal(visible.includes(session.refresh), false)
      assert.equal(visible.includes(other.token), false)
      assert.equal(visible.includes(other.refresh), false)
      assert.equal(visible.includes(session.id), false)
      assert.equal(visible.includes(other.id), false)
      assert.equal(visible.includes(session.hash), false)
      assert.equal(visible.includes(other.hash), false)
      assert.equal(visible.includes(secret), false)
      assert.equal(session.calls.length, 2)
      assert.equal(session.calls[1].authorization, `Bearer ${session.token}`)
    }
  })
})
