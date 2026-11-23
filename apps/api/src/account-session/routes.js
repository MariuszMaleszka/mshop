import {
  handleDiscardLoginSession,
  DISCARD_LOGIN_SESSION_PATH,
} from './discard-login-session.js'
import { issueLoginChallenge, LOGIN_CHALLENGE_PATH } from './issue-challenge.js'
import { handleInternalLogin, INTERNAL_LOGIN_PATH } from './internal-login.js'

export function registerLoginChallengeRoutes(app, dependencies) {
  app.post(LOGIN_CHALLENGE_PATH, async (request, response) => {
    const result = await issueLoginChallenge(request, dependencies)
    response.status(result.status).json(result.body)
  })

  app.post(INTERNAL_LOGIN_PATH, async (request, response) => {
    const result = await handleInternalLogin(request, dependencies)
    response.status(result.status).json(result.body)
  })

  app.post(DISCARD_LOGIN_SESSION_PATH, async (request, response) => {
    const result = await handleDiscardLoginSession(request, dependencies)
    response.status(result.status).json(result.body)
  })
}
