/**
 * Phase 3 — TeamTemplate Compiler (`template-compiler`, §4.2/§4.3).
 *
 * Compiles a declarative {@link TeamTemplate} (plus an optional scenario and
 * an optional binding plan) into **one immutable ExecutionPlan**: a frozen
 * roster + task DAG + resolved input bindings + deterministic gate chain +
 * deliverable declarations, stamped with a content digest.
 *
 * Determinism contract: the compiler is a pure function of
 * `(pack, templateId, scenarioId, params, binding)`. It never reads the
 * clock, never consults global state and never mutates its inputs, so the
 * same template + same binding always produces the **isomorphic DAG** and the
 * **identical digest** — the golden/snapshot property of §4.3
 * ("同一模板 + 同一绑定 ⇒ 同构 DAG"). Param normalization is key-order
 * invariant (canonical serialization), and every deterministic choice
 * (roster ranking, provider pick, gate chain order) is recorded in
 * `provenance` so the plan can answer "why this expert/provider/gate order".
 *
 * Failure categories are distinguishable (§4.2):
 * - `params`   — user input errors; never retryable.
 * - `template` — structural errors (dangling refs, cycles); never retryable.
 * - `roster`   — expert/cardinality/diversity problems; never retryable.
 * - `binding`  — provider/knowledge resolution problems; **retryable**
 *   (switch source or degrade), matching "provider 不可用（换源或降级）".
 *
 * Tool-binding rule: a capability requires a ToolProvider only when it is
 * **tool-allowed or tool-input** — i.e. listed in the scenario's
 * `toolPolicy.allowed`, referenced by a `tool-capability` input binding, or
 * (when no scenario is given) declared in a task's `allowedCapabilities`.
 * `ScenarioV2.requiredCapabilities` are **roster** requirements (expert
 * claims, e.g. `zhijian.review`); they never force a provider binding, so
 * capability-first packs with an empty `toolPolicy.allowed` compile without
 * any tool provider (zhijian 智见点评 pack). `allowedProviders` on a
 * requirement only constrains tool resolution when that capability is
 * actually used as a tool — never for roster requirements.
 *
 * Privileged transports (M1): auto-binding targets only **non-privileged**
 * transports — uncredentialed (`auth` absent) and not explicitly writable
 * (`readOnly` not `false`). A capability offered only by privileged
 * transports (`readOnly: false` or `auth.credentialRef`) requires an
 * explicit `providerBinding` produced by the CapabilityResolver/approval
 * layer; without one the compiler fails with a retryable binding error
 * (`privileged-transport-requires-explicit-binding`) instead of silently
 * bypassing ProviderRuntime.
 *
 * Roster requirements are enforced after slot filling: for every
 * `requiredCapabilities` entry, at least `cardinality` (default 1) distinct
 * rostered experts must claim the capability at `>= minProficiency`
 * (default 1); otherwise compilation fails with a `roster`-kind diagnostic
 * (`required-capability-unsatisfied` / `required-capability-cardinality`).
 *
 * User-sign-off slots (`slot.approval: 'user-signoff'`): when exactly one
 * referenced slot carries it and `params.selectedExpertIds` is a string
 * array, the param becomes that slot's explicit assignments (validated like
 * any explicit roster: count within cardinality, known ids, qualified,
 * non-deceased) unless `binding.assignments` already fills the slot. This is
 * the zhijian "user picked these experts" flow — no lowest-id auto
 * selection for the sign-off slot.
 *
 * Optional slots (`cardinality.min = 0`) auto-fill **zero** experts — the
 * legacy `role.shared` slot stays in the shared pool (tasks carry
 * `expertIds: []`) instead of being silently assigned an arbitrary expert.
 * They are filled only by explicit assignments (binding /
 * `params.selectedExpertIds`) or a declared diversity constraint.
 *
 * Unreferenced slots (no task uses them) are skipped **unless** an explicit
 * `binding.assignments` entry supplies them — the V1 assembly roster where
 * `scenario.experts` entries that own no task still belong to the compiled
 * roster (their members are team members without a task).
 *
 * Compiled tasks are **logical** nodes: `CompiledTask.expertIds` carries the
 * resolved role-roster ids (deterministic order), so an execution adapter
 * fans out one physical execution per expert id without re-reading the
 * template or roster; downstream tasks consume the logical task's outputs.
 *
 * Pure module: no I/O, no side effects; output is deep-frozen.
 * @module dsh-expert-library/v2/compiler
 */

import {
  SCHEMA_VERSION,
  type DomainPackV2,
  type ExpertV2,
  type GatePhase,
  type InputBinding,
  type ModelPolicy,
  type OutputTemplate,
  type QualityPolicy,
  type RoleSlot,
  type ScenarioV2,
  type TaskTemplate,
  type TeamTemplate,
  type ToolProviderManifest,
} from './types.ts'
import { canonicalDigest, deepFreeze } from './digest.ts'
import { defaultPhaseForKind, phaseRank } from './phases.ts'

/* ------------------------------------------------------------------ */
/* Compile result                                                      */
/* ------------------------------------------------------------------ */

/** Dominant failure category of a failed compilation. */
export type CompileErrorKind = 'params' | 'template' | 'roster' | 'binding' | 'internal'

/** One compilation error with a stable code and a JSON-ish path. */
export interface CompileError {
  readonly kind: CompileErrorKind
  readonly code: string
  /** Path of the offending value (template/task/param path), when applicable. */
  readonly path?: string
  readonly message: string
  /** Whether retrying with corrected *external* state can succeed (§4.2). */
  readonly retryable: boolean
}

/** Non-fatal finding (e.g. unresolved gate target that may be a section id). */
export interface CompileWarning {
  readonly code: string
  readonly message: string
}

export interface CompileSuccess {
  readonly ok: true
  readonly plan: ExecutionPlan
  readonly warnings: readonly CompileWarning[]
}

export interface CompileFailure {
  readonly ok: false
  readonly errors: readonly CompileError[]
  /** Kind of the first (deterministically reported) error. */
  readonly errorKind: CompileErrorKind
}

export type CompileResult = CompileSuccess | CompileFailure

/* ------------------------------------------------------------------ */
/* Compile input                                                       */
/* ------------------------------------------------------------------ */

/** Explicit capability → tool provider binding override. */
export interface ProviderBinding {
  readonly providerId: string
  readonly operation?: string
  readonly transportId?: string
}

/** Explicit knowledge ref → provider/scope binding override. */
export interface KnowledgeBindingInput {
  readonly providerId: string
  readonly scope?: string
}

/**
 * Optional compile-time binding plan (the §4.3 BindingPlan as *input* to the
 * compiler). When a field is absent the compiler auto-resolves
 * deterministically from the pack; when present, the plan content depends
 * only on template + params + binding (pack changes no longer affect the
 * DAG, only its validation).
 */
