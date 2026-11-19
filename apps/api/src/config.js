import { z } from 'zod'

const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
])
const DEV_DATABASE_USER = 'postgres'
const DEV_DATABASE_PASSWORD = 'postgres'
const PLACEHOLDER_SECRETS = new Set([
  'changeme',
  'example',
  'secret',
  'your-anon-key',
  'your-service-role-key',
])

const envSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    PORT: z.string().optional(),
    WEB_ORIGIN: z.string().optional(),
    DATABASE_URL: z.string().optional(),
    DATABASE_POOL_MAX: z.string().optional(),
    DATABASE_CONNECTION_TIMEOUT_MS: z.string().optional(),
    DATABASE_IDLE_TIMEOUT_MS: z.string().optional(),
    SUPABASE_URL: z.string().optional(),
    SUPABASE_ANON_KEY: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    P24_ENVIRONMENT: z.string().optional(),
    P24_MERCHANT_ID: z.string().optional(),
    P24_POS_ID: z.string().optional(),
    P24_CRC_KEY: z.string().optional(),
    P24_API_SECRET: z.string().optional(),
    P24_REQUEST_TIMEOUT_MS: z.string().optional(),
    P24_URL_RETURN: z.string().optional(),
    P24_URL_STATUS: z.string().optional(),
  })
  .strip()

