import { readFile } from 'node:fs/promises'

/** Passwords stay in the existing deployment credential directory; cookies stay in memory. */
export class CenterSession {
  constructor(origin, subject, credentialDir) {
    this.origin = new URL(origin).origin
    this.subject = subject
    this.credentialDir = credentialDir
    this.cookies = new Map()
    if (!/^[a-zA-Z0-9_-]+$/.test(subject)) throw Error('INVALID_SUBJECT')
  }
  async raw(path, method = 'GET', body, key, form = false) {
    const url = new URL(path, this.origin)
    if (url.origin !== this.origin) throw Error('CROSS_ORIGIN_AUTH_REDIRECT')
    const csrf = [...this.cookies].find(([k]) => k.endsWith('-csrf'))?.[1]
    const r = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(30000),
      headers: { Origin: this.origin, Cookie: [...this.cookies].map(([k,v]) => `${k}=${v}`).join('; '),
        ...(csrf ? {'X-CSRF-Token': csrf} : {}), ...(key ? {'Idempotency-Key': key} : {}),
        ...(body === undefined ? {} : {'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json'}) },
      ...(body === undefined ? {} : {body: form ? body : JSON.stringify(body)}) })
    for (const line of r.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0], i = pair.indexOf('=')
      if (i > 0) this.cookies.set(pair.slice(0,i), pair.slice(i+1))
    }
    return r
  }
  async call(path, method = 'GET', body, key) {
    const r = await this.raw(path, method, body, key)
    const d = await r.json().catch(() => null)
    if (!r.ok) throw Error(`CENTER_HTTP_${r.status}:${d?.error?.code ?? 'INVALID_RESPONSE'}`)
    return d
  }
  async login() {
    const password = (await readFile(`${this.credentialDir}/${this.subject}.pw`, 'utf8')).trim()
    const begin = await this.call('/api/auth/login', 'POST', {})
    const page = await this.raw(begin.authorizationUrl)
    const pending = /name="?pending"?\s+value="([^"]+)"/.exec(await page.text())?.[1]
    if (!pending) throw Error('OIDC_FORM_UNAVAILABLE')
    const r = await this.raw('/oidc/authorize', 'POST', new URLSearchParams({pending, username:this.subject, password}), undefined, true)
    const location = r.headers.get('location')
    if (!location || r.status !== 302) throw Error('OIDC_LOGIN_FAILED')
    const callback = await this.raw(location)
    if (!callback.ok && callback.status !== 302 && callback.status !== 303) throw Error('OIDC_CALLBACK_FAILED')
    this.principal = (await this.call('/api/me')).principal
    if (!this.principal) throw Error('CENTER_LOGIN_REQUIRED')
    return this
  }
  async logout() { if (this.principal) await this.call('/api/auth/logout', 'POST', {}).catch(() => {}); this.cookies.clear() }
}
