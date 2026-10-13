function parseOrigin(value, name, { allowLocalHttp = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`)
  let parsed
  try { parsed = new URL(value) } catch { throw new Error(`${name} must be an absolute URL`) }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(allowLocalHttp && local && parsed.protocol === 'http:')) {
    throw new Error(`${name} must use HTTPS${allowLocalHttp ? ' (except loopback)' : ''}`)
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error(`${name} must be an origin without credentials, path, query or fragment`)
  }
  return parsed.origin
}

function parseBackend(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('DSH_BACKEND_URL is required')
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('DSH_BACKEND_URL must be an absolute URL') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('DSH_BACKEND_URL must be an HTTP(S) origin without credentials, path, query or fragment')
  }
  return parsed.origin
}

function parseIssuer(value) {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('OIDC_ISSUER must be an absolute URL') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))) {
    throw new Error('OIDC_ISSUER must use HTTPS (except loopback) without credentials or query')
  }
  return parsed.href.replace(/\/$/, '')
}

export function readConfig(env = process.env) {
  const publicOrigin = parseOrigin(env.PUBLIC_ORIGIN ?? 'https://zhijian.meizu.life', 'PUBLIC_ORIGIN', { allowLocalHttp: true })
  const dshBackendUrl = parseBackend(env.DSH_BACKEND_URL)
  let extraBackends = {}
  if (env.DSH_BACKENDS_JSON) {
    try { extraBackends = JSON.parse(env.DSH_BACKENDS_JSON) } catch { throw new Error('DSH_BACKENDS_JSON must be JSON') }
    if (!extraBackends || Array.isArray(extraBackends) || typeof extraBackends !== 'object') throw new Error('DSH_BACKENDS_JSON must be an object')
  }
  const dshBackends = { default: dshBackendUrl }
  for (const [key, value] of Object.entries(extraBackends)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key) || key === 'default') throw new Error('invalid DSH backend name')
    dshBackends[key] = parseBackend(value)
  }
  if (new Set(Object.values(dshBackends)).size !== Object.keys(dshBackends).length) throw new Error('DSH backend origins must be unique per account deployment')
  const port = Number(env.PORT ?? 18460)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535')
  const host = env.HOST ?? '127.0.0.1'
  if (!['127.0.0.1', '::1', '0.0.0.0', '::'].includes(host)) throw new Error('HOST must be a local or explicitly exposed bind address')
  const oidcIssuer = env.OIDC_ISSUER ? parseIssuer(env.OIDC_ISSUER) : undefined
  const oidcClientId = env.OIDC_CLIENT_ID || undefined
  const accountDbPath = env.ACCOUNT_DB_PATH || undefined
  const gatewayTokenDir = env.DSH_GATEWAY_TOKEN_DIR || undefined
  const modelUsageUrl = env.MODEL_USAGE_URL || undefined
  const modelUsageTokenFile = env.MODEL_USAGE_TOKEN_FILE || undefined
  if ([oidcIssuer, oidcClientId, accountDbPath].some(Boolean) && ![oidcIssuer, oidcClientId, accountDbPath].every(Boolean)) {
    throw new Error('OIDC_ISSUER, OIDC_CLIENT_ID and ACCOUNT_DB_PATH must be set together')
  }
  if (accountDbPath && (!accountDbPath.startsWith('/') || accountDbPath.includes('\0'))) throw new Error('ACCOUNT_DB_PATH must be an absolute path')
  if (gatewayTokenDir && (!gatewayTokenDir.startsWith('/') || gatewayTokenDir.includes('\0'))) throw new Error('DSH_GATEWAY_TOKEN_DIR must be an absolute path')
  if (modelUsageUrl || modelUsageTokenFile) {
    if (!modelUsageUrl || !modelUsageTokenFile) throw new Error('MODEL_USAGE_URL and MODEL_USAGE_TOKEN_FILE must be set together')
    const usage = new URL(modelUsageUrl)
    if (usage.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(usage.hostname)
      || usage.username || usage.password || usage.pathname !== '/' || usage.search || usage.hash) throw new Error('MODEL_USAGE_URL must be a loopback HTTP origin')
    if (!modelUsageTokenFile.startsWith('/') || modelUsageTokenFile.includes('\0')) throw new Error('MODEL_USAGE_TOKEN_FILE must be an absolute path')
  }
  const researchEnabledBackends = env.RESEARCH_ENABLED_BACKENDS
    ? env.RESEARCH_ENABLED_BACKENDS.split(',').map(value => value.trim()) : []
  if (new Set(researchEnabledBackends).size !== researchEnabledBackends.length
    || researchEnabledBackends.some(value => value === 'default' || !Object.hasOwn(extraBackends, value))
    || (researchEnabledBackends.length && !gatewayTokenDir)) {
    throw new Error('RESEARCH_ENABLED_BACKENDS requires distinct configured customer backends and DSH_GATEWAY_TOKEN_DIR')
  }
  return Object.freeze({ publicOrigin, dshBackendUrl, dshBackends: Object.freeze(dshBackends), host, port,
    oidcIssuer, oidcClientId, accountDbPath, gatewayTokenDir, modelUsageUrl, modelUsageTokenFile,
    researchEnabledBackends: Object.freeze(researchEnabledBackends) })
}