function blankToUndefined(value) {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function readEnv(env) {
  return {
    NODE_ENV: blankToUndefined(env?.NODE_ENV),
    PORT: blankToUndefined(env?.PORT),
    WEB_ORIGIN: blankToUndefined(env?.WEB_ORIGIN),
    DATABASE_URL: blankToUndefined(env?.DATABASE_URL),
    DATABASE_POOL_MAX: blankToUndefined(env?.DATABASE_POOL_MAX),
    DATABASE_CONNECTION_TIMEOUT_MS: blankToUndefined(
      env?.DATABASE_CONNECTION_TIMEOUT_MS,
    ),
    DATABASE_IDLE_TIMEOUT_MS: blankToUndefined(env?.DATABASE_IDLE_TIMEOUT_MS),
    SUPABASE_URL: blankToUndefined(env?.SUPABASE_URL),
    SUPABASE_ANON_KEY: blankToUndefined(env?.SUPABASE_ANON_KEY),
    SUPABASE_SERVICE_ROLE_KEY: blankToUndefined(env?.SUPABASE_SERVICE_ROLE_KEY),
    P24_ENVIRONMENT: blankToUndefined(env?.P24_ENVIRONMENT),
    P24_MERCHANT_ID: blankToUndefined(env?.P24_MERCHANT_ID),
    P24_POS_ID: blankToUndefined(env?.P24_POS_ID),
    P24_CRC_KEY: blankToUndefined(env?.P24_CRC_KEY),
    P24_API_SECRET: blankToUndefined(env?.P24_API_SECRET),
    P24_REQUEST_TIMEOUT_MS: blankToUndefined(env?.P24_REQUEST_TIMEOUT_MS),
    P24_URL_RETURN: blankToUndefined(env?.P24_URL_RETURN),
    P24_URL_STATUS: blankToUndefined(env?.P24_URL_STATUS),
  }
}

function isLocalHost(hostname) {
  return LOCAL_HOSTS.has(hostname.toLowerCase())
}

function parseUrl(value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function hasNoExtraOriginParts(url) {
  return (
    !url.username &&
    !url.password &&
    (url.pathname === '' || url.pathname === '/') &&
    !url.search &&
    !url.hash
  )
}

function addIssue(ctx, field, reason) {
  ctx.addIssue({
    code: 'custom',
    path: [field],
    input: undefined,
    message: reason
      ? `Invalid configuration: ${field} ${reason}`
      : `Invalid configuration: ${field}`,
  })
}

function readBoundedInt(value, field, { fallback, min, max }, ctx) {
  const raw = value ?? String(fallback)

  if (!/^[0-9]+$/.test(raw)) {
    addIssue(ctx, field)
    return null
  }

  const parsed = Number(raw)

  if (parsed < min || parsed > max) {
    addIssue(ctx, field)
    return null
  }

  return parsed
}

function readPort(value, ctx) {
  const raw = value ?? '3001'

  if (!/^[0-9]+$/.test(raw)) {
    addIssue(ctx, 'PORT')
    return null
  }

  const port = Number(raw)

  if (port < 1 || port > 65535) {
    addIssue(ctx, 'PORT')
    return null
  }

  return port
}

function readOrigin(value, nodeEnv, ctx) {
  const raw =
    value ?? (nodeEnv === 'production' ? undefined : 'http://localhost:3000')

  if (!raw) {
    addIssue(ctx, 'WEB_ORIGIN', 'is required in production')
    return null
  }

  const url = parseUrl(raw)

  if (
    !url ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !hasNoExtraOriginParts(url)
  ) {
    addIssue(ctx, 'WEB_ORIGIN')
    return null
  }

  if (nodeEnv === 'production') {
    if (url.protocol !== 'https:') {
      addIssue(ctx, 'WEB_ORIGIN', 'must use HTTPS in production')
      return null
    }

    if (isLocalHost(url.hostname)) {
      addIssue(ctx, 'WEB_ORIGIN', 'must not use a local host in production')
      return null
    }
  }

  return url.origin
}

function readDatabaseUrl(value, nodeEnv, ctx) {
  if (!value) {
    if (nodeEnv === 'production') {
      addIssue(ctx, 'DATABASE_URL', 'is required in production')
    }

    return null
  }

  const url = parseUrl(value)
  const protocolOk =
    url && (url.protocol === 'postgres:' || url.protocol === 'postgresql:')

  if (!protocolOk || !url.hostname) {
    addIssue(ctx, 'DATABASE_URL')
    return null
  }

  const local = isLocalHost(url.hostname)
  const devCredential =
    decodeURIComponent(url.username) === DEV_DATABASE_USER &&
    decodeURIComponent(url.password) === DEV_DATABASE_PASSWORD

  if (nodeEnv === 'test' && !local) {
    addIssue(ctx, 'DATABASE_URL', 'must use a local host in test')
    return null
  }

  if (nodeEnv === 'production' && (local || devCredential)) {
    addIssue(
      ctx,
      'DATABASE_URL',
      'must not use a local development value in production',
    )
    return null
  }

  return value
}

function readSupabaseUrl(value, nodeEnv, ctx) {
  if (!value) {
    if (nodeEnv === 'production') {
      addIssue(ctx, 'SUPABASE_URL', 'is required in production')
    }

    return null
  }

  const url = parseUrl(value)

  if (
    !url ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !hasNoExtraOriginParts(url)
  ) {
    addIssue(ctx, 'SUPABASE_URL')
    return null
  }

  const local = isLocalHost(url.hostname)

  if (nodeEnv === 'test' && !local) {
    addIssue(ctx, 'SUPABASE_URL', 'must use a local host in test')
    return null
  }

  if (nodeEnv === 'production' && (url.protocol !== 'https:' || local)) {
    addIssue(
      ctx,
      'SUPABASE_URL',
      'must use HTTPS and a non-local host in production',
    )
    return null
  }

  return url.origin
}

function readOptionalSecret(value, field, nodeEnv, ctx) {
  if (!value) {
    return null
  }

  if (/\s/.test(value) || value.length < 20) {
    addIssue(ctx, field)
    return null
  }

  if (
    nodeEnv === 'production' &&
    PLACEHOLDER_SECRETS.has(value.toLowerCase())
  ) {
    addIssue(ctx, field, 'must not use a placeholder in production')
    return null
  }

  return value
}

const P24_API_BASE_URLS = {
  sandbox: 'https://sandbox.przelewy24.pl/api/v1',
  production: 'https://secure.przelewy24.pl/api/v1',
}
const P24_INT64_MAX = 9223372036854775807n
const P24_PLACEHOLDER_SECRETS = new Set([
  'changeme',
  'example',
  'secret',
  'password',
  'sandbox',
  'test',
  'crc',
])

function readP24Decimal(value, field, ctx) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,17}$/.test(value)) {
    addIssue(ctx, field)
    return null
  }

  let parsed

  try {
    parsed = BigInt(value)
  } catch {
    addIssue(ctx, field)
    return null
  }

  if (parsed > P24_INT64_MAX) {
    addIssue(ctx, field)
    return null
  }

  return value
}

