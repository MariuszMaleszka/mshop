import { revokeSupabaseSession } from '../auth/supabase-logout.js'
import {
  PasswordAuthError,
  signInWithPassword,
} from '../auth/supabase-password-auth.js'
import { prepareLoginAttempt } from './prepare-login-attempt.js'
import { createReadyAccountSession } from './repository.js'

const SESSION_HASH = /^[0-9a-f]{64}$/

export class CompleteLoginError extends Error {
  constructor(code) {
    super('Login could not be completed')
    this.name = 'CompleteLoginError'
    this.code = code
  }
}

export async function completeLoginAttempt(
  {
    database,
    clientIp,
    challengeId,
    csrfSecret,
    email,
    password,
    rateLimitKey,
    sessionKey,
    supabaseUrl,
    anonKey,
    previousSessionHash,
  } = {},
  dependencies = {},
) {
  if (
    previousSessionHash != null &&
    (typeof previousSessionHash !== 'string' ||
      !SESSION_HASH.test(previousSessionHash))
  ) {
    throw new CompleteLoginError('rejected')
  }

  const prepareAttempt = dependencies.prepareAttempt ?? prepareLoginAttempt
  const signIn = dependencies.signIn ?? signInWithPassword
  const createSession = dependencies.createSession ?? createReadyAccountSession
  const revokeSession = dependencies.revokeSession ?? revokeSupabaseSession

  try {
    await prepareAttempt({
      database,
      clientIp,
      challengeId,
      csrfSecret,
      email,
      key: rateLimitKey,
    })
  } catch (error) {
    throw loginFailure(preparationCode(error))
  }

  let authenticated

  try {
    authenticated = await signIn({
      supabaseUrl,
      anonKey,
      email,
      password,
    })
  } catch (error) {
    throw loginFailure(authenticationCode(error))
  }

  if (!isAuthenticatedSession(authenticated)) {
    throw new CompleteLoginError('invalid_response')
  }

  try {
    const created = await createSession(database, {
      userId: authenticated.userId,
      accessToken: authenticated.accessToken,
      refreshToken: authenticated.refreshToken,
      key: sessionKey,
      previousSessionHash,
    })

    if (!isCreatedSession(created)) {
      throw new CompleteLoginError('session_failed')
    }

    return {
      sessionId: created.sessionId,
      csrfSecret: created.csrfSecret,
    }
  } catch (error) {
    await revokeAuthenticatedSession(revokeSession, {
      supabaseUrl,
      anonKey,
      accessToken: authenticated.accessToken,
    })

    if (error instanceof CompleteLoginError) {
      throw error
    }

    throw new CompleteLoginError('session_failed')
  }
}

async function revokeAuthenticatedSession(revokeSession, input) {
  const first = await readRevocation(revokeSession, input)

  if (first !== 'unknown') {
    return
  }

  await readRevocation(revokeSession, input)
}

async function readRevocation(revokeSession, input) {
  try {
    const result = await revokeSession(input)
    if (
      result?.outcome === 'revoked' ||
      result?.outcome === 'rejected' ||
      result?.outcome === 'unknown'
    ) {
      return result.outcome
    }
  } catch {
    return 'unknown'
  }

  return 'unknown'
}

function preparationCode(error) {
  if (
    error?.code === 'invalid_challenge' ||
    error?.code === 'rate_limited' ||
    error?.code === 'rejected' ||
    error?.code === 'unavailable'
  ) {
    return error.code
  }

  return 'unavailable'
}

function authenticationCode(error) {
  if (!(error instanceof PasswordAuthError)) {
    return 'unavailable'
  }

  if (error.code === 'invalid_credentials' || error.code === 'rejected') {
    return 'invalid_credentials'
  }

  if (error.code === 'invalid_response') {
    return 'invalid_response'
  }

  if (error.code === 'configuration') {
    return 'configuration'
  }

  return 'unavailable'
}

function isAuthenticatedSession(value) {
  return (
    isSecret(value?.accessToken) &&
    isSecret(value?.refreshToken) &&
    typeof value?.userId === 'string' &&
    value.userId.length > 0
  )
}

function isCreatedSession(value) {
  return isSecret(value?.sessionId) && isSecret(value?.csrfSecret)
}

function isSecret(value) {
  return typeof value === 'string' && value.length > 0
}

function loginFailure(code) {
  return new CompleteLoginError(code)
}
