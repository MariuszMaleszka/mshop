export function testAccessToken({
  exp,
  sub = '00000000-0000-4000-8000-000000000001',
} = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: 'none', typ: 'JWT' }),
  ).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ exp, sub })).toString(
    'base64url',
  )
  return `${header}.${payload}.test`
}

export function futureAccessToken(seconds = 3600, options = {}) {
  return testAccessToken({
    exp: Math.floor(Date.now() / 1000) + seconds,
    ...options,
  })
}

export function expiredAccessToken(secondsAgo = 60, options = {}) {
  return testAccessToken({
    exp: Math.floor(Date.now() / 1000) - secondsAgo,
    ...options,
  })
}
