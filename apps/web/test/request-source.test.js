import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { checkRequestSource } from '../app/modules/request-source/check-request-source.js'
import { readCookieValue } from '../app/modules/request-source/read-cookie.js'

const allowed = 'https://shop.example'
const challengeId = randomBytes(32).toString('base64url')

describe('checkRequestSource', () => {
  it('accepts the exact allowed origin and ignores a bad referer', () => {
    assert.deepEqual(
      checkRequestSource({
        origin: allowed,
        referer: 'https://evil.example/login',
        allowedOrigin: allowed,
      }),
      { ok: true },
    )
  })

  it('accepts a referer with a path, query, and fragment when origin is absent', () => {
    assert.deepEqual(
      checkRequestSource({
        origin: undefined,
        referer: 'https://shop.example/login?next=1#form',
        allowedOrigin: allowed,
      }),
      { ok: true },
    )
  })

  it('rejects a missing source, a null origin, and a bad origin with a good referer', () => {
    assert.deepEqual(
      checkRequestSource({
        origin: null,
        referer: null,
        allowedOrigin: allowed,
      }),
      { ok: false, reason: 'invalid_source' },
    )
    assert.deepEqual(
      checkRequestSource({
        origin: 'null',
        referer: 'https://shop.example/login',
        allowedOrigin: allowed,
      }),
      { ok: false, reason: 'invalid_source' },
    )
    assert.deepEqual(
      checkRequestSource({
        origin: 'https://evil.example',
        referer: 'https://shop.example/login',
        allowedOrigin: allowed,
      }),
      { ok: false, reason: 'invalid_source' },
    )
  })

  it('rejects a different host, a lookalike host, another port, and another scheme', () => {
    for (const origin of [
      'https://shop.example.evil',
      'https://evil.shop.example',
      'https://shop.example:444',
      'http://shop.example',
    ]) {
      assert.deepEqual(
        checkRequestSource({
          origin,
          referer: undefined,
          allowedOrigin: allowed,
        }),
        { ok: false, reason: 'invalid_source' },
      )
    }
  })

  it('rejects an invalid header and an origin that is not canonical', () => {
    assert.equal(
      checkRequestSource({
        origin: 'not a url',
        referer: undefined,
        allowedOrigin: allowed,
      }).reason,
      'invalid_source',
    )
    assert.equal(
      checkRequestSource({
        origin: 'https://shop.example/login',
        referer: undefined,
        allowedOrigin: allowed,
      }).reason,
      'invalid_source',
    )

    for (const allowedOrigin of [
      'shop.example',
      'https://shop.example/login',
      'https://shop.example?next=1',
      'https://user:secret@shop.example',
      '*',
      '',
    ]) {
      const result = checkRequestSource({
        origin: allowed,
        referer: undefined,
        allowedOrigin,
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'invalid_config')
      assert.equal(JSON.stringify(result).includes('secret'), false)
      assert.equal(JSON.stringify(result).includes('shop.example'), false)
    }
  })
})

describe('readCookieValue', () => {
  it('reads one base64url challenge id among other cookies', () => {
    const header = `theme=light; mshop_login=${challengeId}; lang=pl`

    assert.deepEqual(readCookieValue(header, 'mshop_login'), {
      status: 'present',
      value: challengeId,
    })
    assert.deepEqual(readCookieValue(header, '__Host-mshop_login'), {
      status: 'absent',
    })
  })

  it('treats a header without the named cookie as absent', () => {
    assert.deepEqual(readCookieValue(undefined, 'mshop_login'), {
      status: 'absent',
    })
    assert.deepEqual(readCookieValue('', 'mshop_login'), { status: 'absent' })
    assert.deepEqual(readCookieValue('theme=light', 'mshop_login'), {
      status: 'absent',
    })
  })

  it('rejects duplicates, an empty value, a broken header, and bad encoding', () => {
    assert.equal(
      readCookieValue(
        `mshop_login=${challengeId}; mshop_login=${challengeId}`,
        'mshop_login',
      ).status,
      'rejected',
    )
    assert.equal(
      readCookieValue('mshop_login=', 'mshop_login').status,
      'rejected',
    )
    assert.equal(
      readCookieValue('mshop_login', 'mshop_login').status,
      'rejected',
    )
    assert.equal(
      readCookieValue('mshop_login=%ZZ', 'mshop_login').status,
      'rejected',
    )
  })

  it('rejects characters outside canonical base64url and does not echo them', () => {
    const padded = Buffer.from(challengeId, 'base64url').toString('base64')
    const result = readCookieValue(`mshop_login=${padded}`, 'mshop_login')

    assert.equal(result.status, 'rejected')
    assert.equal('value' in result, false)
    assert.equal(JSON.stringify(result).includes(padded), false)
    assert.equal(
      readCookieValue(`mshop_login=${challengeId}+`, 'mshop_login').status,
      'rejected',
    )
  })
})
