import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { PasswordAuthError } from '../src/auth/supabase-password-auth.js'
import {
  CompleteLoginError,
  completeLoginAttempt,
} from '../src/account-session/complete-login-attempt.js'
import { LoginAttemptError } from '../src/account-session/prepare-login-attempt.js'
import { createLoginChallengeValue } from '../src/account-session/repository.js'

const rateLimitKey = randomBytes(32)
const sessionKey = randomBytes(32)
const email = 'person@example.com'
const password = 'correct-horse-battery'
const accessToken = 'access-token-value'
const refreshToken = 'refresh-token-value'
const userId = '11111111-1111-4111-8111-111111111111'
const sessionId = createLoginChallengeValue()
const csrfSecret = createLoginChallengeValue()
const previousSessionHash =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const providerBody = `{"access_token":"${accessToken}","msg":"${email}"}`

function input(overrides = {}) {
  return {
    database: { async query() {} },
    clientIp: '203.0.113.10',
    challengeId: createLoginChallengeValue(),
    csrfSecret: createLoginChallengeValue(),
    email,
    password,
    rateLimitKey,
    sessionKey,
    supabaseUrl: 'http://127.0.0.1:54321',
    anonKey: 'anon-key-value',
    ...overrides,
  }
}

function flow(results = {}) {
  const calls = []

  return {
    calls,
    async prepareAttempt() {
      calls.push('prepare')
      if (results.prepare) {
        throw results.prepare
      }
    },
    async signIn() {
      calls.push('sign-in')
      if (results.signIn) {
        throw results.signIn
      }
      return {
        accessToken,
        refreshToken,
        expiresAt: 1_800_000_000,
        userId,
        raw: providerBody,
      }
    },
    async createSession(_database, session) {
      calls.push(['create', session.previousSessionHash ?? null])
      if (results.create) {
        throw results.create
      }
      return { sessionId, csrfSecret, accessToken }
    },
    async revokeSession(revocation) {
      calls.push(['revoke', revocation.accessToken])
      const outcome = results.revocations?.shift() ?? 'revoked'
      if (outcome instanceof Error) {
        throw outcome
      }
      return { outcome }
    },
  }
}

function dependencies(handlers) {
  return {
    prepareAttempt: handlers.prepareAttempt,
    signIn: handlers.signIn,
    createSession: handlers.createSession,
    revokeSession: handlers.revokeSession,
  }
}

async function failure(attempt, handlers, code) {
  const error = await completeLoginAttempt(
    attempt,
    dependencies(handlers),
  ).catch((caught) => caught)
  const visible = `${error.name} ${error.message} ${String(error)} ${JSON.stringify(error)}`

  assert.equal(error instanceof CompleteLoginError, true)
  assert.equal(error.code, code)
  assert.equal(error.message, 'Login could not be completed')
  assert.equal(error.cause, undefined)
  for (const secret of [
    email,
    password,
    accessToken,
    refreshToken,
    csrfSecret,
    providerBody,
  ]) {
    assert.equal(visible.includes(secret), false)
  }
  return error
}

describe('completeLoginAttempt', () => {
  it('prepares the attempt, authenticates once, and returns only the session secrets', async () => {
    const handlers = flow()
    const created = await completeLoginAttempt(
      input({ previousSessionHash }),
      dependencies(handlers),
    )

    assert.deepEqual(created, { sessionId, csrfSecret })
    assert.deepEqual(handlers.calls, [
      'prepare',
      'sign-in',
      ['create', previousSessionHash],
    ])
  })

  it('does not authenticate when preparation fails', async () => {
    const handlers = flow({
      prepare: new LoginAttemptError('invalid_challenge'),
    })

    await failure(input(), handlers, 'invalid_challenge')
    assert.deepEqual(handlers.calls, ['prepare'])
  })

  it('does not create a session when the password is rejected', async () => {
    const handlers = flow({
      signIn: new PasswordAuthError('invalid_credentials'),
    })

    await failure(input(), handlers, 'invalid_credentials')
    assert.deepEqual(handlers.calls, ['prepare', 'sign-in'])
  })

  it('does not create a session when Supabase times out or returns HTTP 5xx', async () => {
    const timedOut = flow({ signIn: new PasswordAuthError('timeout') })
    const unavailable = flow({
      signIn: new PasswordAuthError('unavailable'),
    })

    await failure(input(), timedOut, 'unavailable')
    await failure(input(), unavailable, 'unavailable')
    assert.deepEqual(timedOut.calls, ['prepare', 'sign-in'])
    assert.deepEqual(unavailable.calls, ['prepare', 'sign-in'])
  })

  it('does not create a session when the Supabase response is incomplete', async () => {
    const handlers = flow({
      signIn: new PasswordAuthError('invalid_response'),
    })

    await failure(input(), handlers, 'invalid_response')
    assert.deepEqual(handlers.calls, ['prepare', 'sign-in'])
  })

  it('revokes the Supabase session once when revocation is confirmed', async () => {
    const handlers = flow({
      create: new Error(`insert failed ${accessToken} ${providerBody}`),
      revocations: ['revoked', 'revoked'],
    })

    await failure(input(), handlers, 'session_failed')
    assert.deepEqual(handlers.calls, [
      'prepare',
      'sign-in',
      ['create', null],
      ['revoke', accessToken],
    ])
  })

  it('retries revocation once when the first result is unknown', async () => {
    const handlers = flow({
      create: new Error(`commit unknown ${refreshToken}`),
      revocations: ['unknown', 'revoked', 'revoked'],
    })

    await failure(input(), handlers, 'session_failed')
    assert.deepEqual(
      handlers.calls.filter((call) => call[0] === 'revoke'),
      [
        ['revoke', accessToken],
        ['revoke', accessToken],
      ],
    )
  })

  it('stops after a second unknown revocation', async () => {
    const handlers = flow({
      create: new Error(`commit unknown ${email}`),
      revocations: ['unknown', 'unknown', 'revoked'],
    })

    await failure(input(), handlers, 'session_failed')
    assert.equal(
      handlers.calls.filter((call) => call[0] === 'revoke').length,
      2,
    )
    assert.equal(handlers.calls.filter((call) => call === 'sign-in').length, 1)
    assert.equal(
      handlers.calls.filter((call) => call[0] === 'create').length,
      1,
    )
  })

  it('rejects an unchecked previous session hash before authentication', async () => {
    const handlers = flow()

    await failure(
      input({ previousSessionHash: 'not-a-hash' }),
      handlers,
      'rejected',
    )
    assert.deepEqual(handlers.calls, [])
  })
})
