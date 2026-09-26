/**
 * Pure capability and route seam for durable Expert Teams members.
 *
 * This module intentionally has no Context, filesystem, spawn or provider
 * calls.  The runtime can use it at both the spawn and provider-call boundary,
 * while a persisted member only needs to carry the JSON-safe scope and route
 * snapshots returned here.
 *
 * @module dsh-expert-library/capability-scope
 */

export const CAPABILITY_SCOPE_SCHEMA_VERSION = 1 as const

export type ScopeAllowlistKind = 'provider' | 'tool' | 'knowledge' | 'task'

export interface CapabilityScopeBootstrapSummary {
  /** Host/runtime capability ids observed while bootstrapping. */
  readonly hostCapabilities?: readonly string[]
  /** Explicitly selected profile that supplied this scope. */
  readonly profileId?: string
  /** Short diagnostic summary; never contains credentials. */
  readonly summary?: string
}

/** Durable member-level capability scope. Empty allowlists are deny-all. */
export interface CapabilityScope {
  readonly schemaVersion: typeof CAPABILITY_SCOPE_SCHEMA_VERSION
  readonly expertId: string
  readonly role: string
  readonly allowedProviders: readonly string[]
  readonly allowedTools: readonly string[]
  readonly allowedKnowledge: readonly string[]
  readonly allowedTasks: readonly string[]
  /** Maximum child delegation depth. Defaults to 0 (no nested delegation). */
  readonly maxDepth: number
  readonly profileId?: string
  readonly bootstrap?: CapabilityScopeBootstrapSummary
}

export interface CapabilityScopeInput {
  readonly expertId: string
  readonly role: string
  readonly allowedProviders?: readonly string[]
  readonly allowedTools?: readonly string[]
  readonly allowedKnowledge?: readonly string[]
  readonly allowedTasks?: readonly string[]
  readonly maxDepth?: number
  readonly profileId?: string
  readonly bootstrap?: CapabilityScopeBootstrapSummary
}

export interface ScopeAdmissionRequest {
  readonly provider?: string
  readonly tool?: string
  readonly knowledge?: string
  readonly task?: string
  /** Current child depth; `0` is the member itself, `1` is one child level. */
  readonly delegationDepth?: number
}

export interface ScopeAdmissionDenial {
  readonly kind: ScopeAllowlistKind | 'delegation'
  readonly id: string | number
  readonly code: 'scope-denied' | 'depth-denied' | 'invalid-request'
  readonly reason: string
}

export type ScopeAdmissionResult =
  | { readonly ok: true; readonly scope: CapabilityScope }
  | { readonly ok: false; readonly scope: CapabilityScope; readonly denied: readonly ScopeAdmissionDenial[] }

export class CapabilityScopeError extends Error {
  readonly code = 'invalid-capability-scope'

  constructor(message: string) {
    super(message)
    this.name = 'CapabilityScopeError'
  }
}

export type RouteSource = 'explicit' | 'profile' | 'expert' | 'default' | 'captain' | 'fallback'

export interface MemberRoute {
  readonly provider: string
  readonly model: string
  /** `default` means the target model's default effort. */
  readonly reasoningEffort?: string
  readonly reason?: string
}

/** Provider/model capability known to the host LLM registry. */
export interface RouteCompatibility {
  readonly provider: string
  readonly model: string
  /** Omit when the host did not expose an effort catalogue. */
  readonly supportedEfforts?: readonly string[]
}

export interface RouteResolutionInput {
  readonly explicit?: MemberRoute
  readonly profile?: MemberRoute
  readonly expert?: MemberRoute
  readonly default?: MemberRoute
  readonly captain?: MemberRoute
  readonly fallback?: readonly MemberRoute[]
  readonly available?: readonly RouteCompatibility[]
  /** Scope provider allowlist; an absent list means this seam adds no restriction. */
  readonly allowedProviders?: readonly string[]
}