export interface CompileBindingPlan {
  /** slotId → explicit expert ids; count must satisfy slot cardinality. */
  readonly assignments?: Readonly<Record<string, readonly string[]>>
  /** capability → provider binding overrides. */
  readonly providerBindings?: Readonly<Record<string, ProviderBinding>>
  /** input ref (as declared in an InputBinding) → knowledge binding override. */
  readonly knowledgeBindings?: Readonly<Record<string, KnowledgeBindingInput>>
  /** Render-mode override for every deliverable. */
  readonly renderMode?: string
}

export interface CompileInput {
  readonly pack: DomainPackV2
  readonly templateId: string
  readonly scenarioId?: string
  readonly params?: Readonly<Record<string, unknown>>
  readonly binding?: CompileBindingPlan
}

/* ------------------------------------------------------------------ */
/* ExecutionPlan (compiled, immutable)                                 */
/* ------------------------------------------------------------------ */

/** One roster entry: a role slot filled by one expert. */
export interface CompiledMember {
  readonly slotId: string
  readonly expertId: string
  readonly modelPolicy?: ModelPolicy
  /** `user-signoff` when the slot requires a user approval gate pre-assembly. */
  readonly approval: 'none' | 'user-signoff'
}

/** A task input after resolution (bindings are resolved at compile time). */
export interface CompiledInput {
  readonly kind: 'task-output' | 'knowledge' | 'tool-capability' | 'parameter'
  readonly ref: string
  /** task-output: the upstream task id (validated to exist). */
  readonly fromTask?: string
  /** tool-capability/knowledge: bound provider id. */
  readonly providerId?: string
  /** tool-capability: bound provider operation. */
  readonly operation?: string
  /** tool-capability: bound transport id. */
  readonly transportId?: string
  /** knowledge: provider scope. */
  readonly scope?: string
  /** parameter: the parameter key (ref after normalization). */
  readonly parameterKey?: string
}

/**
 * One task node of the compiled DAG (subset of the template, resolved).
 * A task is a **logical** node: `expertIds` carries the roster of its role
 * slot (deterministic order), so an execution adapter can fan out one
 * physical execution per expert id without re-reading the template or the
 * roster.
 */
export interface CompiledTask {
  readonly id: string
  readonly role: string
  /** Expert ids rostered for this task's role slot, in roster order. */
  readonly expertIds: readonly string[]
  readonly dependsOn: readonly string[]
  readonly inputs: readonly CompiledInput[]
  readonly allowedCapabilities: readonly string[]
  readonly outputSchema: string
  readonly retryPolicy: 'never' | 'provider-only' | 'quality-repair'
  readonly subject?: string
  readonly description?: string
}

/** A gate bound into the plan, with its deterministic position in the chain. */
export interface CompiledGate {
  /** Unique in the plan: `${policyId}/${gateId}`. */
  readonly id: string
  readonly kind: 'deterministic' | 'semantic' | 'visual'
  readonly phase: GatePhase
  /** Deterministic 0-based position in the chain; the runtime executes in this order. */
  readonly chainOrder: number
  readonly policyId: string
  readonly policyVersion?: string
  readonly gateId: string
  readonly severity: 'hard' | 'soft'
  readonly appliesTo: readonly string[]
  readonly implementation?: string
  readonly config?: Readonly<Record<string, unknown>>
}

/** One deliverable declaration with its output template. */
export interface CompiledDeliverable {
  readonly id: string
  readonly outputTemplate: string
  readonly fromTasks: readonly string[]
  readonly renderMode?: string
}

/**
 * Resolved capability → provider/operation/transport binding.
 * `capability` is always the **requested** capability (the key task inputs
 * and bindings look up by); when a scenario fallback substituted a different
 * provider capability, `servedCapability` names what the provider actually
 * serves and `viaFallback` names the substitution target.
 */
export interface ResolvedCapability {
  /** The requested capability this binding answers (task input lookup key). */
  readonly capability: string
  /** The capability actually served by the provider (set when a fallback substituted). */
  readonly servedCapability?: string
  readonly providerId: string
  readonly operation: string
  readonly transportId?: string
  /** Fallback target this binding substituted for: requested cap → viaFallback. */
  readonly viaFallback?: string
}

/** Resolved knowledge binding (provider + optional scope). */
export interface ResolvedKnowledgeBinding {
  /** The ref as declared in the input binding. */
  readonly ref: string
  readonly providerId: string
  readonly scope?: string
}

/** Everything the runtime needs to resolve tool/knowledge/output references. */
export interface ExecutionBindings {
  readonly tool: readonly ResolvedCapability[]
  readonly knowledge: readonly ResolvedKnowledgeBinding[]
  readonly outputTemplates: ReadonlyArray<{ readonly id: string; readonly version: string }>
  readonly qualityPolicies: ReadonlyArray<{ readonly id: string; readonly version: string }>
}

/** One audit record explaining a deterministic compile decision. */
export interface CompileRecord {
  readonly step: string
  readonly detail: string
}

/**
 * The immutable compiler artifact (§4.3). Execution consumes only this plan;
 * the template, bindings and params are never re-read afterwards.
 */
export interface ExecutionPlan {
  readonly schemaVersion: typeof SCHEMA_VERSION
  /** Short stable id derived from the digest (first 16 hex chars). */
  readonly planId: string
  /** SHA-256 over the canonical serialization of the executable core. */
  readonly digest: string
  readonly template: { readonly id: string; readonly version: string }
  readonly scenario?: { readonly id: string; readonly version?: string }
  /** Normalized parameters (defaults folded in, key-order invariant). */
  readonly params: Readonly<Record<string, unknown>>
  readonly roster: readonly CompiledMember[]
  readonly tasks: readonly CompiledTask[]
  /** Deterministic topological execution order (task ids). */
  readonly executionOrder: readonly string[]
  /** Gates in chain order (chainOrder 0..n). */
  readonly gates: readonly CompiledGate[]
  readonly deliverables: readonly CompiledDeliverable[]
  readonly bindings: ExecutionBindings
  /** Deterministic decision trail (roster picks, provider binds, fallbacks). */
  readonly provenance: readonly CompileRecord[]
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqualJson(item, b[index]))
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    return ka.length === kb.length && ka.every((key, index) => key === kb[index] && deepEqualJson(a[key], b[key]))
  }
  return false
}

/** Whether an expert claims every capability a role slot requires. */
function slotQualified(expert: ExpertV2, slot: RoleSlot): boolean {
  return slot.capabilities.every(cap => expert.capabilities.some(claim => claim.capability === cap))
}

/** Deterministic roster ranking: proficiency × coverage weight, summed over slot caps. */
function rankExpert(expert: ExpertV2, slot: RoleSlot): number {
  let score = 0
  for (const cap of slot.capabilities) {
    const claim = expert.capabilities.find(candidate => candidate.capability === cap)
    if (claim === undefined) continue
    const weight = claim.coverage === 'high' ? 3 : claim.coverage === 'medium' ? 2 : 1
    score += claim.proficiency * weight
  }
  return score
}

