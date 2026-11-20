import { createHash } from 'node:crypto'

const SESSION_COLUMNS = `
  id_hash,
  user_id,
  refresh_state,
  refresh_generation,
  refresh_started_at,
  refresh_token_hash,
  key_version,
  access_ciphertext,
  access_nonce,
  access_tag,
  refresh_ciphertext,
  refresh_nonce,
  refresh_tag,
  csrf_token_hash,
  absolute_expires_at,
  idle_expires_at,
  created_at,
  updated_at
`

export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export class AccountSessionWriteError extends Error {
  constructor(code) {
    super('Account session write rejected')
    this.name = 'AccountSessionWriteError'
    this.code = code
  }
}

export async function insertAccountSession(database, session) {
  try {
    await database.query(
      `
        insert into public.account_sessions (
          id_hash,
          user_id,
          refresh_state,
          refresh_generation,
          refresh_started_at,
          refresh_token_hash,
          key_version,
          access_ciphertext,
          access_nonce,
          access_tag,
          refresh_ciphertext,
          refresh_nonce,
          refresh_tag,
          csrf_token_hash,
          absolute_expires_at,
          idle_expires_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14, $15, $16
        )
      `,
      sessionValues(session),
    )
  } catch (error) {
    throw mapWriteError(error)
  }
}

export async function findAccountSession(database, idHash) {
  const result = await database.query(
    `
      select ${SESSION_COLUMNS}
      from public.account_sessions
      where id_hash = $1
    `,
    [idHash],
  )

  return result.rows[0] ?? null
}

export async function saveRefreshedSession(
  database,
  { idHash, generation, session },
) {
  try {
    const result = await database.query(
      `
        update public.account_sessions
        set
          refresh_state = 'ready',
          refresh_generation = null,
          refresh_started_at = null,
          refresh_token_hash = null,
          key_version = $3,
          access_ciphertext = $4,
          access_nonce = $5,
          access_tag = $6,
          refresh_ciphertext = $7,
          refresh_nonce = $8,
          refresh_tag = $9,
          csrf_token_hash = $10
        where id_hash = $1
          and refresh_generation = $2
          and refresh_state = 'pending'
          and refresh_started_at > now() - interval '15 seconds'
      `,
      [
        idHash,
        generation,
        session.keyVersion,
        session.accessCiphertext,
        session.accessNonce,
        session.accessTag,
        session.refreshCiphertext,
        session.refreshNonce,
        session.refreshTag,
        session.csrfTokenHash,
      ],
    )

    return result.rowCount
  } catch (error) {
    throw mapWriteError(error)
  }
}

export async function deleteAccountSession(database, idHash) {
  const result = await database.query(
    'delete from public.account_sessions where id_hash = $1',
    [idHash],
  )

  return result.rowCount
}

export async function insertLoginChallenge(database, challenge) {
  try {
    await database.query(
      `
        insert into public.login_challenges (
          id_hash,
          csrf_token_hash,
          expires_at
        )
        values ($1, $2, $3)
      `,
      [challenge.idHash, challenge.csrfTokenHash, challenge.expiresAt],
    )
  } catch (error) {
    throw mapWriteError(error)
  }
}

export async function consumeLoginChallenge(
  database,
  { idHash, csrfTokenHash },
) {
  try {
    const result = await database.query(
      `
        update public.login_challenges
        set consumed_at = now()
        where id_hash = $1
          and csrf_token_hash = $2
          and consumed_at is null
          and expires_at > now()
      `,
      [idHash, csrfTokenHash],
    )

    return result.rowCount
  } catch (error) {
    throw mapWriteError(error)
  }
}

export async function incrementAuthAttempt(
  database,
  { bucketHash, purpose, windowStart },
) {
  try {
    const result = await database.query(
      `
        insert into public.auth_attempt_counters (
          bucket_hash,
          purpose,
          window_start,
          count
        )
        values ($1, $2, $3, 1)
        on conflict (bucket_hash, purpose, window_start)
        do update set count = auth_attempt_counters.count + 1
        returning count
      `,
      [bucketHash, purpose, windowStart],
    )

    return result.rows[0].count
  } catch (error) {
    throw mapWriteError(error)
  }
}

function sessionValues(session) {
  return [
    session.idHash,
    session.userId,
    session.refreshState,
    session.refreshGeneration ?? null,
    session.refreshStartedAt ?? null,
    session.refreshTokenHash ?? null,
    session.keyVersion,
    session.accessCiphertext ?? null,
    session.accessNonce ?? null,
    session.accessTag ?? null,
    session.refreshCiphertext ?? null,
    session.refreshNonce ?? null,
    session.refreshTag ?? null,
    session.csrfTokenHash,
    session.absoluteExpiresAt,
    session.idleExpiresAt,
  ]
}

function mapWriteError(error) {
  if (error instanceof AccountSessionWriteError) {
    return error
  }

  if (
    error?.code === '23505' ||
    error?.code === '23514' ||
    error?.code === '23503'
  ) {
    return new AccountSessionWriteError('rejected')
  }

  return new AccountSessionWriteError('unavailable')
}