export interface RouteAttempt {
  readonly source: RouteSource
  readonly provider?: string
  readonly model?: string
  readonly accepted: boolean
  readonly reason?: string
}

export type RouteResolutionResult =
  | {
    readonly ok: true
    readonly route: MemberRoute
    readonly source: RouteSource
    readonly fallbackUsed: boolean
    readonly attempts: readonly RouteAttempt[]
  }
  | {
    readonly ok: false
    readonly code: 'route-invalid' | 'provider-denied' | 'route-incompatible' | 'no-route'
    readonly message: string
    readonly attempts: readonly RouteAttempt[]
  }

export interface HostCapabilitySnapshot {
  readonly providers?: readonly string[]
  readonly tools?: readonly string[]
  readonly knowledge?: readonly string[]
  /** Whether the host can materialize a continuable child session. */
  readonly continuable?: boolean
}

export interface ScopeFilteredCapabilities {
  readonly providers: readonly string[]
  readonly tools: readonly string[]
  readonly knowledge: readonly string[]
}

export interface ScopeSpawnError {
  readonly code: 'host-not-continuable' | 'scope-capability-missing'
  readonly message: string
  readonly missing: readonly string[]
  readonly retryable: boolean
}

export interface ScopeBootstrapResult {
  readonly scope: CapabilityScope
  readonly filtered: ScopeFilteredCapabilities
  /** True when host capability information was incomplete and filtering was lenient. */
  readonly lenient: boolean
  readonly stopping: boolean
  readonly spawnError?: ScopeSpawnError
  readonly fallback?: {
    readonly kind: 'lenient-filter'
    readonly reason: string
  }
}

export interface CapabilityScopeRestoreReport {
  readonly scope: CapabilityScope
  readonly migrated: boolean
  readonly warnings: readonly string[]
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function uniqueIds(values: readonly string[] | undefined, field: string): string[] {
  if (values === undefined) return []
  if (!Array.isArray(values)) throw new CapabilityScopeError(`${field} must be an array of strings`)
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!text(value)) throw new CapabilityScopeError(`${field} must contain non-empty strings`)
    const normalized = value.trim()
    if (!seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  }
  return result
}

function nonNegativeInt(value: unknown, field: string, fallback = 0): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < 0) throw new CapabilityScopeError(`${field} must be a non-negative integer`)
  return value as number
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (!text(value)) throw new CapabilityScopeError(`${field} must be a non-empty string when present`)
  return value.trim()
}

/** Create a deterministic, fail-closed member capability scope. */
export function createCapabilityScope(input: CapabilityScopeInput): CapabilityScope {
  if (typeof input !== 'object' || input === null) throw new CapabilityScopeError('scope input must be an object')
  if (!text(input.expertId)) throw new CapabilityScopeError('expertId must be a non-empty string')
  if (!text(input.role)) throw new CapabilityScopeError('role must be a non-empty string')
  const profileId = optionalText(input.profileId, 'profileId')
  const bootstrap = input.bootstrap === undefined ? undefined : normalizeBootstrapSummary(input.bootstrap)
  return {
    schemaVersion: CAPABILITY_SCOPE_SCHEMA_VERSION,
    expertId: input.expertId.trim(),
    role: input.role.trim(),
    allowedProviders: uniqueIds(input.allowedProviders, 'allowedProviders'),
    allowedTools: uniqueIds(input.allowedTools, 'allowedTools'),
    allowedKnowledge: uniqueIds(input.allowedKnowledge, 'allowedKnowledge'),
    allowedTasks: uniqueIds(input.allowedTasks, 'allowedTasks'),
    maxDepth: nonNegativeInt(input.maxDepth, 'maxDepth', 0),
    ...(profileId === undefined ? {} : { profileId }),
    ...(bootstrap === undefined ? {} : { bootstrap }),
  }
}

