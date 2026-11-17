import { createRemoteJWKSet, jwtVerify } from 'jose'
import {
  JOSEAlgNotAllowed,
  JOSENotSupported,
  JWKInvalid,
  JWKSMultipleMatchingKeys,
  JWKSNoMatchingKey,
  JWSInvalid,
  JWSSignatureVerificationFailed,
  JWTClaimValidationFailed,
  JWTExpired,
  JWTInvalid,
} from 'jose/errors'
import { HttpError } from '../http/errors.js'

// Public Supabase signing keys. HS256 is excluded because it needs a shared secret.
const SIGNING_ALGORITHMS = ['ES256', 'RS256']
const JWKS_OPTIONS = {
  timeoutDuration: 5000,
  cooldownDuration: 30_000,
  cacheMaxAge: 600_000,
}
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const tokenRejectionTypes = [
  JOSEAlgNotAllowed,
  JOSENotSupported,
  JWKInvalid,
  JWKSMultipleMatchingKeys,
  JWKSNoMatchingKey,
  JWSInvalid,
  JWSSignatureVerificationFailed,
  JWTClaimValidationFailed,
  JWTExpired,
  JWTInvalid,
]

export function supabaseIssuer(supabaseUrl) {
  return `${normalizeSupabaseUrl(supabaseUrl)}/auth/v1`
}

export function supabaseJwksUrl(supabaseUrl) {
  return new URL(`${supabaseIssuer(supabaseUrl)}/.well-known/jwks.json`)
}

export function createAccessTokenVerifier({
  supabaseUrl,
  jwks,
  createJwks = createRemoteJWKSet,
} = {}) {
  const issuer = supabaseUrl ? supabaseIssuer(supabaseUrl) : null
  const keySet =
    jwks ?? (issuer ? createJwks(supabaseJwksUrl(supabaseUrl), JWKS_OPTIONS) : null)

  return {
    async verifyAccessToken(token) {
      if (!issuer || !keySet) {
        throw unavailable('auth.not_configured')
      }

      if (typeof token !== 'string' || token.length === 0) {
        throw unauthorized('auth.invalid_token')
      }

      try {
        const { payload } = await jwtVerify(token, keySet, {
          issuer,
          audience: 'authenticated',
          algorithms: SIGNING_ALGORITHMS,
          requiredClaims: ['exp'],
        })

        if (typeof payload.sub !== 'string' || !UUID_PATTERN.test(payload.sub)) {
          throw unauthorized('auth.invalid_subject')
        }

        return payload.sub
      } catch (error) {
        if (error instanceof HttpError) {
          throw error
        }

        if (isTokenRejection(error)) {
          throw unauthorized('auth.invalid_token')
        }

        throw unavailable('auth.jwks_unavailable')
      }
    },
  }
}

function normalizeSupabaseUrl(supabaseUrl) {
  return String(supabaseUrl).replace(/\/+$/, '')
}

function isTokenRejection(error) {
  return tokenRejectionTypes.some((type) => error instanceof type)
}

function unauthorized(logMessage) {
  return new HttpError({
    status: 401,
    code: 'UNAUTHORIZED',
    message: 'Authentication required',
    logMessage,
  })
}

function unavailable(logMessage) {
  return new HttpError({
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
    message: 'Service unavailable',
    logMessage,
  })
}
