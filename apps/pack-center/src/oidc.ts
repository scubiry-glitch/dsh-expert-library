import * as oidc from 'openid-client'

export interface OidcConfig {
  issuer: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  /** Explicit test/development opt-in, never permits HTTP on non-loopback hosts. */
  allowLoopbackHttp?: boolean
}
export class IdentityError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 403) {
    super(message); this.name = 'IdentityError'; this.code = code; this.status = status
  }
}
function checkedUrl(value: string, allowLoopback: boolean): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new IdentityError('OIDC_CONFIG_INVALID', 'Invalid OIDC URL', 500) }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(allowLoopback && local && url.protocol === 'http:'))) {
    throw new IdentityError('OIDC_CONFIG_INVALID', 'OIDC requires HTTPS (explicit loopback development exception only)', 500)
  }
  return url
}

/** No token parsing/signature implementation of our own: the maintained certified
 * client validates code, state, PKCE, nonce, issuer, audience, time and JWS. */
export function createOidcClient(input: OidcConfig) {
  const allowLocal = input.allowLoopbackHttp === true
  const issuer = checkedUrl(input.issuer, allowLocal)
  const redirect = checkedUrl(input.redirectUri, allowLocal)
  if (issuer.search || redirect.search || !input.clientId || input.clientId.length > 512) {
    throw new IdentityError('OIDC_CONFIG_INVALID', 'OIDC issuer, client or callback configuration is invalid', 500)
  }
  let configuration: Promise<oidc.Configuration> | undefined
  async function config() {
    if (!configuration) configuration = oidc.discovery(issuer, input.clientId,
      { client_secret: input.clientSecret, id_token_signed_response_alg: 'RS256', [oidc.clockTolerance]: 0 },
      input.clientSecret ? oidc.ClientSecretPost(input.clientSecret) : oidc.None(), {
        execute: allowLocal ? [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks] : [oidc.enableNonRepudiationChecks],
        timeout: 10,
        [oidc.customFetch]: async (url, options) => {
          checkedUrl(String(url), allowLocal)
          return fetch(url, { ...options, redirect: 'error' } as RequestInit)
        },
      }).then(value => {
        const metadata = value.serverMetadata()
        if (metadata.issuer !== input.issuer) throw new IdentityError('OIDC_CONFIG_INVALID', 'Discovered issuer does not match configuration', 500)
        for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) {
          if (typeof endpoint !== 'string') throw new IdentityError('OIDC_CONFIG_INVALID', 'OIDC issuer is missing a required endpoint', 500)
          checkedUrl(endpoint, allowLocal)
        }
        return value
      }).catch(error => { configuration = undefined; throw error })
    return configuration
  }
  return {
    issuer: input.issuer,
    redirectUri: redirect.href,
    async authorizationUrl({ state, nonce, verifier }: { state: string; nonce: string; verifier: string }) {
      try {
        return oidc.buildAuthorizationUrl(await config(), {
          redirect_uri: redirect.href, scope: 'openid profile', response_type: 'code',
          state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
        }).href
      } catch { throw new IdentityError('OIDC_UNAVAILABLE', 'Identity provider is unavailable or incorrectly configured', 503) }
    },
    async finish({ callbackUrl, state, nonce, verifier }: { callbackUrl: string; state: string; nonce: string; verifier: string }) {
      try {
        const callback = new URL(callbackUrl)
        if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || callback.hash || callback.username || callback.password) throw new Error('Callback mismatch')
        const tokens = await oidc.authorizationCodeGrant(await config(), callback, {
          expectedState: state, expectedNonce: nonce, pkceCodeVerifier: verifier, idTokenExpected: true,
        })
        const claims = tokens.claims()
        if (!claims || claims.iss !== input.issuer || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 512) throw new Error('Identity missing')
        const displayName = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 200) : claims.sub.slice(0, 200)
        return { issuer: claims.iss, subject: claims.sub, displayName }
      } catch { throw new IdentityError('OIDC_LOGIN_FAILED', 'Identity provider response could not be verified', 401) }
    },
  }
}
