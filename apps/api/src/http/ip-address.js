import { isIP } from 'node:net'

// Keep identical to apps/web/server/utils/ip-address.js.

export function canonicalIpAddress(value) {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  const kind = isIP(trimmed)

  if (kind === 4) {
    return canonicalIpv4(trimmed)
  }

  if (kind === 6) {
    return canonicalIpv6(trimmed)
  }

  return null
}

function canonicalIpv4(value) {
  const parts = value.split('.')

  if (parts.some((part) => !/^[0-9]{1,3}$/.test(part))) {
    return null
  }

  return parts.map((part) => String(Number(part))).join('.')
}

function canonicalIpv6(value) {
  const lower = value.toLowerCase()

  if (lower.includes('%')) {
    return null
  }

  const groups = expandIpv6(lower)

  if (!groups) {
    return null
  }

  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    return [
      groups[6] >> 8,
      groups[6] & 255,
      groups[7] >> 8,
      groups[7] & 255,
    ].join('.')
  }

  return compressIpv6(groups)
}

function expandIpv6(value) {
  const lastColon = value.lastIndexOf(':')
  const tail = value.slice(lastColon + 1)
  const hasIpv4 = tail.includes('.')
  const head = hasIpv4 ? value.slice(0, lastColon) : value
  const halves = head.split('::')

  if (halves.length > 2) {
    return null
  }

  const parse = (text) => {
    if (text === '') {
      return []
    }

    const groups = []

    for (const part of text.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) {
        return null
      }

      groups.push(Number.parseInt(part, 16))
    }

    return groups
  }

  const left = parse(halves[0])
  const right = halves.length === 2 ? parse(halves[1]) : []

  if (!left || !right) {
    return null
  }

  const mapped = hasIpv4 ? ipv4Groups(tail) : []

  if (!mapped) {
    return null
  }

  const present = left.length + right.length + mapped.length

  if (halves.length === 1) {
    if (present !== 8) {
      return null
    }

    return [...left, ...mapped]
  }

  if (present >= 8) {
    return null
  }

  return [...left, ...new Array(8 - present).fill(0), ...right, ...mapped]
}

function ipv4Groups(value) {
  const canonical = canonicalIpv4(value)

  if (!canonical) {
    return null
  }

  const numbers = canonical.split('.').map(Number)
  return [(numbers[0] << 8) | numbers[1], (numbers[2] << 8) | numbers[3]]
}

function compressIpv6(groups) {
  let bestStart = -1
  let bestLength = 0
  let runStart = -1

  for (let index = 0; index <= groups.length; index += 1) {
    if (index < groups.length && groups[index] === 0) {
      if (runStart < 0) {
        runStart = index
      }
      continue
    }

    if (runStart < 0) {
      continue
    }

    const length = index - runStart

    if (length > bestLength) {
      bestStart = runStart
      bestLength = length
    }

    runStart = -1
  }

  const hex = groups.map((group) => group.toString(16))

  if (bestLength < 2) {
    return hex.join(':')
  }

  const left = hex.slice(0, bestStart).join(':')
  const right = hex.slice(bestStart + bestLength).join(':')
  return `${left}::${right}`
}
