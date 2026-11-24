import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  RefreshAuthError,
  refreshSupabaseSession,
} from '../src/auth/supabase-refresh.js'

const supabaseUrl = 'http://127.0.0.1:54321'
const anonKey = 'anon-key'
const refreshToken = 'refresh-token-value'
const accessToken = 'access-token-value'
const nextRefresh = 'next-refresh-token'
const userId = randomUUID()

describe('refreshSupabaseSession', () => {
  it('posts the refresh grant and returns the new pair', async () => {
    const calls = []
    const result = await refreshSupabaseSession({
      supabaseUrl,
      anonKey,
      refreshToken,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init })
        return {
          status: 200,
          async json() {
            return {
              access_token: accessToken,
              refresh_token: nextRefresh,
              expires_at: 1_700_000_000,
              user: { id: userId },
            }
          },
        }
      },
    })

    assert.deepEqual(result, {
      accessToken,
      refreshToken: nextRefresh,
      expiresAt: 1_700_000_000,
      userId,
    })
    assert.equal(
      calls[0].url,
      `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
    )
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      refresh_token: refreshToken,
    })
    assert.equal(
      JSON.stringify(calls[0].init.headers).includes(refreshToken),
      false,
    )
  })

  it('maps a definite rejection without retry', async () => {
    let calls = 0
    await assert.rejects(
      () =>
        refreshSupabaseSession({
          supabaseUrl,
          anonKey,
          refreshToken,
          fetchImpl: async () => {
            calls += 1
            return {
              status: 400,
              async json() {
                return { error_code: 'invalid_grant' }
              },
            }
          },
        }),
      (error) => error instanceof RefreshAuthError && error.code === 'rejected',
    )
    assert.equal(calls, 1)
  })

  it('maps timeouts and 5xx as unavailable', async () => {
    await assert.rejects(
      () =>
        refreshSupabaseSession({
          supabaseUrl,
          anonKey,
          refreshToken,
          timeoutMs: 1,
          fetchImpl: async (_url, init) => {
            await new Promise((resolve) => setTimeout(resolve, 20))
            if (init.signal?.aborted) {
              const error = new Error('aborted')
              error.name = 'AbortError'
              throw error
            }
            return {
              status: 200,
              async json() {
                return {}
              },
            }
          },
        }),
      (error) => error instanceof RefreshAuthError && error.code === 'timeout',
    )

    await assert.rejects(
      () =>
        refreshSupabaseSession({
          supabaseUrl,
          anonKey,
          refreshToken,
          fetchImpl: async () => ({
            status: 503,
            async json() {
              return {}
            },
          }),
        }),
      (error) =>
        error instanceof RefreshAuthError && error.code === 'unavailable',
    )
  })
})
