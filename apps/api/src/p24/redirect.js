const PANEL_ORIGINS = {
  sandbox: 'https://sandbox.przelewy24.pl',
  production: 'https://secure.przelewy24.pl',
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/

export function transactionPanelUrl(environment, token) {
  const origin = PANEL_ORIGINS[environment]

  if (!origin || typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    return null
  }

  const url = new URL(`/trnRequest/${token}`, origin)

  if (
    url.origin !== origin ||
    url.pathname !== `/trnRequest/${token}` ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return null
  }

  return url.href
}
