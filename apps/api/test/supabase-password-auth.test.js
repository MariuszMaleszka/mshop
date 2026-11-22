import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PASSWORD_AUTH_TIMEOUT_MS,
  PasswordAuthError,
  signInWithPassword,
} from '../src/auth/supabase-password-auth.js'

const supabaseUrl = 'http://127.0.0.1:54321'
const anonKey = 'anon-key-not-a-service-role'
const serviceRoleKey = 'service-role-key-must-stay-unused'
const email = 'person@example.com'
const password = 'correct-horse-battery'
const accessToken = 'access-token-value'
const refreshToken = 'refresh-token-value'
const userId = '11111111-1111-4111-8111-111111111111'
const expiresAt = 1_800_000_000

function sessionBody(overrides = {}) {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    expires_in: 3600,
    token_type: 'bearer',
    user: {
      id: userId,
      email,
      role: 'authenticated',
    },
    ...overrides,
  }
}

function jsonResponse(body, status = 200) {
  return {
    status,
    async json() {
      return body
    },
  }
}

function recordedFetch(handler) {
  const calls = []

  return {
    calls,
    async fetch(url, options) {
      calls.push({ url, options })
      return handler(url, options)
    },
  }
}

async function expectFailure(input, code) {
  const error = await signInWithPassword(input).then(
    () => {
      throw new Error('expected PasswordAuthError')
    },
    (caught) => caught,
  )
  const visible = `${error.name} ${error.message} ${String(error)} ${JSON.stringify(error)}`

  assert.equal(error instanceof PasswordAuthError, true)
  assert.equal(error.code, code)
  assert.equal(error.message, 'Password authentication failed')
  assert.equal(visible.includes(password), false)
  assert.equal(visible.includes(accessToken), false)
  assert.equal(visible.includes(refreshToken), false)
  assert.equal(visible.includes(email), false)
  assert.equal(visible.includes(anonKey), false)
  assert.equal(visible.includes(serviceRoleKey), false)
  assert.equal(error.cause, undefined)
}

