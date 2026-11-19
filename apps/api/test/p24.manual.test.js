import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadConfig } from '../src/config.js'
import { createP24Client } from '../src/p24/client.js'

const enabled = process.env.P24_MANUAL_TEST_ACCESS === '1'

describe('Przelewy24 manual sandbox access', { skip: !enabled }, () => {
  it('calls testAccess and does not register a transaction', async () => {
    const config = loadConfig(process.env)

    assert.equal(config.p24?.environment, 'sandbox')

    const result = await createP24Client(config.p24).testAccess()

    assert.deepEqual(result, { data: true })
  })
})
