import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AccountSessionWriteError,
  extendAccountSessionIdleExpiry,
  sha256Hex,
} from '../src/account-session/repository.js'

const idHash = sha256Hex('session-id')

function database(rowCount = 1) {
  const calls = []

  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params })
      return { rowCount }
    },
  }
}

describe('extendAccountSessionIdleExpiry', () => {
  it('rejects a malformed hash before querying', async () => {
    const store = database()

    await assert.rejects(
      () =>
        extendAccountSessionIdleExpiry(store, {
          idHash: idHash.toUpperCase(),
        }),
      (error) =>
        error instanceof AccountSessionWriteError && error.code === 'rejected',
    )
    assert.equal(store.calls.length, 0)
  })

  it('returns the updated row count for one conditional update', async () => {
    const store = database(1)
    const updated = await extendAccountSessionIdleExpiry(store, { idHash })

    assert.equal(updated, 1)
    assert.equal(store.calls.length, 1)
    assert.equal(store.calls[0].params[0], idHash)
    assert.match(store.calls[0].sql, /greatest\(/i)
    assert.match(store.calls[0].sql, /least\(now\(\) \+ interval '30 minutes'/i)
    assert.match(store.calls[0].sql, /refresh_state = 'ready'/i)
    assert.equal(/\bselect\b/i.test(store.calls[0].sql), false)
  })

  it('returns zero when no session matches and hides a database failure', async () => {
    const missed = database(0)
    const failed = {
      async query() {
        throw new Error(`database ${idHash}`)
      },
    }

    assert.equal(await extendAccountSessionIdleExpiry(missed, { idHash }), 0)
    await assert.rejects(
      () => extendAccountSessionIdleExpiry(failed, { idHash }),
      (error) => {
        assert.ok(error instanceof AccountSessionWriteError)
        assert.equal(error.code, 'unavailable')
        assert.equal(String(error).includes(idHash), false)
        return true
      },
    )
  })
})
