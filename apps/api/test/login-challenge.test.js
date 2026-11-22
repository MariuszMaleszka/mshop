import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  AccountSessionWriteError,
  createLoginChallenge,
  createLoginChallengeValue,
  sha256Hex,
} from '../src/account-session/repository.js'

describe('createLoginChallengeValue', () => {
  it('encodes 32 random bytes as canonical base64url', () => {
    const bytes = Buffer.alloc(32, 7)
    const value = createLoginChallengeValue(() => bytes)

    assert.equal(value, bytes.toString('base64url'))
    assert.equal(Buffer.from(value, 'base64url').equals(bytes), true)
    assert.equal(value.includes('='), false)
    assert.equal(value.includes('+'), false)
    assert.equal(value.includes('/'), false)
    assert.match(value, /^[A-Za-z0-9_-]{43}$/)
  })

  it('uses the crypto generator and rejects a short result', () => {
    const value = createLoginChallengeValue()

    assert.equal(Buffer.from(value, 'base64url').length, 32)
    assert.throws(
      () => createLoginChallengeValue(() => randomBytes(16)),
      (error) => {
        assert.equal(error instanceof AccountSessionWriteError, true)
        assert.equal(error.code, 'rejected')
        assert.equal(error.message, 'Account session write rejected')
        return true
      },
    )
  })
})

describe('createLoginChallenge', () => {
  it('stores only hashes and ignores an application expiry', async () => {
    const challengeId = createLoginChallengeValue()
    const csrfSecret = createLoginChallengeValue()
    const calls = []
    const database = {
      async query(sql, params) {
        calls.push({ sql, params })
        return { rowCount: 1 }
      },
    }

    const result = await createLoginChallenge(database, {
      challengeId,
      csrfSecret,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    })

    assert.equal(result, undefined)
    assert.equal(calls.length, 1)
    assert.match(calls[0].sql, /now\(\) \+ interval '10 minutes'/)
    assert.deepEqual(calls[0].params, [
      sha256Hex(challengeId),
      sha256Hex(csrfSecret),
    ])
    assert.equal(calls[0].sql.includes(challengeId), false)
    assert.equal(calls[0].sql.includes(csrfSecret), false)
    assert.equal(calls[0].params.includes(challengeId), false)
    assert.equal(calls[0].params.includes(csrfSecret), false)
  })

  it('rejects a value that is not a canonical 32-byte token', async () => {
    const valid = createLoginChallengeValue()
    let called = false
    const database = {
      async query() {
        called = true
        return { rowCount: 1 }
      },
    }

    for (const challengeId of [
      valid.slice(0, 42),
      `${valid}=`,
      `${valid.slice(0, 42)}+`,
      '',
      null,
    ]) {
      await assert.rejects(
        createLoginChallenge(database, { challengeId, csrfSecret: valid }),
        (error) => {
          assert.equal(error instanceof AccountSessionWriteError, true)
          assert.equal(error.code, 'rejected')
          assert.equal(error.message, 'Account session write rejected')
          if (typeof challengeId === 'string' && challengeId.length > 0) {
            assert.equal(String(error).includes(challengeId), false)
          }
          return true
        },
      )
    }

    assert.equal(called, false)
  })

  it('hides a database failure and the submitted values', async () => {
    const challengeId = createLoginChallengeValue()
    const csrfSecret = createLoginChallengeValue()
    const database = {
      async query() {
        throw new Error(`duplicate ${challengeId} ${csrfSecret}`)
      },
    }

    await assert.rejects(
      createLoginChallenge(database, { challengeId, csrfSecret }),
      (error) => {
        assert.equal(error instanceof AccountSessionWriteError, true)
        assert.equal(error.code, 'unavailable')
        assert.equal(error.message, 'Account session write rejected')
        assert.equal(String(error).includes(challengeId), false)
        assert.equal(String(error).includes(csrfSecret), false)
        assert.equal(error.cause, undefined)
        return true
      },
    )
  })
})