function normalizeBootstrapSummary(value: CapabilityScopeBootstrapSummary): CapabilityScopeBootstrapSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CapabilityScopeError('bootstrap must be an object')
  const hostCapabilities = value.hostCapabilities === undefined ? undefined : uniqueIds(value.hostCapabilities, 'bootstrap.hostCapabilities')
  const profileId = optionalText(value.profileId, 'bootstrap.profileId')
  const summary = optionalText(value.summary, 'bootstrap.summary')
  return {
    ...(hostCapabilities === undefined ? {} : { hostCapabilities }),
    ...(profileId === undefined ? {} : { profileId }),
    ...(summary === undefined ? {} : { summary }),
  }
}

function allowed(scope: CapabilityScope, kind: ScopeAllowlistKind, id: string): boolean {
  const list = kind === 'provider'
    ? scope.allowedProviders
    : kind === 'tool'
      ? scope.allowedTools
      : kind === 'knowledge'
        ? scope.allowedKnowledge
        : scope.allowedTasks
  return list.includes(id)
}

/** Check one or more provider/tool/knowledge/task references and delegation depth. */
export function admitCapability(scope: CapabilityScope, request: ScopeAdmissionRequest): ScopeAdmissionResult {
  const denials: ScopeAdmissionDenial[] = []
  const candidates: Array<[ScopeAllowlistKind, string | undefined]> = [
    ['provider', request.provider],
    ['tool', request.tool],
    ['knowledge', request.knowledge],
    ['task', request.task],
  ]
  let hasReference = false
  for (const [kind, value] of candidates) {
    if (value === undefined) continue
    hasReference = true
    if (!text(value)) {
      denials.push({ kind, id: value, code: 'invalid-request', reason: `${kind} id must be a non-empty string` })
      continue
    }
    const id = value.trim()
    if (!allowed(scope, kind, id)) {
      denials.push({ kind, id, code: 'scope-denied', reason: `${kind} "${id}" is outside the member capability scope` })
    }
  }
  if (request.delegationDepth !== undefined) {
    if (!Number.isInteger(request.delegationDepth) || request.delegationDepth < 0) {
      denials.push({ kind: 'delegation', id: request.delegationDepth, code: 'invalid-request', reason: 'delegationDepth must be a non-negative integer' })
    } else if (request.delegationDepth > scope.maxDepth) {
      denials.push({ kind: 'delegation', id: request.delegationDepth, code: 'depth-denied', reason: `delegation depth ${request.delegationDepth} exceeds maxDepth ${scope.maxDepth}` })
    }
  }
  if (!hasReference && request.delegationDepth === undefined) {
    denials.push({ kind: 'task', id: '', code: 'invalid-request', reason: 'admission requires a provider, tool, knowledge, task or delegationDepth' })
  }
  return denials.length === 0 ? { ok: true, scope } : { ok: false, scope, denied: denials }
}

