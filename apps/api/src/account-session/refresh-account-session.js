import { randomUUID } from 'node:crypto'
import { revokeSupabaseSession } from '../auth/supabase-logout.js'
import {
  RefreshAuthError,
  refreshSupabaseSession,
} from '../auth/supabase-refresh.js'
import {
  AccountSessionInspectError,
  inspectAccountSession,
} from './inspect-account-session.js'
import { AuthRateLimitError, consumeRefreshRateLimit } from './rate-limit.js'
import {
  AccountSessionWriteError,
  beginAccountSessionRefresh,
  createRefreshGeneration,
  deleteAccountSession,
  extendAccountSessionIdleExpiry,
  markAccountSessionUnknown,
  markStalePendingUnknown,
  saveRefreshedSession,
  sha256Hex,
} from './repository.js'
import { encryptToken, TokenCipherError } from './token-cipher.js'

export async function refreshAccountSession(
  {
    database,
    sessionHash,
    key,
    rateLimitKey,
    supabaseUrl,
    anonKey,
    userId,
    accessToken: _accessToken,
    refreshToken,
    keyVersion,
  } = {},
  dependencies = {},
) {
  void _accessToken
  const refreshAuth = dependencies.refreshAuth ?? refreshSupabaseSession
  const revokeSession = dependencies.revokeSession ?? revokeSupabaseSession
  const consumeLimit =
    dependencies.consumeRefreshLimit ?? consumeRefreshRateLimit
  const createGeneration =
    dependencies.createGeneration ?? createRefreshGeneration
  const random = dependencies.randomUUID ?? randomUUID

  let limit

  try {
    limit = await consumeLimit(database, {
      key: rateLimitKey,
      sessionId: sessionHash,
    })
  } catch (error) {
    if (error instanceof AuthRateLimitError) {
      throw new AccountSessionInspectError('unavailable')
    }

    throw new AccountSessionInspectError('unavailable')
  }

  if (limit?.allowed !== true) {
    return { status: 'rate_limited' }
  }

  const generation = createGeneration(random)
  let started

  try {
    started = await beginAccountSessionRefresh(database, {
      idHash: sessionHash,
      generation,
      refreshTokenHash: sha256Hex(refreshToken),
    })
  } catch (error) {
    if (
      error instanceof AccountSessionWriteError &&
      error.code === 'rejected'
    ) {
      return { status: 'invalid' }
    }

    throw new AccountSessionInspectError('unavailable')
  }

  if (!started) {
    return recoverAfterLostRefreshStart({ database, sessionHash, key })
  }

  let refreshed

  try {
    refreshed = await refreshAuth({
      supabaseUrl,
      anonKey,
      refreshToken,
    })
  } catch (error) {
    return handleRefreshAuthFailure({
      database,
      sessionHash,
      generation,
      error,
    })
  }

  if (!isRefreshedSession(refreshed) || refreshed.userId !== userId) {
    await markUnknownQuietly(database, sessionHash, generation)
    return { status: 'unknown' }
  }

  let access
  let refresh

  try {
    access = encryptToken(refreshed.accessToken, key, {
      version: keyVersion,
    })
    refresh = encryptToken(refreshed.refreshToken, key, {
      version: keyVersion,
    })
  } catch (error) {
    await markUnknownQuietly(database, sessionHash, generation)
    await revokeNewSession(revokeSession, {
      supabaseUrl,
      anonKey,
      accessToken: refreshed.accessToken,
    })

    if (error instanceof TokenCipherError) {
      return { status: 'unknown' }
    }

    throw new AccountSessionInspectError('unavailable')
  }

  let saved

  try {
    saved = await saveRefreshedSession(database, {
      idHash: sessionHash,
      generation,
      session: {
        keyVersion: access.version,
        accessCiphertext: access.ciphertext,
        accessNonce: access.nonce,
        accessTag: access.tag,
        refreshCiphertext: refresh.ciphertext,
        refreshNonce: refresh.nonce,
        refreshTag: refresh.tag,
        csrfTokenHash: started.csrf_token_hash,
      },
    })
  } catch {
    await markUnknownQuietly(database, sessionHash, generation)
    await revokeNewSession(revokeSession, {
      supabaseUrl,
      anonKey,
      accessToken: refreshed.accessToken,
    })
    throw new AccountSessionInspectError('unavailable')
  }

  if (saved !== 1) {
    await markUnknownQuietly(database, sessionHash, generation)
    await revokeNewSession(revokeSession, {
      supabaseUrl,
      anonKey,
      accessToken: refreshed.accessToken,
    })
    return { status: 'unknown' }
  }

  let extended

  try {
    extended = await extendAccountSessionIdleExpiry(database, {
      idHash: sessionHash,
    })
  } catch {
    throw new AccountSessionInspectError('unavailable')
  }

  if (extended !== 1) {
    return { status: 'unavailable' }
  }

  return {
    status: 'ready',
    userId,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    keyVersion: access.version,
  }
}

async function recoverAfterLostRefreshStart({ database, sessionHash, key }) {
  const inspected = await inspectAccountSession({
    database,
    sessionHash,
    key,
  })

  if (inspected?.status === 'pending') {
    return inspected
  }

  if (inspected?.status === 'stale_pending') {
    await markStaleQuietly(database, sessionHash)
    return inspected
  }

  return inspected
}

async function handleRefreshAuthFailure({
  database,
  sessionHash,
  generation,
  error,
}) {
  if (error instanceof RefreshAuthError && error.code === 'rejected') {
    try {
      await deleteAccountSession(database, sessionHash)
    } catch {
      throw new AccountSessionInspectError('unavailable')
    }

    return { status: 'expired' }
  }

  if (
    error instanceof RefreshAuthError &&
    (error.code === 'timeout' ||
      error.code === 'unavailable' ||
      error.code === 'invalid_response' ||
      error.code === 'configuration')
  ) {
    await markUnknownQuietly(database, sessionHash, generation)
    return { status: 'unknown' }
  }

  await markUnknownQuietly(database, sessionHash, generation)
  return { status: 'unknown' }
}

async function markUnknownQuietly(database, sessionHash, generation) {
  try {
    await markAccountSessionUnknown(database, {
      idHash: sessionHash,
      generation,
    })
  } catch {
    // The caller still returns a failure status. Cleanup may remove the row later.
  }
}

async function markStaleQuietly(database, sessionHash) {
  try {
    await markStalePendingUnknown(database, { idHash: sessionHash })
  } catch {
    // The caller still returns stale_pending / 401.
  }
}

async function revokeNewSession(revokeSession, input) {
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

function isRefreshedSession(value) {
  return (
    typeof value?.accessToken === 'string' &&
    value.accessToken.length > 0 &&
    typeof value?.refreshToken === 'string' &&
    value.refreshToken.length > 0 &&
    typeof value?.userId === 'string' &&
    value.userId.length > 0
  )
}