function readP24Secret(value, field, nodeEnv, ctx) {
  if (
    typeof value !== 'string' ||
    value.length < 8 ||
    value.length > 512 ||
    /\s/.test(value)
  ) {
    addIssue(ctx, field)
    return null
  }

  if (
    nodeEnv === 'production' &&
    P24_PLACEHOLDER_SECRETS.has(value.toLowerCase())
  ) {
    addIssue(ctx, field, 'must not use a placeholder in production')
    return null
  }

  return value
}

function readP24Config(env, nodeEnv, ctx) {
  const identity = [
    ['P24_ENVIRONMENT', env.P24_ENVIRONMENT],
    ['P24_MERCHANT_ID', env.P24_MERCHANT_ID],
    ['P24_POS_ID', env.P24_POS_ID],
    ['P24_CRC_KEY', env.P24_CRC_KEY],
    ['P24_API_SECRET', env.P24_API_SECRET],
  ]
  const enabled = identity.some(([, value]) => value !== undefined)

  if (!enabled) {
    if (env.P24_REQUEST_TIMEOUT_MS !== undefined) {
      addIssue(
        ctx,
        'P24_REQUEST_TIMEOUT_MS',
        'requires the Przelewy24 configuration',
      )
    }

    if (env.P24_URL_RETURN !== undefined || env.P24_URL_STATUS !== undefined) {
      addIssue(ctx, 'P24_URL_RETURN', 'requires the Przelewy24 configuration')
    }

    return null
  }

  for (const [field, value] of identity) {
    if (value === undefined) {
      addIssue(ctx, field, 'is required')
    }
  }

  let environment = null

  if (
    env.P24_ENVIRONMENT === 'sandbox' ||
    env.P24_ENVIRONMENT === 'production'
  ) {
    environment = env.P24_ENVIRONMENT
  } else if (env.P24_ENVIRONMENT !== undefined) {
    addIssue(ctx, 'P24_ENVIRONMENT')
  }

  if (environment === 'sandbox' && nodeEnv === 'production') {
    addIssue(
      ctx,
      'P24_ENVIRONMENT',
      'must be production when NODE_ENV is production',
    )
    environment = null
  }

  if (environment === 'production' && nodeEnv !== 'production') {
    addIssue(ctx, 'P24_ENVIRONMENT', 'must be sandbox outside production')
    environment = null
  }

  const merchantId =
    env.P24_MERCHANT_ID === undefined
      ? null
      : readP24Decimal(env.P24_MERCHANT_ID, 'P24_MERCHANT_ID', ctx)
  const posId =
    env.P24_POS_ID === undefined
      ? null
      : readP24Decimal(env.P24_POS_ID, 'P24_POS_ID', ctx)
  const crcKey =
    env.P24_CRC_KEY === undefined
      ? null
      : readP24Secret(env.P24_CRC_KEY, 'P24_CRC_KEY', nodeEnv, ctx)
  const secretId =
    env.P24_API_SECRET === undefined
      ? null
      : readP24Secret(env.P24_API_SECRET, 'P24_API_SECRET', nodeEnv, ctx)
  const requestTimeoutMs = readBoundedInt(
    env.P24_REQUEST_TIMEOUT_MS,
    'P24_REQUEST_TIMEOUT_MS',
    { fallback: 10000, min: 1000, max: 60000 },
    ctx,
  )

  if (crcKey && secretId && crcKey === secretId) {
    addIssue(ctx, 'P24_CRC_KEY', 'must be different from P24_API_SECRET')
  }

  const urlReturn = readP24Url(
    env.P24_URL_RETURN,
    'P24_URL_RETURN',
    environment,
    ctx,
  )
  const urlStatus = readP24Url(
    env.P24_URL_STATUS,
    'P24_URL_STATUS',
    environment,
    ctx,
  )

  if (
    !environment ||
    !merchantId ||
    !posId ||
    !crcKey ||
    !secretId ||
    requestTimeoutMs === null ||
    !urlReturn.ok ||
    !urlStatus.ok
  ) {
    return null
  }

  return {
    environment,
    merchantId,
    posId,
    crcKey,
    secretId,
    apiBaseUrl: P24_API_BASE_URLS[environment],
    requestTimeoutMs,
    urlReturn: urlReturn.value,
    urlStatus: urlStatus.value,
  }
}

