import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  bootstrapLoginCsrf,
  submitAccountLogin,
} from '../app/modules/account-login/bff.js'
import {
  clearLoginCsrf,
  readLoginCsrf,
} from '../app/modules/account-login/csrf-memory.js'
import { validateLoginForm } from '../app/modules/account-login/form.js'
import { LOGIN_MESSAGES } from '../app/modules/account-login/messages.js'

const origin = 'http://localhost:3000'
const csrfSecret = randomBytes(32).toString('base64url')
const nextCsrf = randomBytes(32).toString('base64url')
const accessToken = 'access-token-should-not-leak'
const refreshToken = 'refresh-token-should-not-leak'

describe('account login client', () => {
  it('bootstraps a challenge without a bearer header', async () => {
    clearLoginCsrf()
    const calls = []
    const result = await bootstrapLoginCsrf(origin, {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init })
        return json(200, { csrfSecret })
      },
    })

    assert.equal(result.ok, true)
    assert.equal(readLoginCsrf(), csrfSecret)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `${origin}/api/v1/auth/csrf`)
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(authorization(calls[0].init), null)
    assert.equal(calls[0].init.body, undefined)
  })

  it('rejects an auth success body that includes extra secrets', async () => {
    clearLoginCsrf()
    const result = await bootstrapLoginCsrf(origin, {
      fetch: async () => json(200, { csrfSecret, accessToken, refreshToken }),
    })

    assert.equal(result.ok, false)
    assert.equal(readLoginCsrf(), null)
    assert.equal(JSON.stringify(result).includes(accessToken), false)
    assert.equal(JSON.stringify(result).includes(refreshToken), false)
  })

  it('logs in with the challenge secret and keeps tokens out of memory', async () => {
    clearLoginCsrf()
    await bootstrapLoginCsrf(origin, {
      fetch: async () => json(200, { csrfSecret }),
    })

    const calls = []
    const result = await submitAccountLogin(
      origin,
      { email: 'user@example.com', password: 'secret-password' },
      {
        fetch: async (url, init) => {
          calls.push({ url: String(url), init })
          return json(200, { csrfSecret: nextCsrf })
        },
      },
    )

    assert.equal(result.ok, true)
    assert.equal(readLoginCsrf(), nextCsrf)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `${origin}/api/v1/auth/login`)
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(authorization(calls[0].init), null)
    assert.equal(headerValue(calls[0].init, 'x-csrf-token'), csrfSecret)
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      email: 'user@example.com',
      password: 'secret-password',
    })
    assert.equal(JSON.stringify(result).includes(accessToken), false)
    assert.equal(JSON.stringify(result).includes(refreshToken), false)
  })

  it('maps login failures and clears the challenge', async () => {
    const cases = [
      [401, LOGIN_MESSAGES.invalidCredentials],
      [403, LOGIN_MESSAGES.formExpired],
      [429, LOGIN_MESSAGES.rateLimited],
      [503, LOGIN_MESSAGES.unavailable],
    ]

    for (const [status, message] of cases) {
      clearLoginCsrf()
      await bootstrapLoginCsrf(origin, {
        fetch: async () => json(200, { csrfSecret }),
      })

      const result = await submitAccountLogin(
        origin,
        { email: 'user@example.com', password: 'bad' },
        {
          fetch: async () => json(status, { code: 'ignored', accessToken }),
        },
      )

      assert.equal(result.ok, false)
      assert.equal(result.status, status)
      assert.equal(result.message, message)
      assert.equal(readLoginCsrf(), null)
      assert.equal(JSON.stringify(result).includes(accessToken), false)
    }
  })

  it('maps csrf failures without storing a secret', async () => {
    clearLoginCsrf()
    const result = await bootstrapLoginCsrf(origin, {
      fetch: async () => json(429, { code: 'rate_limited', csrfSecret }),
    })

    assert.equal(result.ok, false)
    assert.equal(result.message, LOGIN_MESSAGES.rateLimited)
    assert.equal(readLoginCsrf(), null)
  })

  it('validates required login fields locally', () => {
    assert.equal(validateLoginForm({ email: '', password: 'x' }).ok, false)
    assert.equal(validateLoginForm({ email: 'a@b.c', password: '' }).ok, false)
    assert.equal(
      validateLoginForm({ email: 'a@b.c', password: 'secret' }).ok,
      true,
    )
  })
})

function json(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body)
    },
  }
}

function authorization(init) {
  const headers = init?.headers
  return headers && typeof headers.get === 'function'
    ? headers.get('authorization')
    : null
}

function headerValue(init, name) {
  const headers = init?.headers
  return headers && typeof headers.get === 'function' ? headers.get(name) : null
}
