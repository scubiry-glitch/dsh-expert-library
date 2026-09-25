/** Host-only transport: no browser credentials, redirects, proxy discovery, or retries. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { dirname, isAbsolute, resolve } from 'node:path'

export interface PackCenterTransportOptions {
  origin: string
  /** Test-only HTTP, restricted to canonical localhost / loopback literals. */
  allowLoopbackHttp?: boolean
  timeoutMs?: number
  maxJsonBytes?: number
  /** Test CA, accepted only for loopback HTTPS. TLS verification stays enabled. */
  testCa?: string
}
export interface PackCenterJsonOptions {
  method?: 'GET' | 'POST'
  credentialToken?: string
  body?: unknown
  signal?: AbortSignal
}
export interface PackCenterDownloadOptions {
  credentialToken: string
  downloadGrant: string
  expectedSha256: string
  expectedBytes: number
  maxBytes?: number
  signal?: AbortSignal
}

/** Deliberately excludes raw network errors, URLs, remote messages, and causes. */
export class PackCenterTransportError extends Error {
  readonly code: string
  readonly status?: number
  constructor(code: string, status?: number) {
    super(code)
    this.name = 'PackCenterTransportError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

const error = (code: string, status?: number) => new PackCenterTransportError(code, status)
const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const safeId = (value: string) => identifier.test(value) && !value.includes('..') && !['__proto__', 'constructor', 'prototype'].includes(value)
const safeRemoteCodes = new Set([
  'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'INVALID_INPUT', 'BINDING_CODE_INVALID',
  'DEPLOYMENT_DISABLED', 'DOWNLOAD_GRANT_INVALID', 'DOWNLOAD_GRANT_REQUIRED',
  'RELEASE_YANKED', 'RELEASE_INTEGRITY', 'DEPENDENCY_UNAVAILABLE', 'RATE_LIMITED',
])

export function normalizePackCenterOrigin(origin: string, allowLoopbackHttp = false): string {
  if (typeof origin !== 'string' || origin.length > 2048 || !/^https?:\/\/[^/?#\s\\%]+\/?$/i.test(origin)) throw error('CENTER_INVALID_ORIGIN')
  let url: URL
  try { url = new URL(origin) } catch { throw error('CENTER_INVALID_ORIGIN') }
  const authority = /^https?:\/\/([^/]+)\/?$/i.exec(origin)?.[1]
  const host = authority?.replace(/:[0-9]+$/, '').toLowerCase()
  // Comparing the raw authority rejects alternate numeric IPv4 spellings and URL-parser repair.
  if (!authority || url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || host !== url.hostname.toLowerCase() || url.hostname.includes('..') || url.hostname.endsWith('.') || url.port === '0'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLoopbackHttp === true && loopback(url.hostname)))) throw error('CENTER_INVALID_ORIGIN')
  return url.origin
}

function bounded(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum
}
function checkedPath(path: string, method: 'GET' | 'POST', download = false): string {
  if (typeof path !== 'string' || path.length > 2048 || !path.startsWith('/api/v1/')
    || /[\\#\s\u0000-\u001f\u007f]/.test(path)) throw error('CENTER_INVALID_REQUEST')
  const [pathname, rawQuery, ...extra] = path.split('?')
  if (!pathname || extra.length || pathname.includes('%') || pathname.includes('//')) throw error('CENTER_INVALID_REQUEST')
  const release = /^\/api\/v1\/releases\/([^/]+)(?:\/(artifact|download-grants))?$/.exec(pathname)
  if (release && !safeId(release[1]!)) throw error('CENTER_INVALID_REQUEST')
  if (download) {
    if (!release || release[2] !== 'artifact' || rawQuery !== undefined) throw error('CENTER_INVALID_REQUEST')
    return path
  }
  const list = pathname === '/api/v1/releases' && method === 'GET'
  const exchange = pathname === '/api/v1/deployment-bindings/exchange' && method === 'POST'
  if (!list && !exchange && !(release && ((!release[2] && method === 'GET') || (release[2] === 'download-grants' && method === 'POST')))) throw error('CENTER_INVALID_REQUEST')
  if (rawQuery !== undefined) {
    if (!list || !rawQuery || /%(?![0-9a-f]{2})/i.test(rawQuery)) throw error('CENTER_INVALID_REQUEST')
    const parameters = new URLSearchParams(rawQuery)
    for (const [key, value] of parameters) {
      if (!['limit', 'beforeId', 'packId'].includes(key) || parameters.getAll(key).length !== 1
        || (key === 'limit' ? !/^[1-9][0-9]?$|^100$/.test(value) : !safeId(value))) throw error('CENTER_INVALID_REQUEST')
    }
  }
  return path
}
function authHeaders(token?: string): Record<string, string> {
  if (token === undefined) return {}
  if (typeof token !== 'string' || !/^dpc_token_[A-Za-z0-9_-]{43}$/.test(token)) throw error('CENTER_INVALID_REQUEST')
  return { Authorization: `Bearer ${token}` }
}
function contentLength(response: IncomingMessage): number | undefined {
  const raw = response.headers['content-length']
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw error('CENTER_RESPONSE_INVALID')
  return Number(raw)
}
function plainBody(response: IncomingMessage) {
  if (response.headers['content-encoding'] !== undefined || response.headers['content-range'] !== undefined) throw error('CENTER_RESPONSE_INVALID')
  for (const name of ['content-type', 'content-length', 'transfer-encoding']) {
    let count = 0
    for (let index = 0; index < response.rawHeaders.length; index += 2) if (response.rawHeaders[index]?.toLowerCase() === name) count++
    if (count > 1) throw error('CENTER_RESPONSE_INVALID')
  }
}
function jsonType(response: IncomingMessage): boolean {
  const type = response.headers['content-type']
  return typeof type === 'string' && /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(type)
}
async function collectJson(response: IncomingMessage, maximum: number): Promise<unknown> {
  plainBody(response)
  if (!jsonType(response)) throw error('CENTER_RESPONSE_INVALID')
  const expected = contentLength(response)
  if (expected !== undefined && expected > maximum) throw error('CENTER_RESPONSE_TOO_LARGE')
  let length = 0
  const chunks: Buffer[] = []
  for await (const chunk of response) {
    const bytes = Buffer.from(chunk)
    length += bytes.length
    if (length > maximum) throw error('CENTER_RESPONSE_TOO_LARGE')
    chunks.push(bytes)
  }
  if (!response.complete || (expected !== undefined && length !== expected)) throw error('CENTER_RESPONSE_INVALID')
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, length)))
    if (value === null || typeof value !== 'object') throw error('CENTER_RESPONSE_INVALID')
    return value
  } catch { throw error('CENTER_RESPONSE_INVALID') }
}