describe('signInWithPassword', () => {
  it('posts the password grant with the anon key and returns four fields', async () => {
    const transport = recordedFetch(() => jsonResponse(sessionBody()))
    const session = await signInWithPassword({
      supabaseUrl: `${supabaseUrl}/`,
      anonKey,
      email,
      password,
      fetchImpl: transport.fetch,
    })
    const request = transport.calls[0]
    const headers = new Headers(request.options.headers)

    assert.equal(transport.calls.length, 1)
    assert.equal(
      request.url,
      'http://127.0.0.1:54321/auth/v1/token?grant_type=password',
    )
    assert.equal(request.options.method, 'POST')
    assert.equal(headers.get('apikey'), anonKey)
    assert.equal(headers.get('content-type'), 'application/json')
    assert.equal(headers.get('authorization'), null)
    assert.equal(JSON.stringify(request).includes(serviceRoleKey), false)
    assert.deepEqual(JSON.parse(request.options.body), { email, password })
    assert.equal(request.options.signal.aborted, false)
    assert.deepEqual(session, {
      accessToken,
      refreshToken,
      expiresAt,
      userId,
    })
    assert.equal(Object.hasOwn(session, 'email'), false)
    assert.equal(Object.hasOwn(session, 'expires_in'), false)
  })

  it('maps a wrong password and an unknown account to the same code', async () => {
    const wrongPassword = recordedFetch(() =>
      jsonResponse(
        {
          error: 'invalid_grant',
          error_description: `Invalid login credentials ${password}`,
        },
        400,
      ),
    )
    const unknownAccount = recordedFetch(() =>
      jsonResponse(
        {
          code: 400,
          error_code: 'user_not_found',
          msg: `User ${email} not found ${accessToken}`,
        },
        400,
      ),
    )

    await expectFailure(
      {
        supabaseUrl,
        anonKey,
        email,
        password,
        fetchImpl: wrongPassword.fetch,
      },
      'invalid_credentials',
    )
    await expectFailure(
      {
        supabaseUrl,
        anonKey,
        email,
        password,
        fetchImpl: unknownAccount.fetch,
      },
      'invalid_credentials',
    )
    assert.equal(wrongPassword.calls.length, 1)
    assert.equal(unknownAccount.calls.length, 1)
  })

  it('stops on timeout without returning tokens or retrying', async () => {
    const transport = recordedFetch(async (_url, options) => {
      await new Promise((resolve) => {
        setTimeout(resolve, 40)
      })

      if (options.signal.aborted) {
        throw new DOMException(
          `timeout ${password} ${accessToken}`,
          'TimeoutError',
        )
      }

      return jsonResponse(sessionBody())
    })

    await expectFailure(
      {
        supabaseUrl,
        anonKey,
        email,
        password,
        fetchImpl: transport.fetch,
        timeoutMs: 20,
      },
      'timeout',
    )
    assert.equal(transport.calls.length, 1)
    assert.equal(PASSWORD_AUTH_TIMEOUT_MS, 8000)
  })

  it('maps a connection failure and an HTTP 5xx response to unavailable', async () => {
    const disconnected = recordedFetch(() => {
      throw new TypeError(`connect ${password} ${refreshToken}`)
    })
    const unavailable = recordedFetch(() =>
      jsonResponse(
        { error: 'unexpected_failure', access_token: accessToken },
        503,
      ),
    )

    await expectFailure(
      {
        supabaseUrl,
        anonKey,
        email,
        password,
        fetchImpl: disconnected.fetch,
      },
      'unavailable',
    )
    await expectFailure(
      {
        supabaseUrl,
        anonKey,
        email,
        password,
        fetchImpl: unavailable.fetch,
      },
      'unavailable',
    )
    assert.equal(disconnected.calls.length, 1)
    assert.equal(unavailable.calls.length, 1)
  })

  it('rejects other HTTP responses without treating them as a bad password', async () => {
    const transport = recordedFetch(() =>
      jsonResponse(
        {
          error_code: 'email_not_confirmed',
          msg: `confirm ${email}`,
        },
        422,
      ),
    )

    await expectFailure(
      {
        supabaseUrl,
        anonKey,
        email,
        password,
        fetchImpl: transport.fetch,
      },
      'rejected',
    )
    assert.equal(transport.calls.length, 1)
  })

  it('rejects malformed success bodies without calling them bad credentials', async () => {
    const brokenJson = recordedFetch(() => ({
      status: 200,
      async json() {
        throw new SyntaxError(`bad json ${password} ${accessToken}`)
      },
    }))
    const missingFields = recordedFetch(() =>
      jsonResponse({ access_token: accessToken, user: { id: userId } }),
    )
    const badUser = recordedFetch(() =>
      jsonResponse(sessionBody({ user: { id: 'not-a-uuid' } })),
    )

    await expectFailure(
      {
        supabaseUrl,
        anonKey,
        email,
        password,
        fetchImpl: brokenJson.fetch,
      },
      'invalid_response',
    )
    await expectFailure(
      {
        supabaseUrl,
        anonKey,
        email,
        password,
        fetchImpl: missingFields.fetch,
      },
      'invalid_response',
    )
    await expectFailure(
      {
        supabaseUrl,
        anonKey,
        email,
        password,
        fetchImpl: badUser.fetch,
      },
      'invalid_response',
    )
    assert.equal(brokenJson.calls.length, 1)
    assert.equal(missingFields.calls.length, 1)
    assert.equal(badUser.calls.length, 1)
  })

  it('does not call Auth when the server configuration is missing', async () => {
    const transport = recordedFetch(() => jsonResponse(sessionBody()))

    await expectFailure(
      {
        anonKey,
        email,
        password,
        fetchImpl: transport.fetch,
      },
      'configuration',
    )
    await expectFailure(
      {
        supabaseUrl,
        anonKey: '',
        email,
        password,
        fetchImpl: transport.fetch,
      },
      'configuration',
    )
    await expectFailure(
      {
        supabaseUrl: 'not a url',
        anonKey,
        email,
        password,
        fetchImpl: transport.fetch,
      },
      'configuration',
    )
    assert.equal(transport.calls.length, 0)
  })
})
