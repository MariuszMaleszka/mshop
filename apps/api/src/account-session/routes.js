import { issueLoginChallenge, LOGIN_CHALLENGE_PATH } from './issue-challenge.js'

export function registerLoginChallengeRoutes(app, dependencies) {
  app.post(LOGIN_CHALLENGE_PATH, async (request, response) => {
    const result = await issueLoginChallenge(request, dependencies)
    response.status(result.status).json(result.body)
  })
}
