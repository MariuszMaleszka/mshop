import {
  createGuestSessionId,
  guestSessionCookieOptions,
  GUEST_SESSION_COOKIE,
  readGuestSessionId,
} from './guest-session.js'

export function registerGuestSessionRoutes(app, { nodeEnv }) {
  app.post('/api/v1/session/guest', (req, res) => {
    const current = readGuestSessionId(req.get('cookie'))
    const sessionId = current ?? createGuestSessionId()

    res.cookie(
      GUEST_SESSION_COOKIE,
      sessionId,
      guestSessionCookieOptions(nodeEnv),
    )
    res.status(200).json({
      data: { authenticated: false },
      meta: {},
    })
  })
}
