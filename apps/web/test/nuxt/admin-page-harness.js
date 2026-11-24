import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { expect, vi } from 'vitest'

export const SECRETS = [
  'access-token-should-not-leak',
  'refresh-token-should-not-leak',
  'session-id-should-not-leak',
  'session-hash-should-not-leak',
  'csrf-secret-should-not-leak',
  'bff-internal-secret-should-not-leak',
]

export function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body)
    },
  }
}

export function withSecrets(body) {
  return {
    ...body,
    accessToken: SECRETS[0],
    refreshToken: SECRETS[1],
    sessionId: SECRETS[2],
    sessionHash: SECRETS[3],
    csrfSecret: SECRETS[4],
    internalSecret: SECRETS[5],
  }
}

export function installFetch(response, { defer = false } = {}) {
  let release = () => {}
  const gate = defer
    ? new Promise((resolve) => {
        release = resolve
      })
    : Promise.resolve()
  const calls = []
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init, stack: new Error().stack ?? '' })
    await gate
    return response
  })
  vi.stubGlobal('fetch', fetchImpl)
  return { calls, release }
}

export function mountAdminPage(component, { route }) {
  return mountSuspended(component, { route })
}

export function assertMountedLoad(call, fileName) {
  expect(call.stack).toContain(`at load (`)
  expect(call.stack).toContain(fileName)
  expect(call.stack).toContain('flushPostFlushCbs')
}

export function settle() {
  return flushPromises()
}

export function assertNoSecrets(wrapper) {
  const html = wrapper.html()
  const attributes = [...wrapper.element.querySelectorAll('*')]
    .flatMap((element) =>
      [...element.attributes].map((attribute) => attribute.value),
    )
    .join('\n')
  const state = stateText(wrapper.vm)

  for (const secret of SECRETS) {
    expect(html).not.toContain(secret)
    expect(attributes).not.toContain(secret)
    expect(state).not.toContain(secret)
  }
}

export function assertBffCall(call, url) {
  expect(call.url).toBe(url)
  const headers = call.init?.headers
  const authorization =
    headers && typeof headers.get === 'function'
      ? headers.get('authorization')
      : null
  expect(authorization).toBeNull()
  expect(call.init?.body ?? null).toBeNull()
  const serialized = `${call.url} ${call.init?.method ?? ''} ${authorization ?? ''}`
  for (const secret of SECRETS) {
    expect(serialized).not.toContain(secret)
  }
}

function stateText(value) {
  const seen = new WeakSet()
  try {
    return (
      JSON.stringify(value, (_key, item) => {
        if (typeof item === 'function') {
          return undefined
        }
        if (item && typeof item === 'object') {
          if (seen.has(item)) {
            return undefined
          }
          seen.add(item)
        }
        return item
      }) ?? ''
    )
  } catch {
    return ''
  }
}
