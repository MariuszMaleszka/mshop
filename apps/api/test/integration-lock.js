import pg from 'pg'

const INTEGRATION_LOCK_NAMESPACE = 71099
const INTEGRATION_LOCK_KEY = 1

export async function holdIntegrationDatabase(connectionString) {
  const client = new pg.Client({ connectionString })
  await client.connect()
  await client.query('SELECT pg_advisory_lock($1::integer, $2::integer)', [
    INTEGRATION_LOCK_NAMESPACE,
    INTEGRATION_LOCK_KEY,
  ])
  let releasing = null

  return function release() {
    if (!releasing) {
      releasing = client
        .query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [
          INTEGRATION_LOCK_NAMESPACE,
          INTEGRATION_LOCK_KEY,
        ])
        .finally(() => client.end())
    }

    return releasing
  }
}
