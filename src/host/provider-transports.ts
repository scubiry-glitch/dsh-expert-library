/**
 * Host transport layer — injectable spawn / fetch / credential seams plus the
 * kind-dispatching {@link ProviderTransports} runner.
 *
 * This is the ONLY module in the plugin that launches processes or opens
 * sockets. The seams are injected so offline contract tests can substitute
 * fakes; the real implementations are `createNodeSpawnRunner` /
 * `createNodeFetchRunner` / `createCredentialResolver`.
 *
 * Safety rules enforced here:
 * - `local-cli` / `mcp-stdio` **never** run through a shell (`shell: true` is
 *   forbidden): commands come from the frozen manifest and args are explicit
 *   arrays; user input only ever travels as a JSON params string.
 * - stdout/stderr/response bodies are byte-bounded; a runaway process is
 *   killed (SIGKILL) and marked truncated.
 * - every call is raced against a per-transport deadline fused with the
 *   caller's AbortSignal; outcomes are classified as
 *   `TRANSPORT_TIMEOUT` (backoff) vs `TRANSPORT_CANCELLED` (never).
 * - only declared fixed endpoints / commands execute; unknown transport kinds
 *   fail closed (`TRANSPORT_UNSUPPORTED`).
 * - secrets are passed through env/headers at call time only — never logged,
 *   never persisted, never returned.
 *
 * @module dsh-expert-library/host/provider-transports
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { AuthDescriptor, ToolTransport } from '../v2/types.ts'

/* ------------------------------------------------------------------ *
 *  Error model.
 * ------------------------------------------------------------------ */

export type TransportErrorCode =
  | 'TRANSPORT_TIMEOUT'
  | 'TRANSPORT_CANCELLED'
  | 'TRANSPORT_MISSING_BINARY'
  | 'TRANSPORT_MISSING_CREDENTIAL'
  | 'TRANSPORT_UNSUPPORTED'
  | 'TRANSPORT_IO'

/** Classified transport failure; adapters map it to a never/backoff envelope. */
export class TransportError extends Error {
  readonly code: TransportErrorCode
  readonly details?: unknown

  constructor(code: TransportErrorCode, details?: unknown) {
    super(`provider transport ${code}${details !== undefined ? `: ${JSON.stringify(details)}` : ''}`)
    this.name = 'TransportError'
    this.code = code
    this.details = details
  }
}

/* ------------------------------------------------------------------ *
 *  Injectable seams.
 * ------------------------------------------------------------------ */

/** One bounded spawn result (no env, no secrets). */
export interface SpawnResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  /** True when the process was killed (abort, timeout or output overflow). */
  readonly killed: boolean
  readonly truncated: 'stdout' | 'stderr' | 'both' | null
}

export interface SpawnOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
}

export type SpawnFn = (options: SpawnOptions) => Promise<SpawnResult>

/** One bounded HTTP response. */
export interface FetchResult {
  readonly status: number
  readonly body: string
  readonly truncated: boolean
}

export interface FetchOptions {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly maxBodyBytes: number
}

export type FetchFn = (options: FetchOptions) => Promise<FetchResult>

/** Resolve one {@link AuthDescriptor} to the secret, or `undefined` when unavailable. */
export type CredentialFn = (descriptor: AuthDescriptor) => string | undefined

/* ------------------------------------------------------------------ *
 *  Real seam implementations.
 * ------------------------------------------------------------------ */

const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024

/**
 * Real spawn runner: `child_process.spawn` without a shell, streaming output
 * with byte caps, SIGTERM→SIGKILL escalation on abort.
 */
