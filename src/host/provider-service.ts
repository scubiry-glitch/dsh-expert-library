/**
 * Host provider runtime service — registers provider manifests, attaches
 * invokers (pure planners/normalizers wired to the injected transport
 * runners), applies `toolExecution` settings overlays, and gates write
 * operations through the optional approval service.
 *
 * - Registered via `ctx.provide('providerTransport', service)` from
 *   `src/index.ts`; `reconfigure` rebuilds the registry when settings change.
 * - Fail-closed: providers whose hard prerequisite is absent (wind skill CLI
 *   not found) are not registered at all; credentials are probed per call and
 *   a missing key yields a `missing-credential` never-retry envelope; the
 *   resolver's `availableCredentials` gate blocks capability binding without a
 *   key.
 * - Write approval: when the Cordis approval service is injected
 *   (`ctx.get('approval')`), `invoke` asks before passing `approved: true`;
 *   when it is NOT injected, the request is left un-approved and the registry
 *   blocks it (`write-requires-approval`) — no undeclared dependency is
 *   added.
 *
 * @module dsh-expert-library/host/provider-service
 */

import type { Context } from '@deepseek-ai/cordis'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CapabilityResolver,
  ProviderRegistry,
  failEnvelope,
  type CapabilityBinding,
  type InvokeAdapterRequest,
  type ProviderEnvelope,
  type ProviderInvocationRequest,
  type ProviderInvoker,
  type ProvenanceInput,
  type RegistryAuditEntry,
  type RegistrySnapshot,
} from '../v2/provider-runtime.ts'
import type { AuthDescriptor, ToolProviderManifest, ToolTransport } from '../v2/types.ts'
import {
  buildWindManifest,
  normalizeWindCliOutput,
  windCallPlan,
} from '../v2/providers/wind.ts'
import {
  buildZytManifest,
  extractZytApiKey,
  normalizeZytCliOutput,
  normalizeZytHttpOutput,
  zytCliArgvFromPlan,
  zytPlanFromOperation,
} from '../v2/providers/zyt.ts'
import {
  beikeCliArgv,
  beikeMCPCallParams,
  buildBeikeManifest,
  normalizeBeikeCliOutput,
  normalizeBeikeMCPHttpOutput,
} from '../v2/providers/beike.ts'
import {
  ProviderTransports,
  TransportError,
  createCredentialResolver,
  createNodeFetchRunner,
  createNodeSpawnRunner,
  type CredentialFn,
  type FetchFn,
  type SpawnFn,
} from './provider-transports.ts'
import { normalizeToolMode, type ToolExecutionConfig } from '../settings.ts'

/* ------------------------------------------------------------------ *
 *  Configuration shapes.
 * ------------------------------------------------------------------ */

/** Per-provider Host configuration (paths/endpoints resolved by probes). */
export interface ProviderServiceOptions {
  readonly wind?: { readonly cliPath: string }
  readonly zyt?: { readonly baseUrl: string; readonly cliCommand?: string; readonly preferCli?: boolean }
  readonly beike?: { readonly baseUrl: string; readonly cliCommand?: string; readonly preferCli?: boolean }
  /** `toolExecution` settings overlays, keyed by provider id. */
  readonly overlays?: Readonly<Record<string, ToolExecutionConfig>>
  /** Injectable seams (tests substitute fakes; defaults are the real runners). */
  readonly spawn?: SpawnFn
  readonly fetch?: FetchFn
  readonly credentials?: CredentialFn
  readonly approval?: ApprovalLike
}

/** Plugin-config-shaped input for {@link resolveProviderServiceOptions}. */
export interface ProviderConfigInput {
  readonly providers?: {
    readonly wind?: { readonly cliPath?: string }
    readonly zyt?: { readonly baseUrl?: string; readonly cliCommand?: string; readonly preferCli?: boolean }
    readonly beike?: { readonly baseUrl?: string; readonly cliCommand?: string; readonly preferCli?: boolean }
  }
  readonly toolExecution?: Readonly<Record<string, ToolExecutionConfig>>
}

