import { LOGIN_MESSAGES } from './messages.js'

export function validateLoginForm({ email, password }) {
  const fields = {}

  if (typeof email !== 'string' || email.trim() === '') {
    fields.email = LOGIN_MESSAGES.validationEmail
  } else if (!isBasicEmail(email.trim())) {
    fields.email = LOGIN_MESSAGES.validationEmail
  }

  if (typeof password !== 'string' || password.length === 0) {
    fields.password = LOGIN_MESSAGES.validationPassword
  }

  return {
    ok: Object.keys(fields).length === 0,
    fields,
    email: typeof email === 'string' ? email : '',
    password: typeof password === 'string' ? password : '',
  }
}

function isBasicEmail(value) {
  const at = value.indexOf('@')

  return (
    at > 0 &&
    at === value.lastIndexOf('@') &&
    at < value.length - 1 &&
    !/\s/.test(value)
  )
}
