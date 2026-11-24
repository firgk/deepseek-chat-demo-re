import { HttpError } from './http.mjs'

export const SEARCH_POLICIES = Object.freeze({
  off: Object.freeze({ limit: 0, rounds: 0 }),
  low: Object.freeze({ limit: 5, rounds: 2 }),
  medium: Object.freeze({ limit: 8, rounds: 5 }),
  high: Object.freeze({ limit: 10, rounds: 10 }),
})

export function validateSearchStrength(value) {
  if (typeof value !== 'string' || !Object.hasOwn(SEARCH_POLICIES, value)) {
    throw new HttpError(400, 'Invalid search strength.')
  }
  return value
}