/** Duck-typed slice of the optional approval service (`ctx.approval`). */
export interface ApprovalLike {
  request(req: { readonly agent: unknown; readonly toolName: string; readonly reason?: string; readonly signal?: AbortSignal }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

const DEFAULT_ZYT_BASE_URL = 'https://dss.ke.com'
const DEFAULT_BEIKE_ENDPOINT = 'https://building.ke.com/mcp'
const DEFAULT_WIND_SKILL_CLI = '~/.agents/skills/wind-mcp-skill/scripts/cli.mjs'

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** Probe PATH for an executable name (no shell). */
export function resolveExecutable(name: string): string | undefined {
  const pathVar = process.env.PATH ?? ''
  for (const dir of pathVar.split(':').filter(Boolean)) {
    try {
      const candidate = join(dir, name)
      const st = statSync(candidate)
      if (st.isFile() && (st.mode & 0o111) !== 0) return candidate
    } catch {
      // not present in this dir
    }
  }
  return undefined
}

/**
 * Wind CLI path candidate (settings/entry config > `WIND_SKILL_CLI` env >
 * default skill probe path), resolved WITHOUT the existence gate — the
 * health surface reports the candidate even when the file is absent.
 */
export function windCliPathCandidate(input: ProviderConfigInput): string {
  return input.providers?.wind?.cliPath ?? process.env.WIND_SKILL_CLI ?? expandHome(DEFAULT_WIND_SKILL_CLI)
}

/**
 * Resolve per-provider options from the plugin config + environment + probes.
 * `wind` is registered only when the installed skill CLI exists (fail closed);
 * `zyt`/`beike` always register their HTTP transports with declared default
 * endpoints, and their optional CLI transports only when a binary is found.
 */
export function resolveProviderServiceOptions(input: ProviderConfigInput): ProviderServiceOptions {
  const windCliPath = windCliPathCandidate(input)
  const wind = windCliPath !== undefined && existsSync(windCliPath) ? { cliPath: windCliPath } : undefined

  const zytBaseUrl = input.providers?.zyt?.baseUrl ?? process.env.ZYT_BASE_URL ?? DEFAULT_ZYT_BASE_URL
  const zytCli = input.providers?.zyt?.cliCommand ?? process.env.ZYT_CLI ?? resolveExecutable('zyt')
  const zyt: ProviderServiceOptions['zyt'] = {
    baseUrl: zytBaseUrl,
    ...(zytCli !== undefined ? { cliCommand: zytCli } : {}),
    ...(input.providers?.zyt?.preferCli !== undefined ? { preferCli: input.providers.zyt.preferCli } : {}),
  }

  const beikeBaseUrl = input.providers?.beike?.baseUrl ?? process.env.BEIKE_MCP_BASE_URL ?? DEFAULT_BEIKE_ENDPOINT
  const beikeCli = input.providers?.beike?.cliCommand ?? process.env.BEIKE_CLI ?? resolveExecutable('beike')
  const beike: ProviderServiceOptions['beike'] = {
    baseUrl: beikeBaseUrl,
    ...(beikeCli !== undefined ? { cliCommand: beikeCli } : {}),
    ...(input.providers?.beike?.preferCli !== undefined ? { preferCli: input.providers.beike.preferCli } : {}),
  }

  return { wind, zyt, beike, overlays: input.toolExecution }
}

/* ------------------------------------------------------------------ *
 *  Settings overlay (pure).
 * ------------------------------------------------------------------ */

/**
 * Apply a `toolExecution` settings entry onto a manifest:
 * `api.baseUrl`/`api.timeoutMs` → http-api/mcp-http transports;
 * `cli.command`/`cli.workingDirectory`/`cli.timeoutMs` → local-cli;
 * `readOnly` on every transport; mode `cli`/`api` re-binds capabilities to the
 * matching transport **without** moving write operations off their write
 * transport (the write gate must survive overlays).
 */
export function applyToolExecutionOverlay(manifest: ToolProviderManifest, overlay: ToolExecutionConfig | undefined): ToolProviderManifest {
  if (overlay === undefined) return manifest
  const transports = manifest.transports.map(transport => {
    const next: Record<string, unknown> = { ...transport }
    if (overlay.readOnly !== undefined) next['readOnly'] = overlay.readOnly
    if (transport.kind === 'http-api' || transport.kind === 'mcp-http') {
      if (overlay.api?.baseUrl !== undefined) {
        if (transport.kind === 'http-api') next['baseUrl'] = overlay.api.baseUrl
        else next['endpoint'] = overlay.api.baseUrl
      }
      if (overlay.api?.timeoutMs !== undefined) next['timeoutMs'] = overlay.api.timeoutMs
    }
    if (transport.kind === 'local-cli') {
      if (overlay.cli?.command !== undefined) next['command'] = overlay.cli.command
      if (overlay.cli?.workingDirectory !== undefined) next['workingDirectory'] = overlay.cli.workingDirectory
      if (overlay.cli?.timeoutMs !== undefined) next['timeoutMs'] = overlay.cli.timeoutMs
    }
    return next as unknown as ToolTransport
  })
  const mode = normalizeToolMode(overlay.mode)
  let capabilities = manifest.capabilities
  if (mode === 'cli' || mode === 'api') {
    const byId = new Map(transports.map(transport => [transport.id, transport]))
    const cliId = transports.find(transport => transport.kind === 'local-cli')?.id
    const apiId = transports.find(transport => transport.kind !== 'local-cli')?.id
    const targetId = mode === 'cli' ? cliId : apiId
    if (targetId !== undefined) {
      const target = byId.get(targetId)
      if (target !== undefined) {
        capabilities = manifest.capabilities.map(capability => {
          const current = capability.transportId !== undefined ? byId.get(capability.transportId) : undefined
          const currentReadOnly = current?.readOnly !== false
          const targetReadOnly = target.readOnly !== false
          if (currentReadOnly !== targetReadOnly) return capability
          return { ...capability, transportId: targetId }
        })
      }
    }
  }
  return { ...manifest, transports, capabilities }
}

/* ------------------------------------------------------------------ *
 *  Invoker glue — pure plan/normalizer + Host runner + envelope mapping.
 * ------------------------------------------------------------------ */

type CredentialOutcome = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly ref: string }

function credentialOf(credentials: CredentialFn, transport: ToolTransport): CredentialOutcome {
  const auth = transport.auth
  if (auth === undefined) return { ok: true, value: '' }
  const value = credentials(auth)
  if (value === undefined || value === '') return { ok: false, ref: auth.credentialRef }
  return { ok: true, value }
}

function transportOf(manifest: ToolProviderManifest, transportId: string | undefined): ToolTransport {
  if (transportId !== undefined) {
    const found = manifest.transports.find(transport => transport.id === transportId)
    if (found !== undefined) return found
  }
  return manifest.transports[0]!
}

function missingCredential(provider: string, operation: string, ref: string, transportId: string): ProviderEnvelope {
  return failEnvelope({
    code: 'missing-credential',
    retry: 'never',
    correction: `凭据不可用：${ref}（provider ${provider} 未就绪，失败关闭）`,
    details: { credentialRef: ref },
  }, { provider, operation, transportId })
}

function planError(error: unknown, provenance: ProvenanceInput): ProviderEnvelope {
  return failEnvelope({
    code: 'PLAN_ERROR',
    retry: 'correct-input',
    correction: error instanceof Error ? error.message : String(error),
  }, provenance)
}

function transportError(error: unknown, provenance: ProvenanceInput): ProviderEnvelope {
  if (error instanceof TransportError) {
    switch (error.code) {
      case 'TRANSPORT_TIMEOUT':
        return failEnvelope({ code: 'TRANSPORT_TIMEOUT', retry: 'backoff', details: error.details }, provenance)
      case 'TRANSPORT_CANCELLED':
        return failEnvelope({ code: 'TRANSPORT_CANCELLED', retry: 'never' }, provenance)
      case 'TRANSPORT_MISSING_BINARY':
        return failEnvelope({
          code: 'TRANSPORT_MISSING_BINARY',
          retry: 'never',
          correction: `可执行文件不可用（${JSON.stringify(error.details)}），provider 未就绪，失败关闭`,
          details: error.details,
        }, provenance)
      case 'TRANSPORT_UNSUPPORTED':
        return failEnvelope({ code: 'TRANSPORT_UNSUPPORTED', retry: 'never', correction: `transport 类型暂不支持：${JSON.stringify(error.details)}`, details: error.details }, provenance)
      default:
        return failEnvelope({ code: error.code, retry: 'backoff', details: error.details }, provenance)
    }
  }
  return failEnvelope({
    code: 'INVOKER_ERROR',
    retry: 'never',
    details: { message: error instanceof Error ? error.message : String(error) },
  }, provenance)
}

function provenanceOf(provider: string, operation: string, transportId: string, source?: string): ProvenanceInput {
  return { provider, operation, transportId, source }
}

/** Human-readable backend source of a transport (endpoint/command/base URL). */
function transportSourceOf(transport: ToolTransport): string | undefined {
  switch (transport.kind) {
    case 'local-cli':
    case 'mcp-stdio':
      return transport.command
    case 'http-api':
      return transport.baseUrl
    case 'mcp-http':
      return transport.endpoint
    default:
      return undefined
  }
}

function createWindInvoker(manifest: ToolProviderManifest, transports: ProviderTransports, credentials: CredentialFn, cliPath: string): ProviderInvoker {
  return {
    providerId: 'wind',
    async invoke(request: InvokeAdapterRequest): Promise<ProviderEnvelope> {
      const transport = transportOf(manifest, request.transportId)
      const provenance = provenanceOf('wind', request.operation, transport.id, cliPath)
      const cred = credentialOf(credentials, transport)
      if (!cred.ok) return missingCredential('wind', request.operation, cred.ref, transport.id)
      let plan
      try {
        plan = windCallPlan(request.operation, request.input)
      } catch (error) {
        return planError(error, provenance)
      }
      const input: Record<string, unknown> = { args: plan.args }
      if (cred.ok && cred.value !== '') input['env'] = { WIND_API_KEY: cred.value }
      try {
        const raw = await transports.run(transport, { operation: request.operation, input, signal: request.signal, context: request.context })
        const exitCode = raw.exitCode ?? 1
        return normalizeWindCliOutput(
          { exitCode, stdout: raw.stdout ?? '', stderr: raw.stderr },
          { provider: 'wind', operation: request.operation, exitCode, transportId: transport.id, source: cliPath },
        )
      } catch (error) {
        return transportError(error, provenance)
      }
    },
  }
}

function createZytInvoker(manifest: ToolProviderManifest, transports: ProviderTransports, credentials: CredentialFn): ProviderInvoker {
  return {
    providerId: 'zyt',
    async invoke(request: InvokeAdapterRequest): Promise<ProviderEnvelope> {
      const transport = transportOf(manifest, request.transportId)
      const provenance = provenanceOf('zyt', request.operation, transport.id, transportSourceOf(transport))
      const cred = credentialOf(credentials, transport)
      if (!cred.ok) return missingCredential('zyt', request.operation, cred.ref, transport.id)
      const key = extractZytApiKey(cred.ok ? cred.value : undefined)
      let plan
      try {
        plan = zytPlanFromOperation(request.operation, request.input)
      } catch (error) {
        return planError(error, provenance)
      }
      try {
        if (transport.kind === 'http-api') {
          const input: Record<string, unknown> = {
            method: plan.method ?? 'GET',
            path: plan.path ?? '/',
            query: plan.query ?? {},
            body: plan.body ?? undefined,
            headers: key !== undefined ? { 'X-Api-Key': key } : {},
          }
          const raw = await transports.run(transport, { operation: request.operation, input, signal: request.signal, context: request.context })
          return normalizeZytHttpOutput(
            { status: raw.status ?? 0, body: raw.body ?? '' },
            { provider: 'zyt', operation: request.operation, exitCode: 0, transportId: transport.id, source: provenance.source },
          )
        }
        const input: Record<string, unknown> = { args: zytCliArgvFromPlan(plan) }
        if (key !== undefined) input['env'] = { ZYT_API_KEY: key }
        const raw = await transports.run(transport, { operation: request.operation, input, signal: request.signal, context: request.context })
        return normalizeZytCliOutput(
          { exitCode: raw.exitCode ?? 1, stdout: raw.stdout ?? '', stderr: raw.stderr },
          { provider: 'zyt', operation: request.operation, exitCode: raw.exitCode ?? 1, transportId: transport.id, source: provenance.source },
        )
      } catch (error) {
        return transportError(error, provenance)
      }
    },
  }
}

function createBeikeInvoker(manifest: ToolProviderManifest, transports: ProviderTransports, credentials: CredentialFn): ProviderInvoker {
  return {
    providerId: 'beike',
    async invoke(request: InvokeAdapterRequest): Promise<ProviderEnvelope> {
      const transport = transportOf(manifest, request.transportId)
      const provenance = provenanceOf('beike', request.operation, transport.id, transportSourceOf(transport))
      const cred = credentialOf(credentials, transport)
      if (!cred.ok) return missingCredential('beike', request.operation, cred.ref, transport.id)
      const key = cred.ok ? cred.value : undefined
      const options = { provider: 'beike', operation: request.operation, transportId: transport.id, source: provenance.source, caliber: '贝壳线上实时数据（口径由服务端定义，待实测）' }
      try {
        if (transport.kind === 'mcp-http') {
          const call = beikeMCPCallParams(request.operation, request.input)
          const input: Record<string, unknown> = { method: call.method, params: call.params }
          if (key !== undefined) input['headers'] = { Authorization: `Bearer ${key}` }
          const raw = await transports.run(transport, { operation: request.operation, input, signal: request.signal, context: request.context })
          return normalizeBeikeMCPHttpOutput({ status: raw.status ?? 0, body: raw.body ?? '' }, options)
        }
        const input: Record<string, unknown> = { args: beikeCliArgv(request.operation, request.input) }
        if (key !== undefined) input['env'] = { BEIKE_MCP_API_KEY: key }
        const raw = await transports.run(transport, { operation: request.operation, input, signal: request.signal, context: request.context })
        return normalizeBeikeCliOutput({ exitCode: raw.exitCode ?? 1, stdout: raw.stdout ?? '', stderr: raw.stderr }, options)
      } catch (error) {
        return transportError(error, provenance)
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 *  Service.
 * ------------------------------------------------------------------ */

/**
 * Host provider runtime: owns the {@link ProviderRegistry} and
 * {@link CapabilityResolver}, attaches one invoker per registered provider,
 * and exposes invocation with the write-approval gate.
 */
export class ProviderTransportService {
  private registry_ = new ProviderRegistry()
  private resolver_ = new CapabilityResolver(this.registry_)
  private readonly ctx: Context
  private options: ProviderServiceOptions
  private readonly transports: ProviderTransports
  private readonly credentials: CredentialFn
  private readonly approval: ApprovalLike | undefined
  private enabled: string[] = []

  constructor(ctx: Context, options: ProviderServiceOptions) {
    this.ctx = ctx
    this.options = options
    this.transports = new ProviderTransports({ spawn: options.spawn, fetch: options.fetch })
    this.credentials = options.credentials ?? createCredentialResolver()
    this.approval = options.approval ?? (ctx.get('approval') as ApprovalLike | undefined)
    this.rebuild()
  }

  get registry(): ProviderRegistry {
    return this.registry_
  }

  get resolver(): CapabilityResolver {
    return this.resolver_
  }

  /** Provider ids currently registered and invocable. */
  get providers(): readonly string[] {
    return [...this.enabled]
  }

  /** Rebuild registry + invokers from fresh options (settings change). */
  reconfigure(options: ProviderServiceOptions): void {
    this.options = options
    this.rebuild()
  }

  /** CredentialRef names that currently resolve (fail-closed resolver gate). */
  availableCredentials(): string[] {
    const byRef = new Map<string, AuthDescriptor>()
    for (const entry of this.registry_.list()) {
      if (entry.removedAt !== undefined) continue
      for (const transport of entry.manifest.transports) {
        const auth = transport.auth
        if (auth !== undefined && !byRef.has(auth.credentialRef)) byRef.set(auth.credentialRef, auth)
      }
    }
    const available: string[] = []
    for (const [ref, descriptor] of byRef) {
      const value = this.credentials(descriptor)
      if (value !== undefined && value !== '') available.push(ref)
    }
    return available
  }

  /**
   * Invoke a resolved binding. Write transports (`readOnly: false`) require
   * `approved: true`; when the Cordis approval service is injected this asks
   * first (`'allowed-once'` is the only grant). Without it, the request stays
   * un-approved and the registry blocks it — writes never bypass the gate.
   */
  async invoke(request: ProviderInvocationRequest, meta: { readonly agent?: unknown; readonly signal?: AbortSignal } = {}): Promise<ProviderEnvelope> {
    const binding = request.binding
    const transport = this.registry_.get(binding.providerId)?.manifest.transports.find(candidate => candidate.id === binding.transportId)
    let effective: ProviderInvocationRequest = request
    if (transport?.readOnly === false && request.approved !== true) {
      const approval = this.approval
      if (approval !== undefined && meta.agent !== undefined) {
        const outcome = await approval.request({
          agent: meta.agent,
          toolName: 'expert_provider_call',
          reason: `写操作 ${binding.operation}（transport ${binding.transportId}）`,
          signal: meta.signal,
        })
        if (outcome !== 'allowed-once') {
          return failEnvelope({
            code: outcome === 'rejected' ? 'APPROVAL_REJECTED' : 'APPROVAL_UNAVAILABLE',
            retry: 'never',
            correction: outcome === 'rejected' ? '用户拒绝了该写操作' : '审批服务不可用，写操作已阻断（失败关闭）',
          }, { provider: binding.providerId, operation: binding.operation })
        }
        effective = { ...request, approved: true }
      }
      // no approval service → approved stays unset → registry blocks
    }
    return this.registry_.invoke({
      ...effective,
      ...(meta.signal !== undefined && effective.signal === undefined ? { signal: meta.signal } : {}),
    })
  }

  snapshot(): RegistrySnapshot {
    return this.registry_.snapshot()
  }

  audit(): readonly RegistryAuditEntry[] {
    return this.registry_.audit()
  }

  private rebuild(): void {
    const registry = new ProviderRegistry()
    const resolver = new CapabilityResolver(registry)
    const enabled: string[] = []
    const register = (manifest: ToolProviderManifest, invoker: ProviderInvoker): void => {
      const result = registry.register(manifest)
      if (!result.ok) {
        const messages = result.diagnostics.map(diag => `${diag.code}: ${diag.message}`).join('; ')
        throw new Error(`ProviderTransportService: invalid manifest "${manifest.id}": ${messages}`)
      }
      const attached = registry.attach(invoker)
      if (!attached.ok) throw new Error(`ProviderTransportService: attach "${manifest.id}" failed: ${attached.reason}`)
      enabled.push(manifest.id)
    }
    const overlay = (id: string): ToolExecutionConfig | undefined => this.options.overlays?.[id]

    if (this.options.wind !== undefined) {
      const manifest = applyToolExecutionOverlay(buildWindManifest({ cliPath: this.options.wind.cliPath }), overlay('wind'))
      register(manifest, createWindInvoker(manifest, this.transports, this.credentials, this.options.wind.cliPath))
    }
    if (this.options.zyt !== undefined) {
      const opts = this.options.zyt
      const manifest = applyToolExecutionOverlay(
        buildZytManifest({ baseUrl: opts.baseUrl, cliCommand: opts.cliCommand, preferCli: opts.preferCli }),
        overlay('zyt'),
      )
      register(manifest, createZytInvoker(manifest, this.transports, this.credentials))
    }
    if (this.options.beike !== undefined) {
      const opts = this.options.beike
      const manifest = applyToolExecutionOverlay(
        buildBeikeManifest({ baseUrl: opts.baseUrl, cliCommand: opts.cliCommand, preferCli: opts.preferCli }),
        overlay('beike'),
      )
      register(manifest, createBeikeInvoker(manifest, this.transports, this.credentials))
    }
    this.registry_ = registry
    this.resolver_ = resolver
    this.enabled = enabled
  }
}

/** Narrow type re-export for callers needing the binding shape. */
export type { CapabilityBinding }