function memberOf(expert: ExpertV2, slot: RoleSlot, approval: 'none' | 'user-signoff'): CompiledMember {
  return {
    slotId: slot.id,
    expertId: expert.id,
    ...(expert.modelPolicy === undefined ? {} : { modelPolicy: { ...expert.modelPolicy } }),
    approval,
  }
}

/** Number of distinct domains claimed across a set of experts (diversity.fields). */
function distinctDomains(members: readonly ExpertV2[]): number {
  return new Set(members.flatMap(expert => expert.domains)).size
}

/** Deterministic first transport id of a provider (id-sorted), if any. */
function firstTransportId(provider: ToolProviderManifest): string | undefined {
  const sorted = [...provider.transports].sort((a, b) => compareIds(a.id, b.id))
  return sorted[0]?.id
}

/**
 * Deterministic topological sort of a task DAG (Kahn's algorithm with
 * declaration-order tie-breaking). Returns `undefined` when the graph has a
 * cycle.
 */
function topoSort(tasks: readonly TaskTemplate[]): string[] | undefined {
  const indexOf = new Map<string, number>()
  tasks.forEach((task, index) => indexOf.set(task.id, index))
  const byId = new Map<string, TaskTemplate>()
  for (const task of tasks) byId.set(task.id, task)
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const task of tasks) {
    indegree.set(task.id, 0)
    dependents.set(task.id, [])
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!byId.has(dep)) continue // dangling deps are reported elsewhere
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1)
      dependents.get(dep)?.push(task.id)
    }
  }
  const ready: string[] = tasks
    .filter(task => (indegree.get(task.id) ?? 0) === 0)
    .map(task => task.id)
  const order: string[] = []
  while (ready.length > 0) {
    const next = ready.shift()
    if (next === undefined) break
    order.push(next)
    for (const dependent of dependents.get(next) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0) {
        const declIndex = indexOf.get(dependent) ?? 0
        let inserted = false
        for (let i = 0; i < ready.length; i++) {
          const current = ready[i]
          if (current !== undefined && (indexOf.get(current) ?? 0) > declIndex) {
            ready.splice(i, 0, dependent)
            inserted = true
            break
          }
        }
        if (!inserted) ready.push(dependent)
      }
    }
  }
  return order.length === tasks.length ? order : undefined
}

/* ------------------------------------------------------------------ */
/* JSON-Schema-subset param validation (template.parameters)           */
/* ------------------------------------------------------------------ */

type ParamReporter = (code: string, path: string, message: string) => void

function validateParamValue(key: string, value: unknown, schema: Record<string, unknown>, report: ParamReporter): void {
  const path = `params.${key}`
  const type = schema['type']
  const matchesType = (): boolean => {
    switch (type) {
      case undefined:
        return true
      case 'string':
        return typeof value === 'string'
      case 'number':
        return typeof value === 'number' && !Number.isNaN(value)
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value)
      case 'boolean':
        return typeof value === 'boolean'
      case 'array':
        return Array.isArray(value)
      case 'object':
        return isRecord(value)
      case 'null':
        return value === null
      default:
        return true
    }
  }
  if (type !== undefined && !matchesType()) {
    report('params-type-mismatch', path, `parameter "${key}" must be of type ${String(type)}, got ${typeof value}`)
    return
  }
  if (typeof value === 'string') {
    const minLength = schema['minLength']
    if (typeof minLength === 'number' && value.length < minLength) {
      report('params-min-length', path, `parameter "${key}" is shorter than minLength ${minLength}`)
    }
    const maxLength = schema['maxLength']
    if (typeof maxLength === 'number' && value.length > maxLength) {
      report('params-max-length', path, `parameter "${key}" is longer than maxLength ${maxLength}`)
    }
  }
  if (typeof value === 'number') {
    const minimum = schema['minimum']
    if (typeof minimum === 'number' && value < minimum) {
      report('params-minimum-violation', path, `parameter "${key}" is below minimum ${minimum}`)
    }
    const maximum = schema['maximum']
    if (typeof maximum === 'number' && value > maximum) {
      report('params-maximum-violation', path, `parameter "${key}" is above maximum ${maximum}`)
    }
  }
  const enumValues = schema['enum']
  if (Array.isArray(enumValues) && !enumValues.some(candidate => deepEqualJson(candidate, value))) {
    report('params-enum-violation', path, `parameter "${key}" is not one of the allowed enum values`)
  }
  const constValue = schema['const']
  if (constValue !== undefined && !deepEqualJson(constValue, value)) {
    report('params-const-violation', path, `parameter "${key}" must equal the schema const`)
  }
  if (type === 'array' && Array.isArray(value)) {
    const items = schema['items']
    if (isRecord(items)) {
      value.forEach((item, index) => validateParamValue(`${key}[${index}]`, item, items, report))
    }
  }
}

/**
 * Fold defaults into params and validate against the template's JSON Schema
 * subset (type/enum/const/min-max/min-max-length/items/required/
 * additionalProperties). Returns a fresh object (deep-cloned) so the compiler
 * never shares nested user objects with the plan it freezes.
 */
function normalizeParams(
  raw: Readonly<Record<string, unknown>>,
  schema: unknown,
  report: ParamReporter,
): Record<string, unknown> {
  if (schema === undefined) return structuredClone({ ...raw })
  if (!isRecord(schema)) {
    report('params-invalid-schema', 'template.parameters', 'template parameters must be a JSON Schema object')
    return structuredClone({ ...raw })
  }
  const properties = isRecord(schema['properties']) ? schema['properties'] : undefined
  const required = Array.isArray(schema['required']) ? schema['required'] : undefined
  const schemaType = schema['type']

  const merged: Record<string, unknown> = {}
  if (properties !== undefined) {
    for (const [key, propSchema] of Object.entries(properties)) {
      const prop = isRecord(propSchema) ? propSchema : undefined
      if (prop !== undefined && prop['default'] !== undefined) merged[key] = prop['default']
    }
  }
  for (const [key, value] of Object.entries(raw)) merged[key] = value

  if (schemaType !== undefined && schemaType !== 'object') {
    report('params-type-mismatch', 'params', `template parameters must be an object, but the schema declares type "${String(schemaType)}"`)
    return structuredClone(merged)
  }
  if (required !== undefined) {
    for (const key of required) {
      if (typeof key === 'string' && !(key in merged)) {
        report('params-required-missing', `params.${key}`, `missing required parameter "${key}"`)
      }
    }
  }
  if (properties !== undefined) {
    for (const [key, value] of Object.entries(merged)) {
      const propSchema = properties[key]
      if (isRecord(propSchema)) validateParamValue(key, value, propSchema, report)
    }
    if (schema['additionalProperties'] === false) {
      for (const key of Object.keys(merged)) {
        if (!(key in properties)) {
          report('params-additional-property', `params.${key}`, `unexpected parameter "${key}" (additionalProperties: false)`)
        }
      }
    }
  }
  return structuredClone(merged)
}

/* ------------------------------------------------------------------ */
/* Compiler                                                            */
/* ------------------------------------------------------------------ */

