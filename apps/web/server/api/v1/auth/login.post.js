import { loginAccount } from '../../../utils/account-login.js'
import { readAllowedOrigin } from '../../../utils/csrf-bootstrap.js'
import { serverInternalSecret } from '../../../utils/internal-call.js'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')

  const runtimeConfig = useRuntimeConfig()
  const result = await loginAccount({
    origin: getRequestHeader(event, 'origin'),
    referer: getRequestHeader(event, 'referer'),
    cookieHeader: getRequestHeader(event, 'cookie'),
    csrfToken: getRequestHeader(event, 'x-csrf-token'),
    readBody: () => readBody(event),
    request: event.node?.req,
    allowedOrigin: readAllowedOrigin({
      env: process.env,
      runtimeConfig,
    }),
    secret: serverInternalSecret(runtimeConfig),
    apiBase: runtimeConfig.public?.apiBase,
    nodeEnv: process.env.NODE_ENV,
    commitSessionCookie(cookie) {
      setCookie(event, cookie.name, cookie.value, cookie.options)
    },
  })

  if (result.clearChallenge && result.challengeCookie) {
    deleteCookie(
      event,
      result.challengeCookie.name,
      result.challengeCookie.options,
    )
  }

  setResponseStatus(event, result.status)
  return result.body
})
