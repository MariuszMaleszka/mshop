import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readAccessTokenExpiry } from '../src/account-session/access-token-expiry.js'
import { expiredAccessToken, futureAccessToken } from './helpers/test-jwt.js'

describe('readAccessTokenExpiry', () => {
  it('classifies valid, expired, and invalid access tokens', () => {
    assert.equal(readAccessTokenExpiry(futureAccessToken(60)).status, 'valid')
    assert.equal(
      readAccessTokenExpiry(expiredAccessToken(60)).status,
      'expired',
    )
    assert.equal(readAccessTokenExpiry('not-a-jwt').status, 'invalid')
    assert.equal(readAccessTokenExpiry('').status, 'invalid')
  })
})