class Compiler {
  private readonly errors: CompileError[] = []
  private readonly warnings: CompileWarning[] = []
  private readonly provenance: CompileRecord[] = []
  private template: TeamTemplate | undefined
  private scenario: ScenarioV2 | undefined
  private params: Record<string, unknown> = {}
  private roster: CompiledMember[] = []
  private tasks: CompiledTask[] = []
  private executionOrder: string[] = []
  private gates: CompiledGate[] = []
  private deliverables: CompiledDeliverable[] = []
  private toolBindings: ResolvedCapability[] = []
  private knowledgeBindings: ResolvedKnowledgeBinding[] = []
  private outputTemplateRefs: Array<{ id: string; version: string }> = []
  private qualityPolicyRefs: Array<{ id: string; version: string }> = []
  private resolvedCapabilities = new Map<string, ResolvedCapability>()
  private resolvedKnowledge = new Map<string, ResolvedKnowledgeBinding>()

  constructor(private readonly input: CompileInput) {}

  private get pack(): DomainPackV2 {
    return this.input.pack
  }

  private fail(kind: CompileErrorKind, code: string, message: string, path?: string): void {
    this.errors.push({ kind, code, path, message, retryable: kind === 'binding' })
  }

  private warn(code: string, message: string): void {
    this.warnings.push({ code, message })
  }

  compile(): CompileResult {
    this.locate()
    this.normalizeParams()
    this.validateDag()
    this.resolveInputBindings()
    this.resolveScenarioBindings()
    this.resolveRoster()
    this.checkScenarioRosterRequirements()
    this.compileGates()
    this.compileDeliverables()
    this.tasks = this.compileTasks()
    if (this.errors.length > 0) {
      const errorKind = this.errors[0]?.kind ?? 'internal'
      return { ok: false, errors: deepFreeze([...this.errors]), errorKind }
    }
    const plan = this.buildPlan()
    return { ok: true, plan: deepFreeze(plan), warnings: deepFreeze([...this.warnings]) }
  }

  /* ----- step 1: locate template & scenario ----- */

  private locate(): void {
    const template = this.pack.teamTemplates.find(candidate => candidate.id === this.input.templateId)
    if (template === undefined) {
      this.fail('template', 'template-not-found', `no team template "${this.input.templateId}" in the pack`)
      return
    }
    this.template = template
    if (this.input.scenarioId === undefined) return
    const scenario = this.pack.scenarios.find(candidate => candidate.id === this.input.scenarioId)
    if (scenario === undefined) {
      this.fail('template', 'scenario-not-found', `no scenario "${this.input.scenarioId}" in the pack`)
      return
    }
    this.scenario = scenario
    if (scenario.teamTemplate !== template.id) {
      this.warn('scenario-template-mismatch', `scenario "${scenario.id}" declares team template "${scenario.teamTemplate}" but the compile target is "${template.id}"`)
    }
  }

  /* ----- step 2: parameter validation ----- */

  private normalizeParams(): void {
    const template = this.template
    if (template === undefined) return
    const raw = this.input.params ?? {}
    if (!isRecord(raw)) {
      this.fail('params', 'params-not-object', 'compile params must be a JSON object', 'params')
      this.params = {}
      return
    }
    this.params = normalizeParams(raw, template.parameters, (code, path, message) => this.fail('params', code, message, path))
  }

  /* ----- step 3: DAG validation ----- */

  private validateDag(): void {
    const template = this.template
    if (template === undefined) return
    const slotIds = new Set(template.slots.map(slot => slot.id))
    const taskIds = new Set(template.tasks.map(task => task.id))
    if (taskIds.size !== template.tasks.length) {
      const seen = new Set<string>()
      for (const [index, task] of template.tasks.entries()) {
        if (seen.has(task.id)) {
          this.fail('template', 'duplicate-task-id', `task id "${task.id}" is declared more than once`, `tasks[${index}].id`)
        }
        seen.add(task.id)
      }
    }
    for (const [index, task] of template.tasks.entries()) {
      if (!slotIds.has(task.role)) {
        this.fail('template', 'unknown-role-slot', `task "${task.id}" references unknown role slot "${task.role}"`, `tasks[${index}].role`)
      }
      for (const dep of task.dependsOn) {
        if (!taskIds.has(dep)) {
          this.fail('template', 'dangling-dependency', `task "${task.id}" depends on unknown task "${dep}"`, `tasks[${index}].dependsOn`)
        }
      }
      for (const [inputIndex, input] of task.inputs.entries()) {
        if (input.kind === 'task-output' && !taskIds.has(input.ref)) {
          this.fail('template', 'dangling-input', `task "${task.id}" binds an input to unknown task "${input.ref}"`, `tasks[${index}].inputs[${inputIndex}]`)
        }
        if (input.kind === 'parameter' && !(input.ref in this.params)) {
          this.fail('params', 'unknown-parameter', `task "${task.id}" binds parameter "${input.ref}" which is not present in params`, `tasks[${index}].inputs[${inputIndex}]`)
        }
        if (input.kind === 'tool-capability') {
          // An explicit tool input must be consistent with the task's allowed
          // capabilities and (when a scenario is bound) the scenario's tool
          // allowlist — otherwise the binding would be silently skipped.
          if (!task.allowedCapabilities.includes(input.ref)) {
            this.fail('template', 'tool-input-not-allowed', `task "${task.id}" binds tool-capability input "${input.ref}" but does not allow it in allowedCapabilities`, `tasks[${index}].inputs[${inputIndex}]`)
          } else if (this.scenario !== undefined && !this.scenario.toolPolicy.allowed.includes(input.ref)) {
            this.fail('template', 'tool-input-not-allowed', `task "${task.id}" binds tool-capability input "${input.ref}" which is not in the scenario's toolPolicy.allowed`, `tasks[${index}].inputs[${inputIndex}]`)
          }
        }
      }
    }
    const order = topoSort(template.tasks)
    if (order === undefined) {
      this.fail('template', 'dag-cycle', 'the task dependency graph contains a cycle')
      return
    }
    this.executionOrder = order
    const referenced = new Set(template.tasks.map(task => task.role))
    for (const slot of template.slots) {
      if (referenced.has(slot.id) && slot.cardinality.max === 0) {
        this.fail('template', 'unfillable-slot', `role slot "${slot.id}" is referenced by tasks but its cardinality.max is 0`)
      }
    }
  }

  /* ----- step 4: input bindings (tool capabilities + knowledge) ----- */

