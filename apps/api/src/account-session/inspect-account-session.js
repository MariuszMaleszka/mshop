import { decryptToken, TokenCipherError } from './token-cipher.js'
import { findAccountSessionClock } from './repository.js'

const SESSION_HASH = /^[0-9a-f]{64}$/
const TOKEN_NONCE_BYTES = 12
const TOKEN_TAG_BYTES = 16

export class AccountSessionInspectError extends Error {
  constructor(code) {
    super('Account session inspection failed')
    this.name = 'AccountSessionInspectError'
    this.code = code
  }
}

export async function inspectAccountSession({
  database,
  sessionHash,
  key,
} = {}) {
  if (typeof sessionHash !== 'string' || !SESSION_HASH.test(sessionHash)) {
    throw new AccountSessionInspectError('rejected')
  }

  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new AccountSessionInspectError('rejected')
  }

  if (!database || typeof database.query !== 'function') {
    throw new AccountSessionInspectError('unavailable')
  }

  let row

  try {
    row = await findAccountSessionClock(database, sessionHash)
  } catch (error) {
    if (error instanceof AccountSessionInspectError) {
      throw error
    }

    throw new AccountSessionInspectError('unavailable')
  }

  if (!row) {
    return { status: 'not_found' }
  }

  if (!isBoolean(row.absolute_valid) || !isBoolean(row.idle_valid)) {
    return { status: 'invalid' }
  }

  if (row.absolute_valid !== true || row.idle_valid !== true) {
    return { status: 'expired' }
  }

  if (row.refresh_state === 'pending') {
    if (row.pending_fresh === true) {
      return { status: 'pending' }
    }

    if (row.pending_fresh === false) {
      return { status: 'stale_pending' }
    }

    return { status: 'invalid' }
  }

  if (row.refresh_state === 'unknown') {
    return { status: 'unknown' }
  }

  if (row.refresh_state !== 'ready') {
    return { status: 'invalid' }
  }

  try {
    const accessToken = openToken(row, 'access', key)
    const refreshToken = openToken(row, 'refresh', key)

    if (
      !accessToken ||
      !refreshToken ||
      typeof row.user_id !== 'string' ||
      row.user_id.length === 0 ||
      !Number.isInteger(row.key_version)
    ) {
      return { status: 'invalid' }
    }

    return {
      status: 'ready',
      userId: row.user_id,
      accessToken,
      refreshToken,
      keyVersion: row.key_version,
    }
  } catch (error) {
    if (error instanceof TokenCipherError) {
      return { status: 'invalid' }
    }

    throw new AccountSessionInspectError('unavailable')
  }
}

function openToken(row, prefix, key) {
  const ciphertext = row[`${prefix}_ciphertext`]
  const nonce = row[`${prefix}_nonce`]
  const tag = row[`${prefix}_tag`]

  if (
    !Buffer.isBuffer(ciphertext) ||
    ciphertext.length === 0 ||
    !Buffer.isBuffer(nonce) ||
    nonce.length !== TOKEN_NONCE_BYTES ||
    !Buffer.isBuffer(tag) ||
    tag.length !== TOKEN_TAG_BYTES
  ) {
    return null
  }

  try {
    const plaintext = decryptToken(
      {
        ciphertext,
        nonce,
        tag,
        version: row.key_version,
      },
      key,
    )

    return typeof plaintext === 'string' && plaintext.length > 0
      ? plaintext
      : null
  } catch (error) {
    if (error instanceof TokenCipherError) {
      return null
    }

    throw error
  }
}

function isBoolean(value) {
  return value === true || value === false
}
