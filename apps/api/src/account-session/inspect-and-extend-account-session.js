import {
  AccountSessionInspectError,
  inspectAccountSession,
} from './inspect-account-session.js'
import { extendAccountSessionIdleExpiry } from './repository.js'

export async function inspectAndExtendAccountSession({
  database,
  sessionHash,
  key,
} = {}) {
  const inspected = await inspectAccountSession({ database, sessionHash, key })

  if (inspected?.status !== 'ready') {
    return inspected
  }

  let updated

  try {
    updated = await extendAccountSessionIdleExpiry(database, {
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
