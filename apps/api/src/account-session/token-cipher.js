import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const TOKEN_CIPHER_KEY_BYTES = 32
export const TOKEN_CIPHER_NONCE_BYTES = 12
const TOKEN_CIPHER_TAG_BYTES = 16

export class TokenCipherError extends Error {
  constructor(code) {
    super('Token cipher failed')
    this.name = 'TokenCipherError'
    this.code = code
  }
}

export function encryptToken(
  plaintext,
  key,
  { version = 1, random = randomBytes } = {},
) {
  assertKey(key)
  assertVersion(version)

  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TokenCipherError('invalid_plaintext')
  }

  const nonce = random(TOKEN_CIPHER_NONCE_BYTES)

  if (!Buffer.isBuffer(nonce) || nonce.length !== TOKEN_CIPHER_NONCE_BYTES) {
    throw new TokenCipherError('invalid_nonce')
  }

  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(associatedData(version))
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])

  return {
    ciphertext,
    nonce,
    tag: cipher.getAuthTag(),
    version,
  }
}

export function decryptToken(sealed, key) {
  assertKey(key)

  if (!sealed || typeof sealed !== 'object') {
    throw new TokenCipherError('invalid_format')
  }

  assertVersion(sealed.version)

  if (
    !Buffer.isBuffer(sealed.ciphertext) ||
    sealed.ciphertext.length === 0 ||
    !Buffer.isBuffer(sealed.nonce) ||
    sealed.nonce.length !== TOKEN_CIPHER_NONCE_BYTES ||
    !Buffer.isBuffer(sealed.tag) ||
    sealed.tag.length !== TOKEN_CIPHER_TAG_BYTES
  ) {
    throw new TokenCipherError('invalid_format')
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce)
    decipher.setAAD(associatedData(sealed.version))
    decipher.setAuthTag(sealed.tag)
    return Buffer.concat([
      decipher.update(sealed.ciphertext),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new TokenCipherError('authentication_failed')
  }
}

function associatedData(version) {
  return Buffer.from(`mshop-session:${version}`, 'utf8')
}

function assertKey(key) {
  if (key == null) {
    throw new TokenCipherError('missing_key')
  }

  if (!Buffer.isBuffer(key) || key.length !== TOKEN_CIPHER_KEY_BYTES) {
    throw new TokenCipherError('invalid_key')
  }
}

function assertVersion(version) {
  if (!Number.isInteger(version) || version < 1) {
    throw new TokenCipherError('invalid_version')
  }
}
