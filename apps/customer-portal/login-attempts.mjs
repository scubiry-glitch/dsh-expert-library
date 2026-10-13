import { createHash, randomBytes } from 'node:crypto'

const hash = value => createHash('sha256').update(value).digest('hex')
const token = () => randomBytes(32).toString('base64url')

/** Bounded, single-use, browser-bound OIDC attempts. Restart only expires pending logins. */
export function createLoginAttempts(now = () => Date.now()) {
  const attempts = new Map()
  return {
    begin() {
      for (const [key, value] of attempts) if (value.expiresAt <= now()) attempts.delete(key)
      if (attempts.size >= 1000) throw new Error('too many pending logins')
      const state = token(), browser = token(), nonce = token(), verifier = token()
      attempts.set(hash(state), { browserHash: hash(browser), nonce, verifier, expiresAt: now() + 10 * 60 * 1000 })
      return { state, browser, nonce, verifier }
    },
    take(state, browser) {
      if (typeof state !== 'string' || typeof browser !== 'string') return undefined
      const key = hash(state), value = attempts.get(key)
      if (!value || value.browserHash !== hash(browser)) return undefined
      attempts.delete(key)
      return value.expiresAt > now() ? { state, nonce: value.nonce, verifier: value.verifier } : undefined
    },
  }
}
