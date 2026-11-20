let sessionPromise = null

export function resetGuestSession() {
  sessionPromise = null
}

export function ensureGuestSession(request) {
  if (!sessionPromise) {
    sessionPromise = request('/session/guest', { method: 'POST' }).then(
      (result) => {
        if (result.error) {
          sessionPromise = null
        }

        return result
      },
    )
  }

  return sessionPromise
}

export async function withGuestSession(request, work) {
  const started = await ensureGuestSession(request)

  if (started.error) {
    return started
  }

  const result = await work()

  if (result.error?.code !== 'UNAUTHORIZED') {
    return result
  }

  resetGuestSession()
  const retried = await ensureGuestSession(request)

  if (retried.error) {
    return retried
  }

  return work()
}

export function useGuestSession() {
  const api = useApi()

  return {
    ensure() {
      return ensureGuestSession(api.request)
    },
  }
}