/** Resolve member route with explicit → profile → expert → default → captain precedence. */
export function resolveCapabilityRoute(input: RouteResolutionInput): RouteResolutionResult {
  const attempts: RouteAttempt[] = []
  const sources: Array<[RouteSource, MemberRoute | undefined]> = [
    ['explicit', input.explicit],
    ['profile', input.profile],
    ['expert', input.expert],
    ['default', input.default],
    ['captain', input.captain],
  ]
  let primary: [RouteSource, MemberRoute] | undefined
  for (const [source, candidate] of sources) {
    if (candidate !== undefined) {
      primary = [source, candidate]
      break
    }
  }
  const candidates: Array<[RouteSource, MemberRoute]> = []
  if (primary !== undefined) candidates.push(primary)
  for (const candidate of input.fallback ?? []) candidates.push(['fallback', candidate])
  if (candidates.length === 0) return { ok: false, code: 'no-route', message: 'no member route was provided', attempts }
  for (const [source, candidate] of candidates) {
    const provider = typeof candidate.provider === 'string' ? candidate.provider.trim() : ''
    const model = typeof candidate.model === 'string' ? candidate.model.trim() : ''
    if (provider === '' || model === '') {
      attempts.push({ source, provider: provider || undefined, model: model || undefined, accepted: false, reason: 'provider and model are required' })
      if (source !== 'fallback') return { ok: false, code: 'route-invalid', message: 'member route requires a provider and model', attempts }
      continue
    }
    if (input.allowedProviders !== undefined && !input.allowedProviders.includes(provider)) {
      attempts.push({ source, provider, model, accepted: false, reason: `provider "${provider}" is outside the capability scope` })
      continue
    }
    const compatibility = input.available?.find(route => route.provider === provider && route.model === model)
    if (input.available !== undefined && compatibility === undefined) {
      attempts.push({ source, provider, model, accepted: false, reason: 'provider/model is not available on the host' })
      continue
    }
    if (candidate.reasoningEffort !== undefined && typeof candidate.reasoningEffort !== 'string') {
      attempts.push({ source, provider, model, accepted: false, reason: 'reasoningEffort must be a string' })
      if (source !== 'fallback') return { ok: false, code: 'route-invalid', message: 'reasoningEffort must be a string', attempts }
      continue
    }
    const effort = candidate.reasoningEffort === undefined || candidate.reasoningEffort === 'default'
      ? undefined
      : candidate.reasoningEffort.trim()
    if (candidate.reasoningEffort !== undefined && effort === '') {
      attempts.push({ source, provider, model, accepted: false, reason: 'reasoningEffort must not be empty' })
      if (source !== 'fallback') return { ok: false, code: 'route-invalid', message: 'reasoningEffort must not be empty', attempts }
      continue
    }
    if (effort !== undefined && compatibility?.supportedEfforts !== undefined && !compatibility.supportedEfforts.includes(effort)) {
      attempts.push({ source, provider, model, accepted: false, reason: `reasoning effort "${effort}" is unsupported by this provider/model` })
      continue
    }
    const route: MemberRoute = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    attempts.push({ source, provider, model, accepted: true })
    return { ok: true, route, source, fallbackUsed: source === 'fallback', attempts }
  }
  const last = attempts.at(-1)
  const incompatible = last?.reason?.includes('available') || last?.reason?.includes('unsupported')
  return {
    ok: false,
    code: incompatible ? 'route-incompatible' : 'provider-denied',
    message: last?.reason ?? 'no compatible member route was found',
    attempts,
  }
}

function intersectScopeList(
  scopeValues: readonly string[],
  hostValues: readonly string[] | undefined,
): { values: string[]; removed: string[]; lenient: boolean } {
  if (hostValues === undefined) return { values: [...scopeValues], removed: [], lenient: true }
  const host = new Set(hostValues)
  const values = scopeValues.filter(value => host.has(value))
  return { values, removed: scopeValues.filter(value => !host.has(value)), lenient: false }
}