function readP24Url(value, field, environment, ctx) {
  if (value === undefined) {
    return { ok: true, value: null }
  }

  let url

  try {
    url = new URL(value)
  } catch {
    url = null
  }

  const protocolOk =
    url?.protocol === 'https:' ||
    (environment === 'sandbox' && url?.protocol === 'http:')

  if (!url || value.length > 250 || !protocolOk) {
    addIssue(
      ctx,
      field,
      'must be an absolute HTTPS URL of at most 250 characters',
    )
    return { ok: false, value: null }
  }

  return { ok: true, value }
}

const configSchema = envSchema.transform((env, ctx) => {
  const nodeEnv = env.NODE_ENV
  const nodeEnvOk =
    nodeEnv === 'development' || nodeEnv === 'test' || nodeEnv === 'production'

  if (!nodeEnvOk) {
    addIssue(ctx, 'NODE_ENV')
  }

  const resolvedEnv = nodeEnvOk ? nodeEnv : 'development'
  const port = readPort(env.PORT, ctx)
  const webOrigin = readOrigin(env.WEB_ORIGIN, resolvedEnv, ctx)
  const databaseUrl = readDatabaseUrl(env.DATABASE_URL, resolvedEnv, ctx)
  const databasePoolMax = readBoundedInt(
    env.DATABASE_POOL_MAX,
    'DATABASE_POOL_MAX',
    { fallback: 10, min: 1, max: 20 },
    ctx,
  )
  const databaseConnectionTimeoutMs = readBoundedInt(
    env.DATABASE_CONNECTION_TIMEOUT_MS,
    'DATABASE_CONNECTION_TIMEOUT_MS',
    { fallback: 5000, min: 100, max: 30000 },
    ctx,
  )
  const databaseIdleTimeoutMs = readBoundedInt(
    env.DATABASE_IDLE_TIMEOUT_MS,
    'DATABASE_IDLE_TIMEOUT_MS',
    { fallback: 10000, min: 1000, max: 120000 },
    ctx,
  )
  const supabaseUrl = readSupabaseUrl(env.SUPABASE_URL, resolvedEnv, ctx)
  const supabaseAnonKey = readOptionalSecret(
    env.SUPABASE_ANON_KEY,
    'SUPABASE_ANON_KEY',
    resolvedEnv,
    ctx,
  )
  const supabaseServiceRoleKey = readOptionalSecret(
    env.SUPABASE_SERVICE_ROLE_KEY,
    'SUPABASE_SERVICE_ROLE_KEY',
    resolvedEnv,
    ctx,
  )
  const p24 = readP24Config(env, resolvedEnv, ctx)

  return {
    nodeEnv: resolvedEnv,
    port: port ?? 3001,
    webOrigin: webOrigin ?? 'http://localhost:3000',
    databaseUrl,
    databasePoolMax: databasePoolMax ?? 10,
    databaseConnectionTimeoutMs: databaseConnectionTimeoutMs ?? 5000,
    databaseIdleTimeoutMs: databaseIdleTimeoutMs ?? 10000,
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceRoleKey,
    p24,
  }
})

function safeConfigError(error) {
  const messages = error.issues
    .map((issue) => issue.message)
    .filter((message) => message.startsWith('Invalid configuration:'))

  return new Error(messages.join('\n') || 'Invalid configuration')
}

export function loadConfig(env) {
  const parsed = configSchema.safeParse(readEnv(env))

  if (!parsed.success) {
    throw safeConfigError(parsed.error)
  }

  return parsed.data
}
