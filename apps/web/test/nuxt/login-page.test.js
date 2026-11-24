import { randomBytes } from 'node:crypto'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LoginPage from '../../app/pages/login.vue'
import {
  clearLoginCsrf,
  readLoginCsrf,
} from '../../app/modules/account-login/csrf-memory.js'
import { LOGIN_MESSAGES } from '../../app/modules/account-login/messages.js'
import { assertNoSecrets, settle, withSecrets } from './admin-page-harness.js'

const CSRF_URL = 'http://localhost:3000/api/v1/auth/csrf'
const LOGIN_URL = 'http://localhost:3000/api/v1/auth/login'
const CSRF_SECRET = randomBytes(32).toString('base64url')
const NEXT_CSRF = randomBytes(32).toString('base64url')

const navigateToMock = mockNuxtImport('navigateTo', () =>
  vi.fn(() => Promise.resolve()),
)

describe('login page', () => {
  const wrappers = []

  afterEach(() => {
    vi.unstubAllGlobals()
    clearLoginCsrf()
    navigateToMock.mockClear()
    for (const wrapper of wrappers.splice(0)) {
      wrapper.unmount()
    }
  })

  it('loads a CSRF challenge after mount', async () => {
    const pending = installAuthFetch([
      {
        url: CSRF_URL,
        response: jsonResponse(200, { csrfSecret: CSRF_SECRET }),
      },
    ])
    const wrapper = await mountLogin()
    await settle()

    expect(pending.calls).toHaveLength(1)
    assertAuthCall(pending.calls[0], {
      url: CSRF_URL,
      method: 'POST',
      body: null,
    })
    expect(readLoginCsrf()).toBe(CSRF_SECRET)
    expect(wrapper.text()).toContain('Logowanie')
    expect(
      wrapper.get('button[type="submit"]').attributes('disabled'),
    ).toBeUndefined()
    assertNoSecrets(wrapper)
    expect(wrapper.html()).not.toContain(CSRF_SECRET)
  })

  it('logs in through the Nuxt BFF and leaves the login page', async () => {
    const pending = installAuthFetch([
      {
        url: CSRF_URL,
        response: jsonResponse(200, { csrfSecret: CSRF_SECRET }),
      },
      {
        url: LOGIN_URL,
        response: jsonResponse(200, { csrfSecret: NEXT_CSRF }),
      },
    ])
    const wrapper = await mountLogin()
    await settle()

    await wrapper.get('input[name="email"]').setValue('user@example.com')
    await wrapper.get('input[name="password"]').setValue('correct-password')
    await wrapper.get('form').trigger('submit.prevent')
    await settle()

    expect(pending.calls).toHaveLength(2)
    assertAuthCall(pending.calls[1], {
      url: LOGIN_URL,
      method: 'POST',
      csrf: CSRF_SECRET,
      body: {
        email: 'user@example.com',
        password: 'correct-password',
      },
    })
    expect(readLoginCsrf()).toBe(NEXT_CSRF)
    expect(navigateToMock).toHaveBeenCalledWith('/')
    assertNoSecrets(wrapper)
    expect(wrapper.html()).not.toContain(NEXT_CSRF)
    expect(wrapper.html()).not.toContain('correct-password')
  })

  it('shows the invalid credentials message after HTTP 401', async () => {
    await expectLoginStatus(401, LOGIN_MESSAGES.invalidCredentials)
  })

  it('shows the expired form message after HTTP 403', async () => {
    await expectLoginStatus(403, LOGIN_MESSAGES.formExpired)
  })

  it('shows the rate limit message after HTTP 429', async () => {
    await expectLoginStatus(429, LOGIN_MESSAGES.rateLimited)
  })

  it('shows the unavailable message after HTTP 503', async () => {
    await expectLoginStatus(503, LOGIN_MESSAGES.unavailable)
  })

  it('shows a CSRF bootstrap failure without enabling submit', async () => {
    const pending = installAuthFetch([
      {
        url: CSRF_URL,
        response: jsonResponse(429, withSecrets({ code: 'rate_limited' })),
      },
    ])
    const wrapper = await mountLogin()
    await settle()

    expect(pending.calls).toHaveLength(1)
    expect(wrapper.text()).toContain(LOGIN_MESSAGES.rateLimited)
    expect(
      wrapper.get('button[type="submit"]').attributes('disabled'),
    ).toBeDefined()
    expect(readLoginCsrf()).toBeNull()
    assertNoSecrets(wrapper)
  })

  it('blocks a second submit while login is in flight', async () => {
    let releaseLogin = () => {}
    const loginGate = new Promise((resolve) => {
      releaseLogin = resolve
    })
    const pending = installAuthFetch([
      {
        url: CSRF_URL,
        response: jsonResponse(200, { csrfSecret: CSRF_SECRET }),
      },
      {
        url: LOGIN_URL,
        defer: loginGate,
        response: jsonResponse(200, { csrfSecret: NEXT_CSRF }),
      },
    ])
    const wrapper = await mountLogin()
    await settle()

    await wrapper.get('input[name="email"]').setValue('user@example.com')
    await wrapper.get('input[name="password"]').setValue('correct-password')
    await wrapper.get('form').trigger('submit.prevent')
    await flushPromises()
    await wrapper.get('form').trigger('submit.prevent')
    await flushPromises()

    expect(pending.calls.filter((call) => call.url === LOGIN_URL)).toHaveLength(
      1,
    )
    expect(wrapper.text()).toContain('Logowanie…')
    releaseLogin()
    await settle()
    expect(navigateToMock).toHaveBeenCalledWith('/')
  })

  async function expectLoginStatus(status, message) {
    const pending = installAuthFetch([
      {
        url: CSRF_URL,
        response: jsonResponse(200, { csrfSecret: CSRF_SECRET }),
      },
      {
        url: LOGIN_URL,
        response: jsonResponse(status, withSecrets({ code: 'upstream' })),
      },
      {
        url: CSRF_URL,
        response: jsonResponse(200, {
          csrfSecret: randomBytes(32).toString('base64url'),
        }),
      },
    ])
    const wrapper = await mountLogin()
    await settle()

    await wrapper.get('input[name="email"]').setValue('user@example.com')
    await wrapper.get('input[name="password"]').setValue('wrong-password')
    await wrapper.get('form').trigger('submit.prevent')
    await settle()

    expect(pending.calls[1].url).toBe(LOGIN_URL)
    expect(wrapper.text()).toContain(message)
    expect(wrapper.html()).not.toContain('wrong-password')
    expect(navigateToMock).not.toHaveBeenCalled()
    assertNoSecrets(wrapper)
    expect(
      pending.calls.filter((call) => call.url === CSRF_URL).length,
    ).toBeGreaterThanOrEqual(2)
  }

  async function mountLogin() {
    const wrapper = await mountSuspended(LoginPage, {
      route: '/login',
    })
    wrappers.push(wrapper)
    return wrapper
  }
})

function installAuthFetch(steps) {
  const calls = []
  let index = 0
  const fetchImpl = vi.fn(async (url, init) => {
    const current = steps[Math.min(index, steps.length - 1)]
    index += 1
    calls.push({ url: String(url), init })

    if (current.defer) {
      await current.defer
    }

    return current.response
  })
  vi.stubGlobal('fetch', fetchImpl)
  return { calls }
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body)
    },
  }
}

function assertAuthCall(call, expected) {
  expect(call.url).toBe(expected.url)
  expect(call.init?.method ?? 'GET').toBe(expected.method)
  const headers = call.init?.headers
  const authorization =
    headers && typeof headers.get === 'function'
      ? headers.get('authorization')
      : null
  expect(authorization).toBeNull()

  if (expected.csrf) {
    expect(headers.get('x-csrf-token')).toBe(expected.csrf)
  }

  if (expected.body === null) {
    expect(call.init?.body ?? null).toBeNull()
    return
  }

  expect(JSON.parse(call.init.body)).toEqual(expected.body)
}
