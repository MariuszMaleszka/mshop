import { requestApi } from '../../composables/use-api.js'

export function requestAdminOrders(origin, path, dependencies) {
  return requestApi(nuxtApiBase(origin), path, {}, dependencies)
}

function nuxtApiBase(origin) {
  if (typeof origin !== 'string') {
    return null
  }

  let url

  try {
    url = new URL(origin)
  } catch {
    return null
  }

  if (
    url.origin !== origin ||
    (url.protocol !== 'http:' && url.protocol !== 'https:')
  ) {
    return null
  }

  return `${url.origin}/api/v1`
}
