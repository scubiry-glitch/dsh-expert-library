import * as oidc from 'openid-client'

/** OIDC library validates signature, issuer, audience, nonce, state and PKCE. */
export function createOidcClient({ issuer, clientId, redirectUri }) {
  const issuerUrl = new URL(issuer)
  const redirect = new URL(redirectUri)
  const safe = url => {
    const parsed = new URL(url)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    if (parsed.username || parsed.password || parsed.hash || (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))) throw new Error('unsafe OIDC endpoint')
    return parsed
  }
  safe(issuer); safe(redirectUri)
  let discovered
  async function config() {
    if (!discovered) discovered = oidc.discovery(issuerUrl, clientId,
      { id_token_signed_response_alg: 'RS256', [oidc.clockTolerance]: 0 }, oidc.None(), {
        execute: issuerUrl.protocol === 'http:' ? [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks] : [oidc.enableNonRepudiationChecks],
        timeout: 10,
        [oidc.customFetch]: async (url, options) => fetch(safe(String(url)), { ...options, redirect: 'error' }),
      }).then(value => {
        const metadata = value.serverMetadata()
        if (metadata.issuer !== issuer || !metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.jwks_uri) throw new Error('OIDC issuer mismatch')
        for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) safe(endpoint)
        return value
      }).catch(error => { discovered = undefined; throw error })
    return discovered
  }
  return {
    async start({ state, nonce, verifier }) {
      return oidc.buildAuthorizationUrl(await config(), {
        redirect_uri: redirect.href, response_type: 'code', scope: 'openid profile',
        state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
      }).href
    },
    async finish({ callbackUrl, state, nonce, verifier }) {
      const target = new URL(callbackUrl)
      if (target.origin !== redirect.origin || target.pathname !== redirect.pathname || target.hash) throw new Error('OIDC callback mismatch')
      const tokens = await oidc.authorizationCodeGrant(await config(), target, {
        expectedState: state, expectedNonce: nonce, pkceCodeVerifier: verifier, idTokenExpected: true,
      })
      const claims = tokens.claims()
      if (!claims || claims.iss !== issuer || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 512) throw new Error('OIDC identity unavailable')
      return { issuer: claims.iss, subject: claims.sub, displayName: typeof claims.name === 'string' ? claims.name.slice(0, 200) : claims.sub }
    },
  }
}