  /**
   * Collect the capabilities that require a ToolProvider: `tool-capability`
   * input refs always; task `allowedCapabilities` only when they are
   * tool-allowed (in the scenario's `toolPolicy.allowed`) — or, when no
   * scenario is given, every task capability is treated as tool-allowed.
   */
  private resolveInputBindings(): void {
    const template = this.template
    if (template === undefined) return
    const toolAllowed = (cap: string): boolean =>
      this.scenario === undefined || this.scenario.toolPolicy.allowed.includes(cap)
    const capabilityOrder: string[] = []
    const seenCap = new Set<string>()
    const knowledgeOrder: string[] = []
    const seenKb = new Set<string>()
    const addCap = (cap: string): void => {
      if (!seenCap.has(cap)) {
        seenCap.add(cap)
        capabilityOrder.push(cap)
      }
    }
    const addKb = (ref: string): void => {
      if (!seenKb.has(ref)) {
        seenKb.add(ref)
        knowledgeOrder.push(ref)
      }
    }
    for (const task of template.tasks) {
      for (const cap of task.allowedCapabilities) {
        if (toolAllowed(cap)) addCap(cap)
      }
      for (const input of task.inputs) {
        if (input.kind === 'tool-capability') addCap(input.ref)
        if (input.kind === 'knowledge') addKb(input.ref)
      }
    }
    for (const cap of capabilityOrder) {
      const resolved = this.resolveToolCapability(cap, new Set())
      if (resolved !== undefined) {
        this.resolvedCapabilities.set(cap, resolved)
        this.toolBindings.push(resolved)
      }
    }
    for (const ref of knowledgeOrder) {
      const resolved = this.resolveKnowledgeRef(ref)
      if (resolved !== undefined) {
        this.resolvedKnowledge.set(ref, resolved)
        this.knowledgeBindings.push(resolved)
      }
    }
  }

  /**
   * Scenario-level bindings: every capability of `toolPolicy.allowed` is a
   * tool binding target; `requiredCapabilities` are **roster** requirements
   * and never force a provider. Knowledge policy refs bind as before.
   */
  private resolveScenarioBindings(): void {
    const scenario = this.scenario
    if (scenario === undefined) return
    for (const cap of scenario.toolPolicy.allowed) {
      if (this.resolvedCapabilities.has(cap)) continue
      const resolved = this.resolveToolCapability(cap, new Set())
      if (resolved !== undefined) {
        this.resolvedCapabilities.set(cap, resolved)
        this.toolBindings.push(resolved)
      }
    }
    for (const ref of scenario.knowledgePolicy.required) {
      if (this.resolvedKnowledge.has(ref)) continue
      const resolved = this.resolveKnowledgeRef(ref)
      if (resolved !== undefined) {
        this.resolvedKnowledge.set(ref, resolved)
        this.knowledgeBindings.push(resolved)
      }
    }
  }

  /** Resolve one capability to a provider/operation/transport (deterministic). */
  private resolveToolCapability(cap: string, visited: Set<string>): ResolvedCapability | undefined {
    if (visited.has(cap)) {
      this.fail('binding', 'fallback-cycle', `capability fallback chain revisits "${cap}"`)
      return undefined
    }
    visited.add(cap)

    // 1) explicit binding override
    const explicit = this.input.binding?.providerBindings?.[cap]
    if (explicit !== undefined) {
      const provider = this.pack.toolProviders.find(candidate => candidate.id === explicit.providerId)
      if (provider === undefined) {
        this.fail('binding', 'unknown-provider', `binding for capability "${cap}" references unknown tool provider "${explicit.providerId}"`)
        return undefined
      }
      const entry = provider.capabilities.find(candidate => candidate.capability === cap)
      if (entry === undefined) {
        this.fail('binding', 'binding-provider-mismatch', `tool provider "${provider.id}" does not declare capability "${cap}"`)
        return undefined
      }
      if (explicit.operation !== undefined && entry.operation !== explicit.operation) {
        this.fail('binding', 'unknown-operation', `provider "${provider.id}" declares operation "${entry.operation}" for "${cap}", not "${explicit.operation}"`)
        return undefined
      }
      if (explicit.transportId !== undefined && !provider.transports.some(transport => transport.id === explicit.transportId)) {
        this.fail('binding', 'unknown-transport', `provider "${provider.id}" has no transport "${explicit.transportId}"`)
        return undefined
      }
      const transportId = explicit.transportId ?? entry.transportId ?? firstTransportId(provider)
      this.provenance.push({ step: 'binding.resolve', detail: `capability=${cap} provider=${provider.id} operation=${entry.operation} transport=${transportId ?? 'none'} (explicit)` })
      return { capability: cap, providerId: provider.id, operation: entry.operation, ...(transportId === undefined ? {} : { transportId }) }
    }

    // 2) auto: providers declaring the capability, constrained by the scenario
    let candidates = this.pack.toolProviders.filter(provider => provider.capabilities.some(entry => entry.capability === cap))
    const allowed = this.scenario?.requiredCapabilities.find(requirement => requirement.capability === cap)?.allowedProviders
    if (allowed !== undefined && allowed.length > 0) {
      candidates = candidates.filter(provider => allowed.includes(provider.id))
    }

    // 3) fallback (only when the scenario explicitly declares substitutability)
    if (candidates.length === 0) {
      const fallback = this.scenario?.toolPolicy.fallbacks?.find(candidate => candidate.from === cap)
      if (fallback !== undefined) {
        const fallbackResolved = this.resolveToolCapability(fallback.to, visited)
        if (fallbackResolved !== undefined) {
          this.provenance.push({ step: 'binding.fallback', detail: `capability=${cap} -> ${fallback.to} (scenario fallback)` })
          // H1: the binding stays keyed by the REQUESTED capability so task
          // input lookups (`resolvedCapabilities.get(ref)`) succeed; the
          // actually-served capability and the substitution target are
          // carried explicitly.
          return {
            ...fallbackResolved,
            capability: cap,
            servedCapability: fallbackResolved.servedCapability ?? fallbackResolved.capability,
            viaFallback: fallback.to,
          }
        }
        return undefined
      }
      this.fail('binding', 'unbound-capability', `capability "${cap}" is not declared by any installed tool provider${this.scenario !== undefined ? ' and no scenario fallback applies' : ''}`)
      return undefined
    }

    // 4) auto binding may only target NON-privileged transports. A transport
    //    is privileged when it is explicitly writable (readOnly: false) or
    //    credentialed (auth.credentialRef). Privileged transports must go
    //    through the CapabilityResolver/approval layer: the compiler requires
    //    an explicit providerBinding for them and returns a retryable binding
    //    error otherwise — it never silently bypasses ProviderRuntime (M1).
    //    Auto-binding stays allowed for uncredentialed transports that are
    //    not explicitly writable.
    const privilegedIds = new Set<string>()
    for (const provider of candidates) {
      const chosenTransportId = provider.capabilities.find(entry => entry.capability === cap)?.transportId ?? firstTransportId(provider)
      if (chosenTransportId === undefined) continue
      const transport = provider.transports.find(candidate => candidate.id === chosenTransportId)
      if (transport !== undefined && (transport.readOnly === false || transport.auth?.credentialRef !== undefined)) {
        privilegedIds.add(provider.id)
      }
    }
    const safe = candidates.filter(provider => !privilegedIds.has(provider.id))
    if (safe.length === 0) {
      this.fail('binding', 'privileged-transport-requires-explicit-binding',
        `capability "${cap}" is offered only by privileged transports (readOnly:false or auth.credentialRef) on providers [${candidates.map(provider => provider.id).join(', ')}]; an explicit providerBinding from the CapabilityResolver/approval layer is required`)
      return undefined
    }
    // Deterministic pick: lowest provider id among the safe (unprivileged) candidates.
    const provider = [...safe].sort((a, b) => compareIds(a.id, b.id))[0]
    const entry = provider?.capabilities.find(candidate => candidate.capability === cap)
    if (provider === undefined || entry === undefined) return undefined
    const transportId = entry.transportId ?? firstTransportId(provider)
    if (transportId === undefined) {
      this.fail('binding', 'provider-no-transport', `provider "${provider.id}" has no transport for capability "${cap}"`)
      return undefined
    }
    this.provenance.push({ step: 'binding.resolve', detail: `capability=${cap} provider=${provider.id} operation=${entry.operation} transport=${transportId}` })
    return { capability: cap, providerId: provider.id, operation: entry.operation, transportId }
  }