/** Filter scope against host capability facts without ever widening permissions. */
export function bootstrapCapabilityScope(scope: CapabilityScope, host: HostCapabilitySnapshot): ScopeBootstrapResult {
  const providers = intersectScopeList(scope.allowedProviders, host.providers)
  const tools = intersectScopeList(scope.allowedTools, host.tools)
  const knowledge = intersectScopeList(scope.allowedKnowledge, host.knowledge)
  const missing = [
    ...providers.removed.map(id => `provider:${id}`),
    ...tools.removed.map(id => `tool:${id}`),
    ...knowledge.removed.map(id => `knowledge:${id}`),
  ]
  const lenient = providers.lenient || tools.lenient || knowledge.lenient || host.continuable === undefined
  const emptyAfterFilter = [
    ...(scope.allowedProviders.length > 0 && providers.values.length === 0 ? ['provider'] : []),
    ...(scope.allowedTools.length > 0 && tools.values.length === 0 ? ['tool'] : []),
    ...(scope.allowedKnowledge.length > 0 && knowledge.values.length === 0 ? ['knowledge'] : []),
  ]
  const spawnError: ScopeSpawnError | undefined = host.continuable === false
    ? {
      code: 'host-not-continuable',
      message: 'host cannot materialize a continuable member session',
      missing: ['continuable'],
      retryable: false,
    }
    : emptyAfterFilter.length > 0
      ? {
        code: 'scope-capability-missing',
        message: `host is missing scoped capabilities: ${emptyAfterFilter.join(', ')}`,
        missing: emptyAfterFilter,
        retryable: true,
      }
      : undefined
  const stopping = spawnError !== undefined
  const filtered: ScopeFilteredCapabilities = {
    providers: providers.removed,
    tools: tools.removed,
    knowledge: knowledge.removed,
  }
  const summary = missing.length === 0
    ? scope.bootstrap?.summary
    : `host filtered ${missing.join(', ')}`
  const bootstrapped = createCapabilityScope({
    ...scope,
    allowedProviders: providers.values,
    allowedTools: tools.values,
    allowedKnowledge: knowledge.values,
    bootstrap: {
      ...(scope.bootstrap ?? {}),
      ...(host.providers === undefined && host.tools === undefined && host.knowledge === undefined ? {} : { hostCapabilities: [...new Set([...host.providers ?? [], ...host.tools ?? [], ...host.knowledge ?? []])] }),
      ...(summary === undefined ? {} : { summary }),
    },
  })
  return {
    scope: bootstrapped,
    filtered,
    lenient,
    stopping,
    ...(spawnError === undefined ? {} : { spawnError }),
    ...(lenient ? { fallback: { kind: 'lenient-filter' as const, reason: 'host capability facts were incomplete; no permission was widened' } } : {}),
  }
}

/** JSON-safe copy used as a durable member snapshot. */
export function snapshotCapabilityScope(scope: CapabilityScope): CapabilityScope {
  return createCapabilityScope(scope)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Restore a scope, migrating legacy states with missing A5 fields fail-closed. */
export function restoreCapabilityScopeWithReport(value: unknown, identity?: { expertId?: string; role?: string }): CapabilityScopeRestoreReport {
  if (!record(value)) throw new CapabilityScopeError('capability scope snapshot must be an object')
  if (value.schemaVersion !== undefined && value.schemaVersion !== CAPABILITY_SCOPE_SCHEMA_VERSION) {
    throw new CapabilityScopeError(`unsupported capability scope schemaVersion ${String(value.schemaVersion)}`)
  }
  const expertId = value.expertId ?? identity?.expertId
  const role = value.role ?? identity?.role
  if (!text(expertId) || !text(role)) throw new CapabilityScopeError('scope snapshot requires expertId and role')
  const migrated = value.schemaVersion !== CAPABILITY_SCOPE_SCHEMA_VERSION
    || value.allowedProviders === undefined
    || value.allowedTools === undefined
    || value.allowedKnowledge === undefined
    || value.allowedTasks === undefined
    || value.maxDepth === undefined
  const scope = createCapabilityScope({
    expertId,
    role,
    allowedProviders: value.allowedProviders as readonly string[] | undefined,
    allowedTools: value.allowedTools as readonly string[] | undefined,
    allowedKnowledge: value.allowedKnowledge as readonly string[] | undefined,
    allowedTasks: value.allowedTasks as readonly string[] | undefined,
    maxDepth: value.maxDepth as number | undefined,
    profileId: value.profileId as string | undefined,
    bootstrap: value.bootstrap as CapabilityScopeBootstrapSummary | undefined,
  })
  return {
    scope,
    migrated,
    warnings: migrated ? ['legacy capability scope fields were defaulted; missing allowlists remain deny-all and maxDepth defaults to 0'] : [],
  }
}

export function restoreCapabilityScope(value: unknown, identity?: { expertId?: string; role?: string }): CapabilityScope {
  return restoreCapabilityScopeWithReport(value, identity).scope
}
