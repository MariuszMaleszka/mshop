export function transactionPanelUrl(environment, token) {
  if (
    environment !== 'production' ||
    typeof token !== 'string' ||
    token.length < 1 ||
    token.length > 2048 ||
    /\s/.test(token)
  ) {
    return null
  }

  return `https://secure.przelewy24.pl/trnRequest/${encodeURIComponent(token)}`
}