  /** Resolve one knowledge ref (`providerId[:scope]`) to a provider binding. */
  private resolveKnowledgeRef(ref: string): ResolvedKnowledgeBinding | undefined {
    const override = this.input.binding?.knowledgeBindings?.[ref]
    const colon = ref.indexOf(':')
    const defaultProvider = colon === -1 ? ref : ref.slice(0, colon)
    const defaultScope = colon === -1 ? undefined : ref.slice(colon + 1)
    const providerId = override?.providerId ?? defaultProvider
    const scope = override?.scope ?? defaultScope
    const provider = this.pack.knowledgeProviders.find(candidate => candidate.id === providerId)
    if (provider === undefined) {
      this.fail('binding', 'unknown-knowledge-provider', `knowledge binding "${ref}" references unknown knowledge provider "${providerId}"`)
      return undefined
    }
    if (scope !== undefined && provider.scopes !== undefined && provider.scopes.length > 0 && !provider.scopes.includes(scope)) {
      this.warn('knowledge-scope-unknown', `knowledge provider "${providerId}" declares scopes [${provider.scopes.join(', ')}] but binding "${ref}" asks for "${scope}"`)
    }
    return { ref, providerId, ...(scope === undefined ? {} : { scope }) }
  }

  /* ----- step 5: roster (slot cardinality + expert capabilities) ----- */

  private resolveRoster(): void {
    const template = this.template
    if (template === undefined) return
    const referenced = new Set(template.tasks.map(task => task.role))
    // H2 (a): when exactly ONE referenced slot requires user sign-off and the
    // caller supplied `params.selectedExpertIds` (a string array), that param
    // IS the slot's explicit assignment — the "user picked these experts"
    // flow (zhijian 智见点评). Explicit `binding.assignments` for the slot
    // always wins; ambiguous (0 or ≥2 sign-off slots) or non-array params are
    // ignored and the slot auto-resolves.
    const signoffSlots = template.slots.filter(slot => referenced.has(slot.id) && slot.approval === 'user-signoff')
    const selectedParam = signoffSlots.length === 1 ? this.params['selectedExpertIds'] : undefined
    const selectedList = Array.isArray(selectedParam) && selectedParam.every(item => typeof item === 'string')
      ? selectedParam as string[]
      : undefined
    for (const slot of template.slots) {
      const explicit = this.input.binding?.assignments?.[slot.id]
      // Explicit binding assignments express caller intent even when no task
      // references the slot — e.g. a V1 assembly roster where
      // `scenario.experts` includes experts that own no task (the
      // `compileV1ScenarioExecutionPlan` bridge). Auto-resolution and the
      // sign-off param path still require a referenced slot.
      if (!referenced.has(slot.id) && explicit === undefined) continue
      const approval = slot.approval ?? 'none'
      if (explicit !== undefined) {
        this.resolveExplicitSlot(slot, explicit, approval)
      } else if (selectedList !== undefined && slot.approval === 'user-signoff' && signoffSlots.length === 1) {
        this.resolveExplicitSlot(slot, selectedList, approval, 'params.selectedExpertIds')
        this.provenance.push({ step: 'roster.param', detail: `slot=${slot.id} selectedExpertIds=[${selectedList.join(',')}] (params)` })
      } else {
        this.resolveAutoSlot(slot, approval)
      }
    }
  }

  private resolveExplicitSlot(slot: RoleSlot, ids: readonly string[], approval: 'none' | 'user-signoff', source = 'binding.assignments'): void {
    const { min, max } = slot.cardinality
    if (ids.length < min || ids.length > max) {
      this.fail('roster', 'assignment-count', `slot "${slot.id}" received ${ids.length} assignment(s) but its cardinality is [${min}, ${max}]`, `${source}.${slot.id}`)
      return
    }
    const seen = new Set<string>()
    const assigned: ExpertV2[] = []
    for (const expertId of ids) {
      if (seen.has(expertId)) {
        this.fail('roster', 'duplicate-assignment', `slot "${slot.id}" assigns expert "${expertId}" more than once`, `${source}.${slot.id}`)
        continue
      }
      seen.add(expertId)
      const expert = this.pack.experts.find(candidate => candidate.id === expertId)
      if (expert === undefined) {
        this.fail('roster', 'unknown-expert', `slot "${slot.id}" assigns unknown expert "${expertId}"`, `${source}.${slot.id}`)
        continue
      }
      if (expert.compliance.deceased === true) {
        this.fail('roster', 'deceased-expert', `expert "${expertId}" is deceased and may only be cited historically, never rostered`, `${source}.${slot.id}`)
        continue
      }
      if (!slotQualified(expert, slot)) {
        this.fail('roster', 'expert-not-qualified', `expert "${expertId}" does not claim all capabilities of slot "${slot.id}" ([${slot.capabilities.join(', ')}])`, `${source}.${slot.id}`)
        continue
      }
      assigned.push(expert)
    }
    const fields = slot.diversity?.fields
    if (fields !== undefined && distinctDomains(assigned) < fields) {
      this.fail('roster', 'diversity-fields-unsatisfied', `slot "${slot.id}" declares diversity.fields = ${fields} but the assigned experts cover only ${distinctDomains(assigned)} distinct domain(s)`)
    }
    for (const expert of assigned) this.roster.push(memberOf(expert, slot, approval))
    this.provenance.push({ step: 'roster.assign', detail: `slot=${slot.id} experts=[${ids.join(',')}]` })
  }