export function createNodeSpawnRunner(options: { readonly maxStdoutBytes?: number; readonly maxStderrBytes?: number } = {}): SpawnFn {
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES
  const maxStderr = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
  return (spawnOptions) => new Promise<SpawnResult>((resolvePromise, reject) => {
    let child: ChildProcess
    try {
      child = spawn(spawnOptions.command, [...spawnOptions.args], {
        cwd: spawnOptions.cwd,
        env: { ...process.env, ...spawnOptions.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let outTruncated = false
    let errTruncated = false
    let settled = false
    let escalateTimer: ReturnType<typeof setTimeout> | null = null

    const kill = (signal: NodeJS.Signals = 'SIGTERM'): void => {
      try { child.kill(signal) } catch { /* already exited */ }
    }
    const onAbort = (): void => {
      kill('SIGTERM')
      // Ref'd escalation so a child ignoring SIGTERM cannot outlive the call.
      escalateTimer = setTimeout(() => kill('SIGKILL'), 1000)
    }
    const settle = (): void => {
      if (settled) return
      settled = true
      spawnOptions.signal.removeEventListener('abort', onAbort)
      if (escalateTimer !== null) {
        clearTimeout(escalateTimer)
        escalateTimer = null
      }
    }
    if (spawnOptions.signal.aborted) onAbort()
    else spawnOptions.signal.addEventListener('abort', onAbort, { once: true })

    const readChunk = (isErr: boolean, chunk: Buffer | string): void => {
      const cap = isErr ? maxStderr : maxStdout
      if ((isErr ? errTruncated : outTruncated)) return
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const current = isErr ? stderr : stdout
      const remaining = cap - current.length
      if (remaining <= 0) {
        if (isErr) errTruncated = true
        else outTruncated = true
        kill('SIGKILL')
        return
      }
      if (text.length <= remaining) {
        if (isErr) stderr += text
        else stdout += text
      } else {
        if (isErr) stderr += text.slice(0, remaining)
        else stdout += text.slice(0, remaining)
        if (isErr) errTruncated = true
        else outTruncated = true
        kill('SIGKILL')
      }
    }

    child.stdout?.on('data', (chunk: Buffer | string) => readChunk(false, chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => readChunk(true, chunk))

    child.on('error', (error: NodeJS.ErrnoException) => {
      settle()
      if (error.code === 'ENOENT') reject(new TransportError('TRANSPORT_MISSING_BINARY', { command: spawnOptions.command }))
      else reject(new TransportError('TRANSPORT_IO', { message: error.message }))
    })
    child.on('close', (code, signal) => {
      settle()
      const truncated = outTruncated && errTruncated ? 'both' : outTruncated ? 'stdout' : errTruncated ? 'stderr' : null
      resolvePromise({
        exitCode: code ?? -1,
        stdout,
        stderr,
        killed: signal !== null || outTruncated || errTruncated,
        truncated,
      })
    })
  })
}

/**
 * Real fetch runner: bounded body read (streaming cap), caller signal fused
 * with the deadline by the caller (via `ProviderTransports`).
 */
export function createNodeFetchRunner(options: { readonly maxBodyBytes?: number } = {}): FetchFn {
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  return async (fetchOptions) => {
    const headers = { ...fetchOptions.headers } as Record<string, string>
    // WAF/反代（如 dss.ke.com）会拦截无浏览器 UA 的请求并返回 HTML Forbidden 页，
    // 使 JSON 归一化器报「非 JSON 无效输出」。默认补一个浏览器 UA；调用方显式
    // 传入的 User-Agent 优先（headers 展开在默认值之后）。
    if (!Object.keys(headers).some(key => key.toLowerCase() === 'user-agent')) {
      headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
    }
    const response = await fetch(fetchOptions.url, {
      method: fetchOptions.method,
      headers,
      body: fetchOptions.body,
      signal: fetchOptions.signal,
    })
    let text = ''
    let truncated = false
    const reader = response.body?.getReader()
    if (reader !== undefined) {
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
        if (text.length > maxBody) {
          text = text.slice(0, maxBody)
          truncated = true
          await reader.cancel().catch(() => undefined)
          break
        }
      }
      text += decoder.decode()
    } else {
      text = await response.text()
      if (text.length > maxBody) {
        text = text.slice(0, maxBody)
        truncated = true
      }
    }
    return { status: response.status, body: text, truncated }
  }
}

/** Default file path map for file-sourced credentials. */
const DEFAULT_CREDENTIAL_FILES: Readonly<Record<string, string>> = {
  WIND_API_KEY: '~/.wind-aifinmarket/config',
  ZYT_API_KEY: '~/.config/zyt/config.json',
  BEIKE_MCP_API_KEY: '~/.beike/BEIKE_MCP_API_KEY',
}

/**
 * Real credential resolver. `env` → `process.env[ref]`; `file` → a path from
 * the injected map (or the descriptor `hint`), `~` expanded, read raw and
 * trimmed (zyt's file carries `{baseUrl, apiKey}` — the provider adapter
 * extracts the key). `credential-service` / `inline-flag` are fail-closed
 * extension points (`undefined`) until a service is wired. Values are never
 * logged or persisted by this function.
 */
export function createCredentialResolver(filePaths: Readonly<Record<string, string>> = DEFAULT_CREDENTIAL_FILES): CredentialFn {
  return (descriptor) => {
    switch (descriptor.source ?? 'env') {
      case 'env':
        return process.env[descriptor.credentialRef] ?? undefined
      case 'file': {
        const raw = filePaths[descriptor.credentialRef] ?? descriptor.hint
        if (raw === undefined) return undefined
        const expanded = raw.startsWith('~/') ? resolve(homedir(), raw.slice(2)) : raw
        try {
          const value = readFileSync(expanded, 'utf8').trim()
          return value === '' ? undefined : value
        } catch {
          return undefined
        }
      }
      case 'credential-service':
      case 'inline-flag':
      default:
        return undefined
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Kind-dispatching runner.
 * ------------------------------------------------------------------ */

export interface TransportRunRequest {
  readonly operation: string
  readonly input: unknown
  /** Caller cancellation (tool/task attempt signal). */
  readonly signal?: AbortSignal
  /** Audit context forwarded for logging. */
  readonly context?: string
}

export interface RawTransportResult {
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
  readonly status?: number
  readonly body?: string
  readonly durationMs: number
}

const DEFAULT_CLI_TIMEOUT_MS = 120_000
const DEFAULT_HTTP_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 2_147_483_647

/** Clamp a requested timeout; invalid/absent → the default, capped at MAX. */
export function clampTimeout(requested: number | undefined, def: number, max: number = MAX_TIMEOUT_MS): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return Math.min(def, max)
  return Math.min(requested, max)
}

interface Deadline {
  readonly signal: AbortSignal
  clear(): void
}

/** Clearable deadline signal; cleared on every settled path (finally). */
function deadlineOf(timeoutMs: number): Deadline {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

const MCP_JSONRPC_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse an SSE body (`data: <json>` lines) down to its last payload. */
export function parseMaybeSSE(body: string): string {
  const trimmed = body.trim()
  if (!trimmed.includes('data:')) return body
  let last: string | undefined
  for (const line of trimmed.split('\n')) {
    const t = line.trim()
    if (t.startsWith('data:')) last = t.slice(5).trim()
  }
  return last ?? body
}

/**
 * Executes one transport of a registered provider. Kind dispatch:
 * `local-cli` → spawn runner; `http-api` → fetch (adapter-built path/query/
 * body); `mcp-http` → JSON-RPC `initialize` + method call over fetch (SSE
 * tolerant); `mcp-stdio` fails closed (`TRANSPORT_UNSUPPORTED`) in this
 * version — no v1 manifest declares it.
 */
export class ProviderTransports {
  private readonly spawnFn: SpawnFn
  private readonly fetchFn: FetchFn
  private readonly maxStdoutBytes: number
  private readonly maxStderrBytes: number
  private readonly maxBodyBytes: number

  constructor(options: {
    readonly spawn?: SpawnFn
    readonly fetch?: FetchFn
    readonly maxStdoutBytes?: number
    readonly maxStderrBytes?: number
    readonly maxBodyBytes?: number
  } = {}) {
    this.spawnFn = options.spawn ?? createNodeSpawnRunner()
    this.fetchFn = options.fetch ?? createNodeFetchRunner()
    this.maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  }

  async run(transport: ToolTransport, request: TransportRunRequest): Promise<RawTransportResult> {
    switch (transport.kind) {
      case 'local-cli':
        return this.runCli(transport, request)
      case 'http-api':
        return this.runHttp(transport, request, false)
      case 'mcp-http':
        return this.runHttp(transport, request, true)
      case 'mcp-stdio':
        throw new TransportError('TRANSPORT_UNSUPPORTED', { kind: 'mcp-stdio' })
      default:
        throw new TransportError('TRANSPORT_UNSUPPORTED', { kind: (transport as { kind?: string }).kind })
    }
  }

  private async runCli(transport: Extract<ToolTransport, { kind: 'local-cli' }>, request: TransportRunRequest): Promise<RawTransportResult> {
    const input = isRecord(request.input) ? request.input : {}
    const args = Array.isArray(input['args']) ? (input['args'] as unknown[]).filter((arg): arg is string => typeof arg === 'string') : []
    const env = isRecord(input['env']) ? input['env'] as Record<string, string> : undefined
    const timeoutMs = clampTimeout(transport.timeoutMs, DEFAULT_CLI_TIMEOUT_MS)
    const started = performance.now()
    const deadline = deadlineOf(timeoutMs)
    let timedOut = false
    deadline.signal.addEventListener('abort', () => { timedOut = true }, { once: true })
    const fused = request.signal !== undefined ? AbortSignal.any([request.signal, deadline.signal]) : deadline.signal
    try {
      const result = await this.spawnFn({
        command: transport.command,
        args: [...(transport.args ?? []), ...args],
        cwd: transport.workingDirectory,
        env,
        timeoutMs,
        signal: fused,
        maxStdoutBytes: this.maxStdoutBytes,
        maxStderrBytes: this.maxStderrBytes,
      })
      if (timedOut) throw new TransportError('TRANSPORT_TIMEOUT', { timeoutMs })
      if (request.signal?.aborted) throw new TransportError('TRANSPORT_CANCELLED')
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: Math.round(performance.now() - started) }
    } finally {
      deadline.clear()
    }
  }

  private async runHttp(
    transport: Extract<ToolTransport, { kind: 'http-api' | 'mcp-http' }>,
    request: TransportRunRequest,
    isMcp: boolean,
  ): Promise<RawTransportResult> {
    const input = isRecord(request.input) ? request.input : {}
    const headers = isRecord(input['headers']) ? input['headers'] as Record<string, string> : {}
    const timeoutMs = clampTimeout(transport.timeoutMs, DEFAULT_HTTP_TIMEOUT_MS)
    const started = performance.now()
    const deadline = deadlineOf(timeoutMs)
    let timedOut = false
    deadline.signal.addEventListener('abort', () => { timedOut = true }, { once: true })
    const fused = request.signal !== undefined ? AbortSignal.any([request.signal, deadline.signal]) : deadline.signal
    try {
      if (isMcp) {
        return await this.runMcpHttp(transport as Extract<ToolTransport, { kind: 'mcp-http' }>, input, headers, timeoutMs, fused, request, started, () => timedOut)
      }
      const base = (transport as Extract<ToolTransport, { kind: 'http-api' }>).baseUrl
      const path = typeof input['path'] === 'string' ? input['path'] : '/'
      const query = isRecord(input['query']) ? input['query'] as Record<string, string> : undefined
      const url = new URL(path, base)
      for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
      // `null` means "no body" in a request plan (GET endpoints carry
      // `body: null`); treat it as absent so fetch never sees a GET body.
      const body = input['body'] !== undefined && input['body'] !== null
        ? (typeof input['body'] === 'string' ? input['body'] : JSON.stringify(input['body']))
        : undefined
      const result = await this.fetchFn({
        url: url.toString(),
        method: typeof input['method'] === 'string' ? input['method'] : 'GET',
        headers: { 'content-type': 'application/json', ...headers },
        body,
        timeoutMs,
        signal: fused,
        maxBodyBytes: this.maxBodyBytes,
      })
      if (timedOut) throw new TransportError('TRANSPORT_TIMEOUT', { timeoutMs })
      if (request.signal?.aborted) throw new TransportError('TRANSPORT_CANCELLED')
      return { status: result.status, body: result.body, durationMs: Math.round(performance.now() - started) }
    } catch (error) {
      if (timedOut) throw new TransportError('TRANSPORT_TIMEOUT', { timeoutMs })
      if (request.signal?.aborted) throw new TransportError('TRANSPORT_CANCELLED')
      throw error instanceof TransportError ? error : new TransportError('TRANSPORT_IO', { message: error instanceof Error ? error.message : String(error) })
    } finally {
      deadline.clear()
    }
  }

  private async runMcpHttp(
    transport: Extract<ToolTransport, { kind: 'mcp-http' }>,
    input: Record<string, unknown>,
    headers: Record<string, string>,
    timeoutMs: number,
    fused: AbortSignal,
    request: TransportRunRequest,
    started: number,
    isTimedOut: () => boolean,
  ): Promise<RawTransportResult> {
    const method = typeof input['method'] === 'string' ? input['method'] : 'tools/call'
    const params = input['params']
    const jsonrpcHeaders: Record<string, string> = { ...MCP_JSONRPC_HEADERS, ...headers }
    const call = async (mcpMethod: string, mcpParams: unknown): Promise<string> => {
      const response = await this.fetchFn({
        url: transport.endpoint,
        method: 'POST',
        headers: jsonrpcHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: mcpMethod, params: mcpParams }),
        timeoutMs,
        signal: fused,
        maxBodyBytes: this.maxBodyBytes,
      })
      if (isTimedOut()) throw new TransportError('TRANSPORT_TIMEOUT', { timeoutMs })
      if (request.signal?.aborted) throw new TransportError('TRANSPORT_CANCELLED')
      return response.body
    }
    // MCP handshake: initialize (2025-03-26), then the requested method.
    await call('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'dsh-expert-library', version: '0.1.0' },
    })
    const body = await call(method, params)
    return { status: 200, body: parseMaybeSSE(body), durationMs: Math.round(performance.now() - started) }
  }
}