export function createPackCenterTransport(options: PackCenterTransportOptions) {
  const origin = normalizePackCenterOrigin(options.origin, options.allowLoopbackHttp)
  const url = new URL(origin)
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxJsonBytes = options.maxJsonBytes ?? 2 * 1024 * 1024
  if (!bounded(timeoutMs, 300_000) || !bounded(maxJsonBytes, 16 * 1024 * 1024)
    || (options.testCa !== undefined && (url.protocol !== 'https:' || !loopback(url.hostname) || typeof options.testCa !== 'string' || !options.testCa.length))) throw error('CENTER_INVALID_REQUEST')
  const ca = options.testCa

  function request<T>(path: string, method: 'GET' | 'POST', headers: Record<string, string>, payload: Buffer | undefined,
    signal: AbortSignal | undefined, consume: (response: IncomingMessage) => Promise<T>): Promise<T> {
    if (signal?.aborted) return Promise.reject(error('CENTER_CANCELLED'))
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      let requestHandle: ClientRequest | undefined
      let responseHandle: IncomingMessage | undefined
      let stopped: PackCenterTransportError | undefined
      const finish = (failure?: unknown, result?: T) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        responseHandle?.destroy()
        requestHandle?.destroy()
        if (failure) rejectPromise(failure instanceof PackCenterTransportError ? failure : error('CENTER_NETWORK_ERROR'))
        else resolvePromise(result!)
      }
      const stop = (reason: PackCenterTransportError) => {
        stopped ??= reason
        requestHandle?.destroy()
        responseHandle?.destroy()
        // Once a body consumer owns the response, wait for it to stop writing.
        if (!responseHandle) finish(stopped)
      }
      const cancel = () => stop(error('CENTER_CANCELLED'))
      const timer = setTimeout(() => stop(error('CENTER_TIMEOUT')), timeoutMs)
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        requestHandle = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
          protocol: url.protocol,
          hostname: url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname,
          port: url.port || undefined,
          path, method,
          // A fresh agent-free connection ignores environment proxy configuration and cookies.
          agent: false,
          rejectUnauthorized: true,
          ...(ca === undefined ? {} : { ca }),
          maxHeaderSize: 16 * 1024,
          headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', ...headers,
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(payload.length) }) },
        }, response => {
          responseHandle = response
          if (settled) { response.destroy(); return }
          Promise.resolve().then(async () => {
            const status = response.statusCode ?? 0
            if (status >= 300 && status < 400) throw error('CENTER_REDIRECT_DENIED', status)
            if (status < 200 || status >= 300) {
              let code = 'CENTER_HTTP_ERROR'
              try {
                const data = await collectJson(response, Math.min(maxJsonBytes, 64 * 1024)) as { error?: { code?: unknown } }
                const remoteCode = data.error?.code
                if (typeof remoteCode === 'string' && safeRemoteCodes.has(remoteCode)) code = remoteCode
              } catch { /* HTTP errors never expose remote content or parser exceptions. */ }
              throw error(code, status >= 100 && status <= 599 ? status : undefined)
            }
            if (status !== 200 && status !== 201) throw error('CENTER_RESPONSE_INVALID', status)
            return consume(response)
          }).then(result => finish(stopped, result), failure => {
            // Async-iterator early rejection destroys its stream and may emit a secondary
            // socket error. Preserve the original validation failure; cancellation wins.
            const interrupted = stopped?.code === 'CENTER_TIMEOUT' || stopped?.code === 'CENTER_CANCELLED'
            finish(interrupted ? stopped : failure instanceof PackCenterTransportError ? failure : stopped ?? failure)
          })
        })
        requestHandle.on('error', () => stop(error('CENTER_NETWORK_ERROR')))
        requestHandle.end(payload)
        // Covers an abort between the first check and listener registration.
        if (signal?.aborted) cancel()
      } catch { stop(error('CENTER_NETWORK_ERROR')) }
    })
  }

  return {
    origin,
    async json(path: string, input: PackCenterJsonOptions = {}): Promise<unknown> {
      const method = input.method ?? 'GET'
      if (!['GET', 'POST'].includes(method) || (method === 'GET' && input.body !== undefined)) throw error('CENTER_INVALID_REQUEST')
      checkedPath(path, method)
      const headers = authHeaders(input.credentialToken)
      if (path === '/api/v1/deployment-bindings/exchange' && input.credentialToken !== undefined) throw error('CENTER_INVALID_REQUEST')
      let payload: Buffer | undefined
      if (input.body !== undefined) {
        try {
          const encoded = JSON.stringify(input.body)
          if (encoded === undefined) throw error('CENTER_INVALID_REQUEST')
          payload = Buffer.from(encoded)
        } catch { throw error('CENTER_INVALID_REQUEST') }
        if (payload.length > maxJsonBytes) throw error('CENTER_INVALID_REQUEST')
      }
      return request(path, method, headers, payload, input.signal, response => collectJson(response, maxJsonBytes))
    },
    async download(path: string, destination: string, input: PackCenterDownloadOptions): Promise<{ sizeBytes: number; sha256: string }> {
      checkedPath(path, 'GET', true)
      // Capture approved identity before the first await. A retained caller object
      // must not change what is verified while a download is already in flight.
      const { credentialToken, downloadGrant, expectedSha256, expectedBytes, signal } = input
      const headers = authHeaders(credentialToken)
      const maximum = input.maxBytes ?? 64 * 1024 * 1024
      if (!credentialToken || typeof downloadGrant !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(downloadGrant)
        || typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)
        || !bounded(maximum, 1024 * 1024 * 1024) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maximum
        || typeof destination !== 'string' || !isAbsolute(destination) || resolve(destination) !== destination || destination.includes('\0')) throw error('CENTER_INVALID_REQUEST')
      if (signal?.aborted) throw error('CENTER_CANCELLED')
      headers['X-Pack-Download-Grant'] = downloadGrant
      headers.Accept = 'application/x-tar'
      let handle: FileHandle | undefined
      let identity: { dev: number; ino: number } | undefined
      let completed = false
      try {
        // The caller owns a private staging directory. Refuse symlinked parents and existing files.
        if (await realpath(dirname(destination)) !== dirname(destination)) throw error('CENTER_DOWNLOAD_IO')
        try { handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
        catch (failure) {
          throw error((failure as NodeJS.ErrnoException).code === 'EEXIST' ? 'CENTER_DOWNLOAD_TARGET_EXISTS' : 'CENTER_DOWNLOAD_IO')
        }
        const info = await handle.stat()
        identity = { dev: info.dev, ino: info.ino }
        if (!info.isFile() || info.nlink !== 1) throw error('CENTER_DOWNLOAD_IO')
        const file = handle
        const result = await request(path, 'GET', headers, undefined, signal, async response => {
          plainBody(response)
          if (response.statusCode !== 200 || response.headers['content-type'] !== 'application/x-tar' || contentLength(response) !== expectedBytes) throw error('CENTER_DOWNLOAD_INVALID')
          let sizeBytes = 0
          const hash = createHash('sha256')
          for await (const chunk of response) {
            const bytes = Buffer.from(chunk)
            sizeBytes += bytes.length
            if (sizeBytes > expectedBytes || sizeBytes > maximum) throw error('CENTER_DOWNLOAD_INVALID')
            hash.update(bytes)
            let offset = 0
            while (offset < bytes.length) {
              let written: number
              try { written = (await file.write(bytes, offset, bytes.length - offset)).bytesWritten }
              catch { throw error('CENTER_DOWNLOAD_IO') }
              if (!written) throw error('CENTER_DOWNLOAD_IO')
              offset += written
            }
          }
          const sha256 = hash.digest('hex')
          if (!response.complete || sizeBytes !== expectedBytes || sha256 !== expectedSha256) throw error('CENTER_DOWNLOAD_INVALID')
          try { await file.sync() } catch { throw error('CENTER_DOWNLOAD_IO') }
          return { sizeBytes, sha256 }
        })
        await handle.close()
        handle = undefined
        const current = await lstat(destination)
        if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino || current.nlink !== 1) throw error('CENTER_DOWNLOAD_IO')
        completed = true
        return result
      } catch (failure) {
        throw failure instanceof PackCenterTransportError ? failure : error('CENTER_DOWNLOAD_IO')
      } finally {
        await handle?.close().catch(() => {})
        if (!completed && identity) {
          try {
            const current = await lstat(destination)
            // Never remove a file substituted by another actor, nor a pre-existing target.
            if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino) await unlink(destination)
          } catch { /* Cleanup is best effort; no raw filesystem error escapes. */ }
        }
      }
    },
  }
}