  private resolveAutoSlot(slot: RoleSlot, approval: 'none' | 'user-signoff'): void {
    const { min, max } = slot.cardinality
    const candidates = this.pack.experts
      .filter(expert => slotQualified(expert, slot) && expert.compliance.deceased !== true)
      .sort((a, b) => rankExpert(b, slot) - rankExpert(a, slot) || compareIds(a.id, b.id))
    // M3: cardinality.min = 0 makes the slot OPTIONAL — auto-fill selects
    // ZERO experts. Filling happens only via explicit assignments (binding /
    // params.selectedExpertIds) or a declared diversity constraint (the
    // greedy selection below grows up to cardinality.max to satisfy it).
    // This keeps optional legacy `role.shared` slots in the shared pool
    // instead of silently assigning them an arbitrary expert.
    const fillCount = min
    if (candidates.length < fillCount) {
      this.fail('roster', 'slot-undersupplied', `slot "${slot.id}" needs ${fillCount} qualified expert(s) but only ${candidates.length} candidate(s) claim [${slot.capabilities.join(', ')}]`)
      return
    }
    const chosen = this.selectAutoMembers(slot, candidates, fillCount)
    const fields = slot.diversity?.fields
    if (fields !== undefined && distinctDomains(chosen) < fields) {
      this.fail('roster', 'diversity-fields-unsatisfied', `slot "${slot.id}" declares diversity.fields = ${fields} but the chosen experts cover only ${distinctDomains(chosen)} distinct domain(s)`)
      return
    }
    for (const expert of chosen) this.roster.push(memberOf(expert, slot, approval))
    this.provenance.push({
      step: 'roster.resolve',
      detail: `slot=${slot.id} fill=${chosen.length} chosen=[${chosen.map(expert => expert.id).join(',')}] candidates=[${candidates.map(expert => expert.id).join(',')}]`,
    })
  }

  /**
   * Deterministic auto selection. Without `diversity.fields` this is pure
   * rank order. With it, the selection greedily maximizes distinct domains
   * (tie-break: higher rank, then lower id) and may grow beyond the
   * cardinality-driven fill count — up to `cardinality.max` — when more
   * distinct fields are needed; a still-unsatisfied constraint is reported
   * by the caller as `diversity-fields-unsatisfied`.
   */
  private selectAutoMembers(slot: RoleSlot, candidates: readonly ExpertV2[], fillCount: number): ExpertV2[] {
    const fields = slot.diversity?.fields
    if (fields === undefined) return candidates.slice(0, fillCount)
    const remaining = [...candidates]
    const chosen: ExpertV2[] = []
    const chosenDomains = new Set<string>()
    const newDomains = (expert: ExpertV2): number => {
      let count = 0
      for (const domain of expert.domains) {
        if (!chosenDomains.has(domain)) count++
      }
      return count
    }
    const pick = (): ExpertV2 | undefined => {
      let best: ExpertV2 | undefined
      let bestNew = -1
      for (const expert of remaining) {
        const gained = newDomains(expert)
        if (gained > bestNew) {
          best = expert
          bestNew = gained
        } else if (gained === bestNew && best !== undefined) {
          const rankDiff = rankExpert(expert, slot) - rankExpert(best, slot)
          if (rankDiff > 0 || (rankDiff === 0 && expert.id < best.id)) best = expert
        }
      }
      return best
    }
    const add = (expert: ExpertV2 | undefined): void => {
      if (expert === undefined) return
      chosen.push(expert)
      for (const domain of expert.domains) chosenDomains.add(domain)
      const index = remaining.indexOf(expert)
      if (index !== -1) remaining.splice(index, 1)
    }
    while (chosen.length < fillCount) add(pick())
    // Diversity may justify more members than the fill count (≤ cardinality.max).
    if (fields !== undefined) {
      while (chosen.length < slot.cardinality.max && chosenDomains.size < fields) {
        const next = pick()
        if (next === undefined || newDomains(next) === 0) break
        add(next)
      }
    }
    return chosen
  }

  /**
   * Distinct experts selected into the roster (an expert rostered in several
   * slots counts once).
   */
  private rosterExperts(): ExpertV2[] {
    const byId = new Map<string, ExpertV2>()
    for (const expert of this.pack.experts) byId.set(expert.id, expert)
    const out: ExpertV2[] = []
    const seen = new Set<string>()
    for (const member of this.roster) {
      const expert = byId.get(member.expertId)
      if (expert !== undefined && !seen.has(expert.id)) {
        seen.add(expert.id)
        out.push(expert)
      }
    }
    return out
  }

  /**
   * Roster-level enforcement of `ScenarioV2.requiredCapabilities`: at least
   * `cardinality` (default 1) distinct rostered experts must claim each
   * required capability at `>= minProficiency` (default 1). This is an
   * expert-claim check only — it never forces a ToolProvider (allowedProviders
   * constrains tool resolution only when the capability is used as a tool).
   */
  private checkScenarioRosterRequirements(): void {
    const scenario = this.scenario
    if (scenario === undefined) return
    const experts = this.rosterExperts()
    for (const requirement of scenario.requiredCapabilities) {
      const min = requirement.minProficiency ?? 1
      const claiming = experts.filter(expert =>
        expert.capabilities.some(claim => claim.capability === requirement.capability && claim.proficiency >= min))
      if (claiming.length === 0) {
        this.fail('roster', 'required-capability-unsatisfied',
          `scenario "${scenario.id}" requires capability "${requirement.capability}" at minProficiency ${min} but no rostered expert claims it`)
        continue
      }
      const need = requirement.cardinality ?? 1
      if (claiming.length < need) {
        this.fail('roster', 'required-capability-cardinality',
          `scenario "${scenario.id}" requires ${need} distinct rostered expert(s) claiming "${requirement.capability}" at minProficiency ${min} but only ${claiming.length} qualify`)
      }
    }
  }

  /* ----- step 6: gate chain ----- */

  private compileGates(): void {
    const template = this.template
    if (template === undefined) return
    const policyById = new Map<string, QualityPolicy>()
    for (const policy of this.pack.qualityPolicies) policyById.set(policy.id, policy)
    const taskIds = new Set(template.tasks.map(task => task.id))
    const seenBindings = new Set<string>()
    const candidates: Array<{ gate: CompiledGate; phaseIndex: number; policyGateIndex: number; bindingIndex: number; gateId: string }> = []
    template.gates.forEach((binding, bindingIndex) => {
      const policy = policyById.get(binding.policy)
      if (policy === undefined) {
        this.fail('template', 'unknown-quality-policy', `gate binding references unknown quality policy "${binding.policy}"`)
        return
      }
      const gateIndex = policy.gates.findIndex(gate => gate.id === binding.gate)
      const spec = gateIndex === -1 ? undefined : policy.gates[gateIndex]
      if (spec === undefined) {
        this.fail('template', 'unknown-gate', `gate binding references unknown gate "${binding.gate}" in policy "${policy.id}"`)
        return
      }
      // Dedupe identical policy/gate bindings deterministically: keep the
      // first occurrence (lowest binding index), warn about the rest.
      const bindingKey = `${policy.id}/${spec.id}`
      if (seenBindings.has(bindingKey)) {
        this.warn('duplicate-gate-binding', `gate binding "${bindingKey}" is declared more than once in template "${template.id}"; keeping the first occurrence`)
        return
      }
      seenBindings.add(bindingKey)
      const appliesTo = binding.appliesTo.length > 0 ? binding.appliesTo : spec.appliesTo
      for (const target of appliesTo) {
        if (target !== 'deliverable' && !taskIds.has(target)) {
          this.warn('unresolved-gate-target', `gate "${binding.gate}" applies to "${target}" which is neither a task id nor 'deliverable'`)
        }
      }
      const phase = spec.phase ?? defaultPhaseForKind(spec.kind)
      candidates.push({
        gate: {
          id: `${policy.id}/${spec.id}`,
          kind: spec.kind,
          phase,
          chainOrder: 0,
          policyId: policy.id,
          policyVersion: policy.version,
          gateId: spec.id,
          severity: spec.severity,
          appliesTo: [...appliesTo],
          ...(spec.implementation === undefined ? {} : { implementation: spec.implementation }),
          ...(spec.config === undefined ? {} : { config: { ...spec.config } }),
        },
        phaseIndex: phaseRank(phase),
        policyGateIndex: gateIndex,
        bindingIndex,
        gateId: spec.id,
      })
      if (!this.qualityPolicyRefs.some(ref => ref.id === policy.id)) {
        this.qualityPolicyRefs.push({ id: policy.id, version: policy.version })
      }
    })
    const sorted = [...candidates].sort((a, b) =>
      a.phaseIndex - b.phaseIndex
      || a.policyGateIndex - b.policyGateIndex
      || a.bindingIndex - b.bindingIndex
      || compareIds(a.gateId, b.gateId))
    this.gates = sorted.map((candidate, index) => ({ ...candidate.gate, chainOrder: index }))
  }

