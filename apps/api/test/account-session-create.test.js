import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  AccountSessionWriteError,
  createReadyAccountSession,
  isLoginChallengeValue,
  sha256Hex,
} from '../src/account-session/repository.js'
import { decryptToken } from '../src/account-session/token-cipher.js'

const key = randomBytes(32)
const userId = '11111111-1111-4111-8111-111111111111'
const accessToken = 'access-token-value'
const refreshToken = 'refresh-token-value'

function memoryDatabase({ failInsert = false } = {}) {
  const calls = []

  return {
    calls,
    async withTransaction(work) {
      calls.push('begin')

      try {
        const result = await work({
          async query(text, params) {
            calls.push({ text, params })

            if (failInsert && text.includes('insert into')) {
              throw Object.assign(new Error(`insert ${accessToken}`), {
                code: '23503',
              })
            }

            return { rowCount: text.includes('insert into') ? 1 : 0 }
          },
        })
        calls.push('commit')
        return result
      } catch (error) {
        calls.push('rollback')
        throw error
      }
    },
  }
}

describe('createReadyAccountSession', () => {
  it('returns two distinct canonical secrets and stores only hashes and ciphertext', async () => {
    const database = memoryDatabase()
    const created = await createReadyAccountSession(database, {
      userId,
      accessToken,
      refreshToken,
      key,
    })
    const insert = database.calls.find(
      (call) => call?.text?.includes('insert into'),
    )
    const stored = JSON.stringify(insert.params)

    assert.equal(isLoginChallengeValue(created.sessionId), true)
    assert.equal(isLoginChallengeValue(created.csrfSecret), true)
    assert.notEqual(created.sessionId, created.csrfSecret)
    assert.deepEqual(Object.keys(created).sort(), ['csrfSecret', 'sessionId'])
    assert.equal(insert.params[0], sha256Hex(created.sessionId))
    assert.equal(insert.params[9], sha256Hex(created.csrfSecret))
    assert.equal(insert.params[1], userId)
    assert.equal(insert.text.includes("'ready'"), true)
    assert.equal(insert.text.includes("interval '12 hours'"), true)
    assert.equal(insert.text.includes("interval '30 minutes'"), true)
    assert.equal(insert.text.includes('now()'), true)
    assert.equal(stored.includes(created.sessionId), false)
    assert.equal(stored.includes(created.csrfSecret), false)
    assert.equal(stored.includes(accessToken), false)
    assert.equal(stored.includes(refreshToken), false)
    assert.equal(
      decryptToken(
        {
          ciphertext: insert.params[3],
          nonce: insert.params[4],
          tag: insert.params[5],
          version: insert.params[2],
        },
        key,
      ),
      accessToken,
    )
    assert.equal(
      decryptToken(
        {
          ciphertext: insert.params[6],
          nonce: insert.params[7],
          tag: insert.params[8],
          version: insert.params[2],
        },
        key,
      ),
      refreshToken,
    )
    assert.equal(database.calls.at(-1), 'commit')
    assert.equal(
      database.calls.some((call) => call?.text?.includes('delete from')),
      false,
    )
  })

  it('does not write when the cipher key is missing or the previous hash is unchecked', async () => {
    const missingKey = memoryDatabase()
    const badPrevious = memoryDatabase()

    await assert.rejects(
      createReadyAccountSession(missingKey, {
        userId,
        accessToken,
        refreshToken,
        key: null,
      }),
      (error) => {
        assert.equal(error instanceof AccountSessionWriteError, true)
        assert.equal(error.code, 'rejected')
        assert.equal(String(error).includes(accessToken), false)
        assert.equal(String(error).includes(refreshToken), false)
        return true
      },
    )
    await assert.rejects(
      createReadyAccountSession(badPrevious, {
        userId,
        accessToken,
        refreshToken,
        key,
        previousSessionHash: sha256Hex(randomUUID()).toUpperCase(),
      }),
      (error) => error instanceof AccountSessionWriteError && error.code === 'rejected',
    )
    assert.deepEqual(missingKey.calls, [])
    assert.deepEqual(badPrevious.calls, [])
  })

  it('rolls back the previous-session delete when the new insert fails', async () => {
    const previousSessionHash = sha256Hex(randomUUID())
    const database = memoryDatabase({ failInsert: true })
    const error = await createReadyAccountSession(database, {
      userId,
      accessToken,
      refreshToken,
      key,
      previousSessionHash,
    }).catch((caught) => caught)
    const deleteCall = database.calls.find((call) =>
      call?.text?.includes('delete from'),
    )
    const insertAt = database.calls.findIndex((call) =>
      call?.text?.includes('insert into'),
    )
    const deleteAt = database.calls.indexOf(deleteCall)

    assert.equal(error instanceof AccountSessionWriteError, true)
    assert.equal(error.code, 'rejected')
    assert.equal(error.message, 'Account session write rejected')
    assert.equal(String(error).includes(accessToken), false)
    assert.equal(String(error).includes(refreshToken), false)
    assert.equal(error.cause, undefined)
    assert.deepEqual(deleteCall.params, [previousSessionHash])
    assert.ok(deleteAt < insertAt)
    assert.equal(database.calls.at(-1), 'rollback')
    assert.equal(database.calls.includes('commit'), false)
  })
})
