import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  AccountSessionInspectError,
  inspectAccountSession,
} from '../src/account-session/inspect-account-session.js'
import { sha256Hex } from '../src/account-session/repository.js'
import { encryptToken } from '../src/account-session/token-cipher.js'

const key = randomBytes(32)
const sessionHash = sha256Hex('session-id')
const userId = randomUUID()
const accessToken = 'access-token-value'
const refreshToken = 'refresh-token-value'

function sealed(value, version = 1) {
  const token = encryptToken(value, key, { version })
  return token
}

function row(overrides = {}) {
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

function database(result, { fail = false } = {}) {
  const calls = []

  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params })

      if (fail) {
        throw new Error(`database ${accessToken} ${sessionHash}`)
      }

      return { rows: result ? [result] : [] }
    },
  }
}

function hidden(value) {
  const visible = JSON.stringify(value)

  for (const secret of [accessToken, refreshToken, sessionHash, userId]) {
    assert.equal(visible.includes(secret), false)
  }
}

describe('inspectAccountSession', () => {
  it('rejects a malformed hash and a bad key before querying', async () => {
    const store = database(row())

    await assert.rejects(
      () =>
        inspectAccountSession({
          database: store,
          sessionHash: sessionHash.toUpperCase(),
          key,
        }),
      (error) =>
        error instanceof AccountSessionInspectError &&
        error.code === 'rejected',
    )
    await assert.rejects(
      () =>
        inspectAccountSession({
          database: store,
          sessionHash,
          key: null,
        }),
      (error) =>
        error instanceof AccountSessionInspectError &&
        error.code === 'rejected',
    )

    assert.equal(store.calls.length, 0)
  })

  it('returns not_found when PostgreSQL has no row', async () => {
    const store = database(null)
    const result = await inspectAccountSession({
      database: store,
      sessionHash,
      key,
    })

    assert.deepEqual(result, { status: 'not_found' })
    assert.equal(store.calls.length, 1)
    assert.equal(store.calls[0].params[0], sessionHash)
    hidden(result)
  })

  it('classifies expiry from PostgreSQL flags without decrypting', async () => {
    const idle = database(
      row({ idle_valid: false, access_tag: randomBytes(16) }),
    )
    const absolute = database(
      row({ absolute_valid: false, access_tag: randomBytes(16) }),
    )
    const idleResult = await inspectAccountSession({
      database: idle,
      sessionHash,
      key,
    })
    const absoluteResult = await inspectAccountSession({
      database: absolute,
      sessionHash,
      key,
    })

    assert.deepEqual(idleResult, { status: 'expired' })
    assert.deepEqual(absoluteResult, { status: 'expired' })
    hidden(idleResult)
    hidden(absoluteResult)
  })

  it('returns decrypted tokens only for a valid ready session', async () => {
    const store = database(row())
    const result = await inspectAccountSession({
      database: store,
      sessionHash,
      key,
    })

    assert.deepEqual(result, {
      status: 'ready',
      userId,
      accessToken,
      refreshToken,
      keyVersion: 1,
    })
    assert.match(store.calls[0].sql, /now\(\)/)
    assert.equal(store.calls[0].sql.includes('update'), false)
  })

  it('classifies pending ages without decrypting', async () => {
    const young = database(
      row({
        refresh_state: 'pending',
        pending_fresh: true,
        access_tag: randomBytes(16),
      }),
    )
    const stale = database(
      row({
        refresh_state: 'pending',
        pending_fresh: false,
        access_tag: randomBytes(16),
      }),
    )
    const youngResult = await inspectAccountSession({
      database: young,
      sessionHash,
      key,
    })
    const staleResult = await inspectAccountSession({
      database: stale,
      sessionHash,
      key,
    })

    const future = database(
      row({
        refresh_state: 'pending',
        pending_fresh: null,
        access_tag: randomBytes(16),
      }),
    )
    const futureResult = await inspectAccountSession({
      database: future,
      sessionHash,
      key,
    })

    assert.deepEqual(youngResult, { status: 'pending' })
    assert.deepEqual(staleResult, { status: 'stale_pending' })
    assert.deepEqual(futureResult, { status: 'invalid' })
    hidden(futureResult)
    hidden(youngResult)
    hidden(staleResult)
  })

  it('classifies unknown and inconsistent rows without tokens', async () => {
    const unknown = database(
      row({
        refresh_state: 'unknown',
        access_ciphertext: null,
        access_nonce: null,
        access_tag: null,
        refresh_ciphertext: null,
        refresh_nonce: null,
        refresh_tag: null,
      }),
    )
    const other = database(row({ refresh_state: 'closed' }))
    const incomplete = database(row({ refresh_ciphertext: null }))
    const broken = database(row({ access_tag: randomBytes(16) }))
    const wrongKey = database(row())
    const unknownResult = await inspectAccountSession({
      database: unknown,
      sessionHash,
      key,
    })
    const otherResult = await inspectAccountSession({
      database: other,
      sessionHash,
      key,
    })
    const incompleteResult = await inspectAccountSession({
      database: incomplete,
      sessionHash,
      key,
    })
    const brokenResult = await inspectAccountSession({
      database: broken,
      sessionHash,
      key,
    })
    const wrongKeyResult = await inspectAccountSession({
      database: wrongKey,
      sessionHash,
      key: randomBytes(32),
    })

    for (const result of [
      unknownResult,
      otherResult,
      incompleteResult,
      brokenResult,
      wrongKeyResult,
    ]) {
      assert.equal(result.status === 'ready', false)
      hidden(result)
    }

    assert.equal(unknownResult.status, 'unknown')
    assert.equal(otherResult.status, 'invalid')
    assert.equal(incompleteResult.status, 'invalid')
    assert.equal(brokenResult.status, 'invalid')
    assert.equal(wrongKeyResult.status, 'invalid')
  })

  it('hides a database failure', async () => {
    const store = database(null, { fail: true })

    await assert.rejects(
      () => inspectAccountSession({ database: store, sessionHash, key }),
      (error) => {
        assert.ok(error instanceof AccountSessionInspectError)
        assert.equal(error.code, 'unavailable')
        assert.equal(String(error).includes(accessToken), false)
        assert.equal(String(error).includes(sessionHash), false)
        return true
      },
    )
  })
})
