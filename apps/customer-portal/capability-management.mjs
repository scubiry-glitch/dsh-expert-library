import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const base = '/plugins/dsh-expert-library'
const reads = Object.freeze({
  health: '/health?probe=all', packs: '/packs', 'pack-preview': '/packs', experts: '/experts', skills: '/skills',
  'managed-experts': '/manage/experts', 'managed-scenarios': '/manage/scenarios',
  'center-connection': '/manage/center/connection', 'center-catalog': '/manage/center/catalog',
  'center-installations': '/manage/center/installations', 'center-updates': '/manage/center/updates',
  'center-update-policy': '/manage/center/update-policy', 'center-operations': '/manage/center/operations',
})
const writes = Object.freeze({
  'managed-experts': { PUT: '/manage/experts', DELETE: '/manage/experts' },
  'managed-scenarios': { PUT: '/manage/scenarios', DELETE: '/manage/scenarios' },
  'center-check-updates': { POST: '/manage/center/check-updates' },
  'center-operations': { POST: '/manage/center/operations' },
  'center-bind': { POST: '/manage/center/bind' },
  'center-unbind': { POST: '/manage/center/unbind' },
})
const managedId = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const packId = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u

/** Account-bound, fixed-route adapter. Call only after browser admin and CSRF checks. */
export function createCapabilityManagement(config, fetcher = fetch) {
  function endpoint(runtime) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(runtime.backendRef)
      || config.dshBackends?.[runtime.backendRef] !== runtime.origin
      || !config.researchEnabledBackends?.includes(runtime.backendRef)) throw new Error('CAPABILITY_BACKEND_UNAVAILABLE')
    const origin = new URL(runtime.origin)
    if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))
      throw new Error('CAPABILITY_BACKEND_NOT_LOCAL')
  }
  async function token(runtime) {
    const value = (await readFile(join(config.gatewayTokenDir, `${runtime.backendRef}.token`), 'utf8')).trim()
    if (value.length < 32) throw new Error('CAPABILITY_BACKEND_UNAVAILABLE')
    return value
  }
  async function call(runtime, method, name, body, id) {
    endpoint(runtime)
    const path = method === 'GET' ? reads[name] : writes[name]?.[method]
    if (!path) throw new Error('CAPABILITY_ROUTE_UNKNOWN')
    if (id !== undefined && (!(name === 'pack-preview' ? packId : managedId).test(id) || id.includes('..')
      || !(method === 'GET' && name === 'pack-preview')
        && !(method === 'DELETE' && ['managed-experts', 'managed-scenarios'].includes(name))))
      throw new Error('CAPABILITY_INVALID_ID')
    if (name === 'pack-preview' && id === undefined) throw new Error('CAPABILITY_INVALID_ID')
    const secret = await token(runtime)
    const target = new URL(`${base}${path}${id === undefined ? '' : `?id=${encodeURIComponent(id)}`}`, runtime.origin)
    const response = await fetcher(target, { method, redirect: 'manual', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${secret}`, 'x-pack-center-ui': '1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const raw = await response.text()
    if (raw.length > 2_000_000) throw new Error('CAPABILITY_RESPONSE_TOO_LARGE')
    let data
    try { data = JSON.parse(raw) } catch { throw new Error('CAPABILITY_RESPONSE_INVALID') }
    return { status: response.status, data }
  }
  async function uploadSkill(runtime, id, data) {
    endpoint(runtime)
    if (!managedId.test(id) || id.includes('..') || typeof data !== 'string'
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length > 22_400_000) throw new Error('CAPABILITY_INVALID_SKILL')
    const bytes = Buffer.from(data, 'base64')
    if (!bytes.length || bytes.length > 16 * 1024 * 1024 || bytes.toString('base64') !== data) throw new Error('CAPABILITY_INVALID_SKILL')
    const form = new FormData()
    form.set('id', id)
    form.set('zip', new Blob([bytes], { type: 'application/zip' }), `${id}.zip`)
    const secret = await token(runtime)
    const response = await fetcher(new URL(`${base}/manage/skills`, runtime.origin), {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${secret}` }, body: form })
    const raw = await response.text()
    if (raw.length > 2_000_000) throw new Error('CAPABILITY_RESPONSE_TOO_LARGE')
    let result
    try { result = JSON.parse(raw) } catch { throw new Error('CAPABILITY_RESPONSE_INVALID') }
    return { status: response.status, data: result }
  }
  return { call, uploadSkill, readable: name => Object.hasOwn(reads, name), writable: (name, method) => !!writes[name]?.[method] }
}
