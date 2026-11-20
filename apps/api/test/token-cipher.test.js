import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  TOKEN_CIPHER_NONCE_BYTES,
  TokenCipherError,
  decryptToken,
  encryptToken,
} from '../src/account-session/token-cipher.js'

const key = randomBytes(32)

describe('token cipher', () => {
  it('decrypts a token sealed with a fresh nonce', () => {
    const first = encryptToken('access-one', key)
    const second = encryptToken('access-one', key)

    assert.equal(decryptToken(first, key), 'access-one')
    assert.equal(first.nonce.length, TOKEN_CIPHER_NONCE_BYTES)
    assert.equal(first.nonce.equals(second.nonce), false)
    assert.equal(first.ciphertext.equals(second.ciphertext), false)
  })

  it('rejects a different key, a changed field, and a missing key', () => {
    const sealed = encryptToken('refresh-one', key)
    const otherKey = randomBytes(32)

    assert.throws(() => decryptToken(sealed, otherKey), {
      name: 'TokenCipherError',
      code: 'authentication_failed',
    })
    assert.throws(() => decryptToken(sealed, null), {
      code: 'missing_key',
    })
    assert.throws(() => decryptToken(sealed, Buffer.alloc(16)), {
      code: 'invalid_key',
    })
    assert.throws(() => decryptToken({ version: 1 }, key), {
      code: 'invalid_format',
    })

    const changedCiphertext = Buffer.from(sealed.ciphertext)
    changedCiphertext[0] ^= 1
    assert.throws(
      () => decryptToken({ ...sealed, ciphertext: changedCiphertext }, key),
      { code: 'authentication_failed' },
    )

    const changedNonce = Buffer.from(sealed.nonce)
    changedNonce[0] ^= 1
    assert.throws(() => decryptToken({ ...sealed, nonce: changedNonce }, key), {
      code: 'authentication_failed',
    })

    const changedTag = Buffer.from(sealed.tag)
    changedTag[0] ^= 1
    assert.throws(() => decryptToken({ ...sealed, tag: changedTag }, key), {
      code: 'authentication_failed',
    })
  })

  it('does not put plaintext into the error', () => {
    const plaintext = 'secret-token-value'
    let caught = null

    try {
      encryptToken(plaintext, Buffer.alloc(16))
    } catch (error) {
      caught = error
    }

    assert.ok(caught instanceof TokenCipherError)
    assert.equal(String(caught.message).includes(plaintext), false)
    assert.equal(String(caught.stack).includes(plaintext), false)
  })
})
