import { readAccessTokenExpiry } from './access-token-expiry.js'
import {
  AccountSessionInspectError,
  inspectAccountSession,
} from './inspect-account-session.js'
import { refreshAccountSession } from './refresh-account-session.js'
import {
  extendAccountSessionIdleExpiry,
  markStalePendingUnknown,
} from './repository.js'

export async function inspectAndExtendAccountSession(
  { database, sessionHash, key, rateLimitKey, supabaseUrl, anonKey } = {},
  dependencies = {},
) {
  const inspect = dependencies.inspect ?? inspectAccountSession
  const refresh = dependencies.refresh ?? refreshAccountSession
  const extendIdle = dependencies.extendIdle ?? extendAccountSessionIdleExpiry
  const markStale = dependencies.markStale ?? markStalePendingUnknown

  const inspected = await inspect({ database, sessionHash, key })

  if (inspected?.status === 'stale_pending') {
    try {
      await markStale(database, { idHash: sessionHash })
    } catch {
      throw new AccountSessionInspectError('unavailable')
    }

    return { status: 'stale_pending' }
  }

  if (inspected?.status !== 'ready') {
    return inspected
  }

  const expiry = readAccessTokenExpiry(inspected.accessToken)

  if (expiry.status === 'invalid') {
    return { status: 'invalid' }
  }

  if (expiry.status === 'expired') {
    return refresh(
      {
        database,
        sessionHash,
        key,
        rateLimitKey,
        supabaseUrl,
        anonKey,
        userId: inspected.userId,
        accessToken: inspected.accessToken,
        refreshToken: inspected.refreshToken,
        keyVersion: inspected.keyVersion,
      },
      dependencies,
    )
  }

  let updated

  try {
    updated = await extendIdle(database, {
      idHash: sessionHash,
    })
  } catch {
    throw new AccountSessionInspectError('unavailable')
  }

  if (updated !== 1) {
    return { status: 'unavailable' }
  }

  return {
    status: 'ready',
    userId: inspected.userId,
    accessToken: inspected.accessToken,
    refreshToken: inspected.refreshToken,
    keyVersion: inspected.keyVersion,
  }
}