  /* ----- step 7: deliverables ----- */

  private compileDeliverables(): void {
    const template = this.template
    if (template === undefined) return
    const taskIds = new Set(template.tasks.map(task => task.id))
    const outputById = new Map<string, OutputTemplate>()
    for (const output of this.pack.outputTemplates) outputById.set(output.id, output)
    const renderMode = this.input.binding?.renderMode
    for (const deliverable of template.deliverables) {
      const output = outputById.get(deliverable.outputTemplate)
      if (output === undefined) {
        this.fail('template', 'unknown-output-template', `deliverable "${deliverable.id}" references unknown output template "${deliverable.outputTemplate}"`)
        continue
      }
      for (const taskId of deliverable.fromTasks) {
        if (!taskIds.has(taskId)) {
          this.fail('template', 'unknown-from-task', `deliverable "${deliverable.id}" collects from unknown task "${taskId}"`)
        }
      }
      if (!this.outputTemplateRefs.some(ref => ref.id === output.id)) {
        this.outputTemplateRefs.push({ id: output.id, version: output.version })
      }
      this.deliverables.push({
        id: deliverable.id,
        outputTemplate: deliverable.outputTemplate,
        fromTasks: [...deliverable.fromTasks],
        ...(renderMode !== undefined ? { renderMode } : deliverable.renderMode === undefined ? {} : { renderMode: deliverable.renderMode }),
      })
    }
    if (this.scenario !== undefined) {
      // Local capture: `this.scenario` narrowing does not survive into the
      // arrow-function closures below.
      const scenario = this.scenario
      const output = outputById.get(scenario.outputTemplate)
      if (output !== undefined && !this.outputTemplateRefs.some(ref => ref.id === output.id)) {
        this.outputTemplateRefs.push({ id: output.id, version: output.version })
      }
      const policy = this.pack.qualityPolicies.find(candidate => candidate.id === scenario.qualityPolicy)
      if (policy !== undefined && !this.qualityPolicyRefs.some(ref => ref.id === policy.id)) {
        this.qualityPolicyRefs.push({ id: policy.id, version: policy.version })
      }
    }
  }

  /* ----- step 8: compile the task DAG ----- */

  private compileTasks(): CompiledTask[] {
    const template = this.template
    if (template === undefined) return []
    const expertIdsByRole = new Map<string, string[]>()
    for (const member of this.roster) {
      const list = expertIdsByRole.get(member.slotId)
      if (list === undefined) expertIdsByRole.set(member.slotId, [member.expertId])
      else list.push(member.expertId)
    }
    return template.tasks.map(task => ({
      id: task.id,
      role: task.role,
      expertIds: [...(expertIdsByRole.get(task.role) ?? [])],
      dependsOn: [...task.dependsOn],
      inputs: task.inputs.map(input => this.compileInput(task, input)),
      allowedCapabilities: [...task.allowedCapabilities],
      outputSchema: task.outputSchema,
      retryPolicy: task.retryPolicy,
      ...(task.subject === undefined ? {} : { subject: task.subject }),
      ...(task.description === undefined ? {} : { description: task.description }),
    }))
  }

  private compileInput(task: TaskTemplate, input: InputBinding): CompiledInput {
    const base: CompiledInput = { kind: input.kind, ref: input.ref }
    switch (input.kind) {
      case 'task-output':
        return { ...base, fromTask: input.ref }
      case 'parameter':
        return { ...base, parameterKey: input.ref }
      case 'tool-capability': {
        const resolved = this.resolvedCapabilities.get(input.ref)
        if (resolved === undefined) return base
        return {
          ...base,
          providerId: resolved.providerId,
          operation: resolved.operation,
          ...(resolved.transportId === undefined ? {} : { transportId: resolved.transportId }),
        }
      }
      case 'knowledge': {
        const resolved = this.resolvedKnowledge.get(input.ref)
        if (resolved === undefined) return base
        return { ...base, providerId: resolved.providerId, ...(resolved.scope === undefined ? {} : { scope: resolved.scope }) }
      }
      default:
        return base
    }
  }

  /* ----- step 9: freeze & stamp ----- */

  private buildPlan(): ExecutionPlan {
    const template = this.template
    if (template === undefined) throw new Error('internal: buildPlan called without a template')
    const scenario = this.scenario
    const templateRef = { id: template.id, version: template.version }
    const scenarioRef = scenario === undefined ? undefined : { id: scenario.id, version: scenario.version }
    // Digest over the *executable core* only (template/bindings/params/dag);
    // descriptive provenance is deliberately excluded (§4.3 "模板/绑定/参数 digest").
    const core = {
      schemaVersion: SCHEMA_VERSION,
      template: templateRef,
      scenario: scenarioRef,
      params: this.params,
      roster: this.roster,
      tasks: this.tasks,
      executionOrder: this.executionOrder,
      gates: this.gates,
      deliverables: this.deliverables,
      bindings: {
        tool: this.toolBindings,
        knowledge: this.knowledgeBindings,
        outputTemplates: this.outputTemplateRefs,
        qualityPolicies: this.qualityPolicyRefs,
      },
    }
    const digest = canonicalDigest(core)
    return {
      schemaVersion: SCHEMA_VERSION,
      planId: `ep-${digest.slice(0, 16)}`,
      digest,
      template: templateRef,
      ...(scenarioRef === undefined ? {} : { scenario: scenarioRef }),
      params: this.params,
      roster: this.roster,
      tasks: this.tasks,
      executionOrder: this.executionOrder,
      gates: this.gates,
      deliverables: this.deliverables,
      bindings: core.bindings,
      provenance: this.provenance,
    }
  }
}

/** Compile one TeamTemplate into an immutable ExecutionPlan (see module doc). */
export function compileExecutionPlan(input: CompileInput): CompileResult {
  return new Compiler(input).compile()
}
