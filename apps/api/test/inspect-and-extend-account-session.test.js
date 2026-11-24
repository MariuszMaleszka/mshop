import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { inspectAndExtendAccountSession } from '../src/account-session/inspect-and-extend-account-session.js'
import { AccountSessionInspectError } from '../src/account-session/inspect-account-session.js'
import { sha256Hex } from '../src/account-session/repository.js'
import { encryptToken } from '../src/account-session/token-cipher.js'

const key = randomBytes(32)
const sessionHash = sha256Hex('session-id')
const userId = randomUUID()
const accessToken = 'access-token-value'
const refreshToken = 'refresh-token-value'

function sealed(value) {
  return encryptToken(value, key)
}

function readyRow(overrides = {}) {
  const access = sealed(accessToken)
  const refresh = sealed(refreshToken)

  return {
    user_id: userId,
    refresh_state: 'ready',
    key_version: 1,
    access_ciphertext: access.ciphertext,
    access_nonce: access.nonce,
    access_tag: access.tag,
    refresh_ciphertext: refresh.ciphertext,
    refresh_nonce: refresh.nonce,
    refresh_tag: refresh.tag,
    absolute_valid: true,
    idle_valid: true,
    pending_fresh: null,
    ...overrides,
  }
}

function database({ row = null, rowCount = 1, fail = null } = {}) {
  const calls = []

  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params })
      const update = sql.includes('update public.account_sessions')

      if (fail === 'read' && !update) {
        throw new Error(`read ${accessToken} ${sessionHash}`)
      }

      if (fail === 'extend' && update) {
        throw new Error(`extend ${accessToken} ${sessionHash}`)
      }

      if (update) {
        return { rowCount }
      }

      return { rows: row ? [row] : [] }
    },
  }
}

async function run(store) {
  return inspectAndExtendAccountSession({
    database: store,
    sessionHash,
    key,
  })
}

function updates(store) {
  return store.calls.filter((call) => call.sql.includes('update '))
}

describe('inspectAndExtendAccountSession', () => {
  it('returns the ready session only after the idle update matches one row', async () => {
    const store = database({ row: readyRow(), rowCount: 1 })
    const result = await run(store)

    assert.deepEqual(result, {
      status: 'ready',
      userId,
      accessToken,
      refreshToken,
      keyVersion: 1,
    })
    assert.equal(store.calls.length, 2)
    assert.equal(store.calls[0].params[0], sessionHash)
    assert.equal(updates(store).length, 1)
    assert.equal(updates(store)[0].params[0], sessionHash)
    assert.equal(store.calls[0].sql.includes(accessToken), false)
  })

  it('does not extend a session that is not ready', async () => {
    const cases = [
      [null, 'not_found'],
      [readyRow({ idle_valid: false }), 'expired'],
      [readyRow({ refresh_state: 'pending', pending_fresh: true }), 'pending'],
      [
        readyRow({ refresh_state: 'pending', pending_fresh: false }),
        'stale_pending',
      ],
      [readyRow({ refresh_state: 'unknown' }), 'unknown'],
      [readyRow({ refresh_state: 'closed' }), 'invalid'],
    ]

    for (const [row, status] of cases) {
      const store = database({ row })
      const result = await run(store)

      assert.equal(result.status, status)
      assert.equal(updates(store).length, 0)
      assert.equal(store.calls.length, 1)
      assert.equal(store.calls[0].params[0], sessionHash)
      assert.equal(JSON.stringify(result).includes(accessToken), false)
    }
  })

  it('drops decrypted tokens when the update matches nothing', async () => {
    const store = database({ row: readyRow(), rowCount: 0 })
    const result = await run(store)

    assert.deepEqual(result, { status: 'unavailable' })
    assert.equal(updates(store).length, 1)
    assert.equal(JSON.stringify(result).includes(accessToken), false)
    assert.equal(JSON.stringify(result).includes(refreshToken), false)
    assert.equal(JSON.stringify(result).includes(sessionHash), false)
  })

  it('does not extend when inspection fails and hides an extension failure', async () => {
    const read = database({ fail: 'read' })
    const extend = database({ row: readyRow(), fail: 'extend' })

    await assert.rejects(
      () => run(read),
      (error) => {
        assert.ok(error instanceof AccountSessionInspectError)
        assert.equal(error.code, 'unavailable')
        assert.equal(String(error).includes(accessToken), false)
        assert.equal(updates(read).length, 0)
        return true
      },
    )
    await assert.rejects(
      () => run(extend),
      (error) => {
        assert.ok(error instanceof AccountSessionInspectError)
        assert.equal(error.code, 'unavailable')
        assert.equal(String(error).includes(accessToken), false)
        assert.equal(String(error).includes(sessionHash), false)
        assert.equal(updates(extend).length, 1)
        return true
      },
    )
  })
})
