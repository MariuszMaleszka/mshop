import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  LOGOUT_TIMEOUT_MS,
  revokeSupabaseSession,
} from '../src/auth/supabase-logout.js'

const supabaseUrl = 'http://127.0.0.1:54321/'
const anonKey = 'anon-key-not-a-service-role'
const serviceRoleKey = 'service-role-key-must-stay-unused'
const accessToken = 'access-token-value'
const refreshToken = 'refresh-token-value'

function recorded(status, body = { msg: `logout ${accessToken}` }) {
  const calls = []

  return {
    calls,
    async fetch(url, options) {
      calls.push({ url, options })
      return {
        status,
        body: { async cancel() {} },
        async json() {
          return body
        },
      }
    },
  }
}

describe('revokeSupabaseSession', () => {
  it('revokes only the current session with the access token', async () => {
    const transport = recorded(204)
    const result = await revokeSupabaseSession({
      supabaseUrl,
      anonKey,
      accessToken,
      fetchImpl: transport.fetch,
    })
    const request = transport.calls[0]
    const headers = new Headers(request.options.headers)

    assert.deepEqual(result, { outcome: 'revoked' })
    assert.equal(transport.calls.length, 1)
    assert.equal(
      request.url,
      'http://127.0.0.1:54321/auth/v1/logout?scope=local',
    )
    assert.equal(request.options.method, 'POST')
    assert.equal(headers.get('apikey'), anonKey)
    assert.equal(headers.get('authorization'), `Bearer ${accessToken}`)
    assert.equal(JSON.stringify(request).includes(serviceRoleKey), false)
    assert.equal(JSON.stringify(request).includes(refreshToken), false)
    assert.equal(LOGOUT_TIMEOUT_MS, 8000)
  })

  it('treats an unauthorized logout as a confirmed rejection', async () => {
    const transport = recorded(401, { msg: accessToken })
    const result = await revokeSupabaseSession({
      supabaseUrl,
      anonKey,
      accessToken,
      fetchImpl: transport.fetch,
    })

    assert.deepEqual(result, { outcome: 'rejected' })
    assert.equal(JSON.stringify(result).includes(accessToken), false)
  })

  it('treats an HTTP 5xx response and a timeout as unknown', async () => {
    const unavailable = recorded(503, { msg: refreshToken })
    const timedOut = {
      calls: [],
      async fetch(_url, options) {
        this.calls.push('fetch')
        await new Promise((resolve) => {
          setTimeout(resolve, 40)
        })

        if (options.signal.aborted) {
          throw new DOMException(`timeout ${accessToken}`, 'TimeoutError')
        }

        return { status: 204, body: { async cancel() {} } }
      },
    }
    const failed = await revokeSupabaseSession({
      supabaseUrl,
      anonKey,
      accessToken,
      fetchImpl: unavailable.fetch,
    })
    const expired = await revokeSupabaseSession({
      supabaseUrl,
      anonKey,
      accessToken,
      fetchImpl: timedOut.fetch.bind(timedOut),
      timeoutMs: 20,
    })

    assert.deepEqual(failed, { outcome: 'unknown' })
    assert.deepEqual(expired, { outcome: 'unknown' })
    assert.equal(timedOut.calls.length, 1)
    assert.equal(JSON.stringify(failed).includes(refreshToken), false)
    assert.equal(JSON.stringify(expired).includes(accessToken), false)
  })

  it('does not call Auth when the logout configuration is missing', async () => {
    const transport = recorded(204)

    await assert.rejects(
      revokeSupabaseSession({
        supabaseUrl,
        anonKey,
        accessToken: '',
        fetchImpl: transport.fetch,
      }),
      (error) => {
        assert.equal(error.message, 'Supabase logout failed')
        assert.equal(String(error).includes(anonKey), false)
        return true
      },
    )
    assert.equal(transport.calls.length, 0)
  })
})
