import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { RefreshAuthError } from '../src/auth/supabase-refresh.js'
import { refreshAccountSession } from '../src/account-session/refresh-account-session.js'
import { sha256Hex } from '../src/account-session/repository.js'
import { encryptToken } from '../src/account-session/token-cipher.js'
import { expiredAccessToken, futureAccessToken } from './helpers/test-jwt.js'

const key = randomBytes(32)
const rateLimitKey = randomBytes(32)
const sessionHash = sha256Hex('session-cookie-value')
const userId = randomUUID()
const oldRefresh = 'old-refresh-token-value'
const newAccess = futureAccessToken(3600, { sub: userId })
const newRefresh = 'new-refresh-token-value'
const csrfHash = sha256Hex('csrf-secret-value')

function createStore(initial = {}) {
  const state = {
    refresh_state: 'ready',
    refresh_generation: null,
    refresh_started_at: null,
    refresh_token_hash: null,
    csrf_token_hash: csrfHash,
    key_version: 1,
    user_id: userId,
    absolute_expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000),
    idle_expires_at: new Date(Date.now() + 30 * 60 * 1000),
    access: encryptToken(expiredAccessToken(120, { sub: userId }), key),
    refresh: encryptToken(oldRefresh, key),
    inserts: 0,
    ...initial,
  }
  const calls = []
  const authAttempts = []

  return {
    state,
    calls,
    authAttempts,
    async query(sql, params) {
      calls.push({ sql, params })

      if (sql.includes('insert into public.auth_attempt_counters')) {
        authAttempts.push(params)
        const allowed = state.rateAllowed !== false
        if (!allowed) {
          return { rows: [] }
        }
        return {
          rows: [{ count: 1, window_start: new Date() }],
        }
      }

      if (
        sql.includes('select count, window_start') &&
        sql.includes('auth_attempt_counters')
      ) {
        return {
          rows: [{ count: 30, window_start: new Date() }],
        }
      }

      if (
        sql.includes("refresh_state = 'pending'") &&
        sql.includes('refresh_started_at = now()') &&
        sql.includes("refresh_state = 'ready'")
      ) {
        if (
          state.refresh_state !== 'ready' ||
          state.absolute_expires_at <= new Date() ||
          state.idle_expires_at <= new Date()
        ) {
          return { rows: [] }
        }

        state.refresh_state = 'pending'
        state.refresh_generation = params[1]
        state.refresh_started_at = state.forceStartedAt ?? new Date()
        state.refresh_token_hash = params[2]
        return {
          rows: [
            {
              csrf_token_hash: state.csrf_token_hash,
              key_version: state.key_version,
              user_id: state.user_id,
            },
          ],
        }
      }

      if (
        sql.includes("refresh_state = 'ready'") &&
        sql.includes('refresh_generation = null') &&
        sql.includes('access_ciphertext = $4')
      ) {
        const generation = params[1]
        const started = state.refresh_started_at
        const fresh =
          started instanceof Date &&
          started > new Date(Date.now() - 15_000) &&
          started <= new Date()

        if (
          state.refresh_state !== 'pending' ||
          state.refresh_generation !== generation ||
          !fresh ||
          state.absolute_expires_at <= new Date() ||
          state.idle_expires_at <= new Date()
        ) {
          return { rowCount: 0 }
        }

        state.refresh_state = 'ready'
        state.refresh_generation = null
        state.refresh_started_at = null
        state.refresh_token_hash = null
        state.access = {
          ciphertext: params[3],
          nonce: params[4],
          tag: params[5],
          version: params[2],
        }
        state.refresh = {
          ciphertext: params[6],
          nonce: params[7],
          tag: params[8],
        }
        return { rowCount: 1 }
      }

      if (sql.includes("refresh_state = 'unknown'")) {
        if (sql.includes('refresh_generation = $2')) {
          if (
            state.refresh_state !== 'pending' ||
            state.refresh_generation !== params[1]
          ) {
            return { rowCount: 0 }
          }
        } else if (state.refresh_state !== 'pending') {
          return { rowCount: 0 }
        }

        state.refresh_state = 'unknown'
        state.refresh_generation = null
        state.refresh_started_at = null
        state.refresh_token_hash = null
        state.access = null
        state.refresh = null
        return { rowCount: 1 }
      }

      if (sql.includes('delete from public.account_sessions')) {
        if (state.deleted) {
          return { rowCount: 0 }
        }
        state.deleted = true
        state.refresh_state = null
        return { rowCount: 1 }
      }

      if (
        sql.includes('idle_expires_at = greatest') &&
        sql.includes("refresh_state = 'ready'")
      ) {
        if (state.refresh_state !== 'ready') {
          return { rowCount: 0 }
        }
        const next = new Date(
          Math.min(
            Date.now() + 30 * 60 * 1000,
            state.absolute_expires_at.getTime(),
          ),
        )
        const previous = state.idle_expires_at.getTime()
        state.idle_expires_at = new Date(Math.max(previous, next.getTime()))
        state.idleExtended = true
        return { rowCount: 1 }
      }

      if (
        sql.includes('from public.account_sessions') &&
        sql.includes('select')
      ) {
        if (state.deleted || state.refresh_state == null) {
          return { rows: [] }
        }

        const pendingFresh =
          state.refresh_state === 'pending' && state.refresh_started_at
            ? state.refresh_started_at > new Date()
              ? null
              : state.refresh_started_at > new Date(Date.now() - 15_000)
            : null

        return {
          rows: [
            {
              user_id: state.user_id,
              refresh_state: state.refresh_state,
              key_version: state.key_version,
              access_ciphertext: state.access?.ciphertext ?? null,
              access_nonce: state.access?.nonce ?? null,
              access_tag: state.access?.tag ?? null,
              refresh_ciphertext: state.refresh?.ciphertext ?? null,
              refresh_nonce: state.refresh?.nonce ?? null,
              refresh_tag: state.refresh?.tag ?? null,
              absolute_valid: state.absolute_expires_at > new Date(),
              idle_valid: state.idle_expires_at > new Date(),
              pending_fresh: pendingFresh,
            },
          ],
        }
      }

      if (sql.includes('insert into public.account_sessions')) {
        state.inserts += 1
        return { rowCount: 1 }
      }

      throw new Error(`unexpected sql ${sql.slice(0, 80)}`)
    },
  }
}

