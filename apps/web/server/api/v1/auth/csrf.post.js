import {
  bootstrapCsrfChallenge,
  readAllowedOrigin,
} from '../../../utils/csrf-bootstrap.js'
import { serverInternalSecret } from '../../../utils/internal-call.js'

export default defineEventHandler(async (event) => {
  const runtimeConfig = useRuntimeConfig()
  const result = await bootstrapCsrfChallenge({
    origin: getRequestHeader(event, 'origin'),
    referer: getRequestHeader(event, 'referer'),
    request: event.node?.req,
    allowedOrigin: readAllowedOrigin({
      env: process.env,
      runtimeConfig,
    }),
    secret: serverInternalSecret(runtimeConfig),
    apiBase: runtimeConfig.public?.apiBase,
    nodeEnv: process.env.NODE_ENV,
  })

  if (result.cookie) {
    setCookie(
      event,
      result.cookie.name,
      result.cookie.value,
      result.cookie.options,
    )
  }

  setResponseStatus(event, result.status)
  return result.body
})
