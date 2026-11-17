import { z } from 'zod'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])
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
    SUPABASE_URL: z.string().optional(),
    SUPABASE_ANON_KEY: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
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
    SUPABASE_URL: blankToUndefined(env?.SUPABASE_URL),
    SUPABASE_ANON_KEY: blankToUndefined(env?.SUPABASE_ANON_KEY),
    SUPABASE_SERVICE_ROLE_KEY: blankToUndefined(env?.SUPABASE_SERVICE_ROLE_KEY),
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
  const raw = value ?? (nodeEnv === 'production' ? undefined : 'http://localhost:3000')

  if (!raw) {
    addIssue(ctx, 'WEB_ORIGIN', 'is required in production')
    return null
  }

  const url = parseUrl(raw)

  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !hasNoExtraOriginParts(url)) {
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
  const protocolOk = url && (url.protocol === 'postgres:' || url.protocol === 'postgresql:')

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
    addIssue(ctx, 'DATABASE_URL', 'must not use a local development value in production')
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

  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !hasNoExtraOriginParts(url)) {
    addIssue(ctx, 'SUPABASE_URL')
    return null
  }

  const local = isLocalHost(url.hostname)

  if (nodeEnv === 'test' && !local) {
    addIssue(ctx, 'SUPABASE_URL', 'must use a local host in test')
    return null
  }

  if (nodeEnv === 'production' && (url.protocol !== 'https:' || local)) {
    addIssue(ctx, 'SUPABASE_URL', 'must use HTTPS and a non-local host in production')
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

  if (nodeEnv === 'production' && PLACEHOLDER_SECRETS.has(value.toLowerCase())) {
    addIssue(ctx, field, 'must not use a placeholder in production')
    return null
  }

  return value
}

const configSchema = envSchema.transform((env, ctx) => {
  const nodeEnv = env.NODE_ENV
  const nodeEnvOk = nodeEnv === 'development' || nodeEnv === 'test' || nodeEnv === 'production'

  if (!nodeEnvOk) {
    addIssue(ctx, 'NODE_ENV')
  }

  const resolvedEnv = nodeEnvOk ? nodeEnv : 'development'
  const port = readPort(env.PORT, ctx)
  const webOrigin = readOrigin(env.WEB_ORIGIN, resolvedEnv, ctx)
  const databaseUrl = readDatabaseUrl(env.DATABASE_URL, resolvedEnv, ctx)
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

  return {
    nodeEnv: resolvedEnv,
    port: port ?? 3001,
    webOrigin: webOrigin ?? 'http://localhost:3000',
    databaseUrl,
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceRoleKey,
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