async function run(store, overrides = {}, dependencies = {}) {
  return refreshAccountSession(
    {
      database: store,
      sessionHash,
      key,
      rateLimitKey,
      supabaseUrl: 'http://127.0.0.1:54321',
      anonKey: 'anon-key',
      userId,
      accessToken: expiredAccessToken(120, { sub: userId }),
      refreshToken: oldRefresh,
      keyVersion: 1,
      ...overrides,
    },
    dependencies,
  )
}

describe('refreshAccountSession', () => {
  it('refreshes a ready session and extends idle without touching absolute expiry', async () => {
    const store = createStore()
    const absoluteBefore = store.state.absolute_expires_at.getTime()
    const result = await run(
      store,
      {},
      {
        refreshAuth: async () => ({
          accessToken: newAccess,
          refreshToken: newRefresh,
          userId,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }),
        revokeSession: async () => {
          throw new Error('revoke should not run')
        },
      },
    )

    assert.equal(result.status, 'ready')
    assert.equal(result.accessToken, newAccess)
    assert.equal(result.refreshToken, newRefresh)
    assert.equal(store.state.refresh_state, 'ready')
    assert.equal(store.state.inserts, 0)
    assert.equal(store.state.idleExtended, true)
    assert.equal(store.state.absolute_expires_at.getTime(), absoluteBefore)
    assert.equal(JSON.stringify(result).includes(oldRefresh), false)
  })

  it('returns expired without refresh when absolute lifetime already ended', async () => {
    const store = createStore({
      absolute_expires_at: new Date(Date.now() - 1000),
    })
    let authCalls = 0
    const result = await run(
      store,
      {},
      {
        refreshAuth: async () => {
          authCalls += 1
          return {
            accessToken: newAccess,
            refreshToken: newRefresh,
            userId,
          }
        },
      },
    )

    assert.equal(result.status, 'expired')
    assert.equal(authCalls, 0)
    assert.equal(store.state.refresh_state, 'ready')
  })

  it('returns pending for a young parallel refresh without calling Supabase', async () => {
    const store = createStore({
      refresh_state: 'pending',
      refresh_generation: randomUUID(),
      refresh_started_at: new Date(),
      refresh_token_hash: sha256Hex(oldRefresh),
    })
    let authCalls = 0
    const result = await run(
      store,
      {},
      {
        refreshAuth: async () => {
          authCalls += 1
          throw new Error('should not call auth')
        },
      },
    )

    assert.equal(result.status, 'pending')
    assert.equal(authCalls, 0)
    assert.equal(store.state.idleExtended, undefined)
    assert.equal(store.state.refresh_state, 'pending')
  })

  it('marks stale pending as unknown and returns without calling Supabase', async () => {
    const store = createStore({
      refresh_state: 'pending',
      refresh_generation: randomUUID(),
      refresh_started_at: new Date(Date.now() - 20_000),
      refresh_token_hash: sha256Hex(oldRefresh),
    })
    let authCalls = 0
    const result = await run(
      store,
      {},
      {
        refreshAuth: async () => {
          authCalls += 1
          throw new Error('should not call auth')
        },
      },
    )

    assert.equal(result.status, 'stale_pending')
    assert.equal(authCalls, 0)
    assert.equal(store.state.refresh_state, 'unknown')
    assert.equal(store.state.access, null)
    assert.equal(store.state.idleExtended, undefined)
  })

  it('deletes the session after a definite Supabase rejection', async () => {
    const store = createStore()
    const result = await run(
      store,
      {},
      {
        refreshAuth: async () => {
          throw new RefreshAuthError('rejected')
        },
      },
    )

    assert.equal(result.status, 'expired')
    assert.equal(store.state.deleted, true)
    assert.equal(JSON.stringify(result).includes(oldRefresh), false)
  })

  it('marks unknown after a Supabase timeout without retry', async () => {
    const store = createStore()
    let authCalls = 0
    const result = await run(
      store,
      {},
      {
        refreshAuth: async () => {
          authCalls += 1
          throw new RefreshAuthError('timeout')
        },
      },
    )

    assert.equal(result.status, 'unknown')
    assert.equal(authCalls, 1)
    assert.equal(store.state.refresh_state, 'unknown')
    assert.equal(store.state.access, null)
    assert.equal(store.state.idleExtended, undefined)
  })

  it('marks unknown after Supabase 5xx without retry', async () => {
    const store = createStore()
    let authCalls = 0
    const result = await run(
      store,
      {},
      {
        refreshAuth: async () => {
          authCalls += 1
          throw new RefreshAuthError('unavailable')
        },
      },
    )

    assert.equal(result.status, 'unknown')
    assert.equal(authCalls, 1)
    assert.equal(store.state.refresh_state, 'unknown')
  })

  it('rejects a late pair after fifteen seconds and clears tokens', async () => {
    const store = createStore()
    const result = await run(
      store,
      {},
      {
        refreshAuth: async () => {
          store.state.forceStartedAt = new Date(Date.now() - 20_000)
          store.state.refresh_started_at = store.state.forceStartedAt
          return {
            accessToken: newAccess,
            refreshToken: newRefresh,
            userId,
          }
        },
        revokeSession: async () => ({ outcome: 'revoked' }),
      },
    )

    assert.equal(result.status, 'unknown')
    assert.equal(store.state.refresh_state, 'unknown')
    assert.equal(store.state.access, null)
    assert.equal(store.state.inserts, 0)
  })

  it('saves only when the generation still matches', async () => {
    const store = createStore()
    const generation = randomUUID()
    const result = await run(
      store,
      {},
      {
        createGeneration: () => generation,
        refreshAuth: async () => {
          store.state.refresh_generation = randomUUID()
          return {
            accessToken: newAccess,
            refreshToken: newRefresh,
            userId,
          }
        },
        revokeSession: async () => ({ outcome: 'revoked' }),
      },
    )

    assert.equal(result.status, 'unknown')
    assert.equal(store.state.inserts, 0)
  })

  it('keeps one Supabase call across two parallel refreshes', async () => {
    const store = createStore()
    let releaseAuth = () => {}
    const authGate = new Promise((resolve) => {
      releaseAuth = resolve
    })
    let authCalls = 0
    const dependencies = {
      refreshAuth: async () => {
        authCalls += 1
        await authGate
        return {
          accessToken: newAccess,
          refreshToken: newRefresh,
          userId,
        }
      },
      revokeSession: async () => ({ outcome: 'revoked' }),
    }

    const firstPromise = run(store, {}, dependencies)
    await waitFor(() => store.state.refresh_state === 'pending')

    const second = await run(store, {}, dependencies)
    assert.equal(second.status, 'pending')
    assert.equal(authCalls, 1)

    releaseAuth()
    const first = await firstPromise
    assert.equal(first.status, 'ready')
    assert.equal(authCalls, 1)
    assert.equal(store.state.inserts, 0)
  })

  it('never inserts a session row during refresh', async () => {
    const store = createStore()
    const result = await run(
      store,
      {},
      {
        refreshAuth: async () => ({
          accessToken: newAccess,
          refreshToken: newRefresh,
          userId,
        }),
      },
    )
    assert.equal(result.status, 'ready')
    assert.equal(store.state.inserts, 0)
    assert.equal(
      store.calls.some((call) =>
        call.sql.includes('insert into public.account_sessions'),
      ),
      false,
    )
  })

  it('does not extend idle after a failed refresh', async () => {
    const store = createStore()
    const idleBefore = store.state.idle_expires_at.getTime()
    await run(
      store,
      {},
      {
        refreshAuth: async () => {
          throw new RefreshAuthError('timeout')
        },
      },
    )
    assert.equal(store.state.idle_expires_at.getTime(), idleBefore)
    assert.equal(store.state.idleExtended, undefined)
  })

  it('returns rate_limited without calling Supabase or changing the row', async () => {
    const store = createStore({ rateAllowed: false })
    let authCalls = 0
    const result = await run(
      store,
      {},
      {
        refreshAuth: async () => {
          authCalls += 1
          throw new Error('no')
        },
      },
    )

    assert.equal(result.status, 'rate_limited')
    assert.equal(authCalls, 0)
    assert.equal(store.state.refresh_state, 'ready')
  })

  it('keeps tokens out of failure payloads', async () => {
    const store = createStore()
    const result = await run(
      store,
      {},
      {
        refreshAuth: async () => {
          throw new RefreshAuthError('timeout')
        },
      },
    )
    const visible = JSON.stringify(result)
    assert.equal(visible.includes(oldRefresh), false)
    assert.equal(visible.includes(newAccess), false)
    assert.equal(visible.includes(sessionHash), false)
  })
})

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  throw new Error('condition was not met')
}
