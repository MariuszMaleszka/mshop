import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  LoginAttemptError,
  prepareLoginAttempt,
} from '../src/account-session/prepare-login-attempt.js'
import {
  createLoginChallengeValue,
  sha256Hex,
} from '../src/account-session/repository.js'

const key = randomBytes(32)
const clientIp = '203.0.113.10'
const email = 'Person@Example.com'
const challengeId = createLoginChallengeValue()
const csrfSecret = createLoginChallengeValue()

function attempt(overrides = {}, dependencies) {
  return prepareLoginAttempt(
    {
      database: { async query() {} },
      clientIp,
      challengeId,
      csrfSecret,
      email,
      key,
      ...overrides,
    },
    dependencies,
  )
}

function sequence(results) {
  const calls = []
  const handlers = {
    async consumeChallenge(_database, hashes) {
      calls.push(['challenge', hashes])
      return results.challenge ?? 1
    },
    async consumeIpLimit() {
      calls.push(['ip'])
      if (results.ipError) {
        throw results.ipError
      }
      return results.ip ?? { allowed: true }
    },
    async consumePairLimit() {
      calls.push(['pair'])
      if (results.pairError) {
        throw results.pairError
      }
      return results.pair ?? { allowed: true }
    },
  }

  return { calls, handlers }
}

async function failure(input, dependencies, code) {
  const error = await prepareLoginAttempt(input, dependencies).catch(
    (caught) => caught,
  )
  const visible = `${error.name} ${error.message} ${String(error)}`

  assert.equal(error instanceof LoginAttemptError, true)
  assert.equal(error.code, code)
  assert.equal(error.message, 'Login attempt rejected')
  assert.equal(error.cause, undefined)
  assert.equal(visible.includes(email), false)
  assert.equal(visible.includes(clientIp), false)
  assert.equal(visible.includes(challengeId), false)
  assert.equal(visible.includes(csrfSecret), false)
  assert.equal(visible.includes(sha256Hex(challengeId)), false)
  assert.equal(visible.includes(sha256Hex(csrfSecret)), false)
}

describe('prepareLoginAttempt', () => {
  it('consumes the challenge before either login limit', async () => {
    const flow = sequence({})
    const result = await attempt(
      {},
      {
        consumeChallenge: flow.handlers.consumeChallenge,
        consumeIpLimit: flow.handlers.consumeIpLimit,
        consumePairLimit: flow.handlers.consumePairLimit,
      },
    )

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(
      flow.calls.map((call) => call[0]),
      ['challenge', 'ip', 'pair'],
    )
    assert.deepEqual(flow.calls[0][1], {
      idHash: sha256Hex(challengeId),
      csrfTokenHash: sha256Hex(csrfSecret),
    })
  })

  it('stops before the limits when the challenge is not consumed', async () => {
    const flow = sequence({ challenge: 0 })

    await failure(
      {
        database: { async query() {} },
        clientIp,
        challengeId,
        csrfSecret,
        email,
        key,
      },
      {
        consumeChallenge: flow.handlers.consumeChallenge,
        consumeIpLimit: flow.handlers.consumeIpLimit,
        consumePairLimit: flow.handlers.consumePairLimit,
      },
      'invalid_challenge',
    )
    assert.deepEqual(
      flow.calls.map((call) => call[0]),
      ['challenge'],
    )
  })

  it('does not run the pair limit after the address limit rejects the attempt', async () => {
    const flow = sequence({ ip: { allowed: false } })

    await failure(
      {
        database: { async query() {} },
        clientIp,
        challengeId,
        csrfSecret,
        email,
        key,
      },
      {
        consumeChallenge: flow.handlers.consumeChallenge,
        consumeIpLimit: flow.handlers.consumeIpLimit,
        consumePairLimit: flow.handlers.consumePairLimit,
      },
      'rate_limited',
    )
    assert.deepEqual(
      flow.calls.map((call) => call[0]),
      ['challenge', 'ip'],
    )
  })

  it('keeps a consumed challenge when a limit fails', async () => {
    const flow = sequence({ ipError: new Error(`limiter ${email}`) })

    await failure(
      {
        database: { async query() {} },
        clientIp,
        challengeId,
        csrfSecret,
        email,
        key,
      },
      {
        consumeChallenge: flow.handlers.consumeChallenge,
        consumeIpLimit: flow.handlers.consumeIpLimit,
        consumePairLimit: flow.handlers.consumePairLimit,
      },
      'unavailable',
    )
    assert.deepEqual(
      flow.calls.map((call) => call[0]),
      ['challenge', 'ip'],
    )
  })

  it('rejects malformed input before touching the challenge or limits', async () => {
    const flow = sequence({})
    const dependencies = {
      consumeChallenge: flow.handlers.consumeChallenge,
      consumeIpLimit: flow.handlers.consumeIpLimit,
      consumePairLimit: flow.handlers.consumePairLimit,
    }
    const base = {
      database: { async query() {} },
      clientIp,
      challengeId,
      csrfSecret,
      email,
      key,
    }

    await failure({ ...base, challengeId: 'short' }, dependencies, 'rejected')
    await failure(
      { ...base, clientIp: '::ffff:203.0.113.10' },
      dependencies,
      'rejected',
    )
    await failure({ ...base, email: 'not-an-email' }, dependencies, 'rejected')
    await failure({ ...base, key: null }, dependencies, 'unavailable')
    assert.deepEqual(flow.calls, [])
  })
})
