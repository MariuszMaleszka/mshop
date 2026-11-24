export const LOGIN_MESSAGES = {
  validationEmail: 'Podaj adres e-mail.',
  validationPassword: 'Podaj hasło.',
  invalidCredentials: 'Nie udało się zalogować.',
  formExpired: 'Formularz logowania wygasł.',
  rateLimited: 'Spróbuj ponownie później.',
  unavailable: 'Logowanie jest chwilowo niedostępne.',
}

export function loginErrorMessage(status) {
  if (status === 401 || status === 400) {
    return LOGIN_MESSAGES.invalidCredentials
  }

  if (status === 403) {
    return LOGIN_MESSAGES.formExpired
  }

  if (status === 429) {
    return LOGIN_MESSAGES.rateLimited
  }

  return LOGIN_MESSAGES.unavailable
}

export function csrfErrorMessage(status) {
  if (status === 403) {
    return LOGIN_MESSAGES.formExpired
  }

  if (status === 429) {
    return LOGIN_MESSAGES.rateLimited
  }

  return LOGIN_MESSAGES.unavailable
}
