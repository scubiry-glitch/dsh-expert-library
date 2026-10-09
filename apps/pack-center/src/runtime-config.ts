/** Process-specific configuration. Never log the returned values or secret bytes. */
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isIP } from 'node:net'
import { createPublicKey } from 'node:crypto'
import { parseSemVer } from '../../../packages/pack-contract/index.mjs'
import { loadConfig } from './config.js'
import type { OidcConfig } from './oidc.js'

export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value || value.includes('\0')) throw new Error(`${name} is required`)
  return value
}
export async function privateFile(path: string, maxBytes = 16384): Promise<Buffer> {
  if (!isAbsolute(path) || path.includes('\0') || await realpath(path) !== path) throw new Error('Credential file must be an absolute real path without symlinks')
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await fd.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maxBytes) || (before.mode & 0o077n) !== 0n
      || (process.geteuid && before.uid !== BigInt(process.geteuid()))) throw new Error('Credential file must be owned, private, bounded and regular')
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.byteLength) {
      const result = await fd.read(buffer, length, buffer.byteLength - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    const bytes = buffer.subarray(0, length)
    const after = await fd.stat({ bigint: true })
    if (bytes.byteLength !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Credential file changed while reading')
    return bytes
  } finally { await fd.close() }
}
export function allowedGitHosts(env: NodeJS.ProcessEnv): readonly string[] {
  const hosts = required(env, 'PACK_CENTER_GIT_ALLOWED_HOSTS').split(',').map(value => value.trim())
  if (hosts.length > 100 || hosts.some(host => host.length > 253 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z0-9]+$/.test(host) || isIP(host))) throw new Error('Git allowlist must contain exact lowercase DNS hostnames, not patterns or IP addresses')
  return [...new Set(hosts)]
}
export function developmentHttp(env: NodeJS.ProcessEnv): boolean {
  if (env.PACK_CENTER_ALLOW_LOOPBACK_HTTP !== undefined && !['true', 'false'].includes(env.PACK_CENTER_ALLOW_LOOPBACK_HTTP)) throw new Error('PACK_CENTER_ALLOW_LOOPBACK_HTTP must be true or false')
  return env.PACK_CENTER_ALLOW_LOOPBACK_HTTP === 'true'
}
export async function identityConfiguration(env: NodeJS.ProcessEnv) {
  const center = loadConfig(env)
  const loginEncryptionKey = await privateFile(required(env, 'PACK_CENTER_LOGIN_KEY_FILE'), 32)
  if (loginEncryptionKey.byteLength !== 32) throw new Error('Login key file must contain exactly 32 raw bytes')
  const oidc: OidcConfig = {
    issuer: required(env, 'PACK_CENTER_OIDC_ISSUER'), clientId: required(env, 'PACK_CENTER_OIDC_CLIENT_ID'),
    redirectUri: `${center.publicOrigin}/api/auth/callback`, allowLoopbackHttp: developmentHttp(env),
  }
  if (env.PACK_CENTER_OIDC_CLIENT_SECRET_FILE) {
    oidc.clientSecret = (await privateFile(env.PACK_CENTER_OIDC_CLIENT_SECRET_FILE)).toString('utf8').trimEnd()
    if (!oidc.clientSecret) throw new Error('OIDC client secret must not be empty')
  }
  return { center, loginEncryptionKey, oidc }
}
export async function scratchDirectory(env: NodeJS.ProcessEnv): Promise<string> {
  const path = required(env, 'PACK_CENTER_SCRATCH_ROOT')
  if (!isAbsolute(path) || await realpath(path) !== path) throw new Error('Scratch root must be an existing absolute real directory')
  const stat = await lstat(path)
  if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o700 || (process.geteuid && stat.uid !== process.geteuid())) throw new Error('Scratch root must be owned and private (0700)')
  return path
}
export function builtinPackVersions(env: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const text = env.PACK_CENTER_BUILTIN_VERSIONS ?? '{}'
  if (text.length > 65536) throw new Error('Built-in inventory is too large')
  let value: Record<string, string>
  try { value = JSON.parse(text) } catch { throw new Error('Built-in inventory must be a JSON object') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 1000) throw new Error('Built-in inventory must be a bounded object')
  for (const [id, version] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || id.includes('..') || ['constructor', 'prototype', '__proto__'].includes(id)) throw new Error('Invalid built-in identifier')
    parseSemVer(version)
  }
  return Object.freeze(value)
}

/** The reader process is provisioned with public trust material only. Keep the
 * file owner-controlled even though its contents are not secret. */
export async function trustedSigningKeys(env: NodeJS.ProcessEnv): Promise<Readonly<Record<string, string>>> {
  const bytes = await privateFile(required(env, 'PACK_CENTER_TRUSTED_SIGNING_KEYS_FILE'), 262144)
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Public signing key inventory must be JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).length > 100) throw new Error('Public signing key inventory must be a bounded nonempty object')
  const keys: Record<string, string> = Object.create(null)
  for (const [id, pem] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || id.includes('..') || ['constructor', 'prototype', '__proto__'].includes(id)) throw new Error('Invalid public key identifier')
    if (typeof pem !== 'string' || pem.length > 4096 || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(pem)) throw new Error('Expected public SPKI PEM only')
    const key = createPublicKey(pem)
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw new Error('Only Ed25519 public verification keys are supported')
    keys[id] = key.export({ type: 'spki', format: 'pem' }).toString()
  }
  return Object.freeze(keys)
}
