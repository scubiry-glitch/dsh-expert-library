/**
 * Explicit Expert Teams profiles.
 *
 * Profiles are deliberately a data-only boundary.  They describe the roster,
 * model routes and review policy that a staged plan may use; they never create
 * a team, spawn a member or write state.  `taskPlanning: 'seed'` points at a
 * fixed DAG/template, while `taskPlanning: 'captain'` carries no task graph so
 * the Captain can propose one during the staged phase.
 *
 * @module dsh-expert-library/profiles
 */

export const PROFILE_SCHEMA_VERSION = 1 as const

export type ProfileTaskPlanning = 'captain' | 'seed'

/** A provider/model route captured by a profile. */
export interface ProfileModelRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One optional fallback route, tried in declaration order. */
export interface ProfileFallbackRoute extends ProfileModelRoute {
  readonly reason?: string
}

/** A fixed member slot in a profile roster. */
export interface ProfileMember {
  /** Stable slot id. Defaults to `name` after parsing. */
  readonly id: string
  /** Display/member name, unique within a profile. */
  readonly name: string
  readonly role?: string
  /** Expert Library profile id used to hydrate persona/knowledge. */
  readonly expert?: string
  /** Per-member route; otherwise the profile route/default is used. */
  readonly route?: ProfileModelRoute
  /** Capability ids available to this member's tasks. */
  readonly capabilities?: readonly string[]
  /** Delegation depth for this member; zero means no child delegation. */
  readonly maxDepth?: number
}

/** Fixed quality constraints carried into a staged plan. */
export interface ProfileReviewPolicy {
  readonly required?: boolean
  readonly maxRepairRounds?: number
  readonly hardGateIds?: readonly string[]
}

/** A task used by a seed profile's fixed DAG. */
export interface ProfileSeedTask {
  readonly id: string
  readonly subject: string
  readonly description?: string
  readonly owner?: string
  readonly dependsOn: readonly string[]
  readonly acceptance?: readonly string[]
}

/** JSON-safe profile definition. */
export interface ExpertTeamProfile {
  readonly schemaVersion: typeof PROFILE_SCHEMA_VERSION
  readonly id: string
  readonly version: string
  readonly description: string
  /** A string is accepted at the input boundary and normalized to one item. */
  readonly protocol: readonly string[]
  readonly members: readonly ProfileMember[]
  readonly route?: ProfileModelRoute
  readonly fallback?: readonly ProfileFallbackRoute[]
  readonly taskPlanning: ProfileTaskPlanning
  /** Optional quality/review contract bound to a staged plan. */
  readonly review?: ProfileReviewPolicy
  /** Existing declarative template used by a seed profile. */
  readonly templateId?: string
  /** Explicit fixed DAG; forbidden for captain profiles. */
  readonly tasks?: readonly ProfileSeedTask[]
}

export interface ProfileValidationIssue {
  readonly code:
  | 'invalid-type'
  | 'required'
  | 'unknown-key'
  | 'invalid-id'
  | 'invalid-value'
  | 'duplicate-member'
  | 'duplicate-task'
  | 'unknown-dependency'
  | 'dependency-cycle'
  | 'captain-dag'
  | 'seed-dag'
  readonly path: string
  readonly message: string
}

export type ProfileValidationResult =
  | { readonly ok: true; readonly profile: ExpertTeamProfile }
  | { readonly ok: false; readonly issues: readonly ProfileValidationIssue[] }

/** Stable error thrown by {@link parseProfile} for invalid profile data. */
export class ProfileValidationError extends Error {
  readonly code = 'profile-invalid'
  readonly issues: readonly ProfileValidationIssue[]

  constructor(issues: readonly ProfileValidationIssue[]) {
    super(issues.map(issue => `${issue.path}: ${issue.message}`).join('; ') || 'invalid profile')
    this.name = 'ProfileValidationError'
    this.issues = issues
  }
}

const PROFILE_KEYS = new Set([
  'schemaVersion', 'id', 'version', 'description', 'protocol', 'members',
  'route', 'fallback', 'taskPlanning', 'review', 'templateId', 'tasks',
])
const ROUTE_KEYS = new Set(['provider', 'model', 'reasoningEffort', 'reason'])
const MEMBER_KEYS = new Set(['id', 'name', 'role', 'expert', 'route', 'provider', 'model', 'reasoningEffort', 'capabilities', 'maxDepth'])
const REVIEW_KEYS = new Set(['required', 'maxRepairRounds', 'hardGateIds'])
const TASK_KEYS = new Set(['id', 'subject', 'description', 'owner', 'dependsOn', 'acceptance'])
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function addUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: ProfileValidationIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push({ code: 'unknown-key', path: `${path}.${key}`, message: 'unknown profile field' })
  }
}

function idIssue(value: unknown, path: string, issues: ProfileValidationIssue[], label = 'id'): value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    issues.push({ code: 'invalid-id', path, message: `${label} must match ${SAFE_ID.source}` })
    return false
  }
  return true
}

function requiredText(value: unknown, path: string, issues: ProfileValidationIssue[], label: string): value is string {
  if (!text(value)) {
    issues.push({ code: typeof value === 'undefined' ? 'required' : 'invalid-value', path, message: `${label} must be a non-empty string` })
    return false
  }
  return true
}

function parseRoute(
  value: unknown,
  path: string,
  issues: ProfileValidationIssue[],
  allowReason: boolean,
): ProfileModelRoute | ProfileFallbackRoute | undefined {
  if (!record(value)) {
    issues.push({ code: 'invalid-type', path, message: 'route must be an object' })
    return undefined
  }
  addUnknownKeys(value, allowReason ? ROUTE_KEYS : new Set(['provider', 'model', 'reasoningEffort']), path, issues)
  const providerValue = value.provider
  const modelValue = value.model
  const provider = requiredText(providerValue, `${path}.provider`, issues, 'provider')
  const model = requiredText(modelValue, `${path}.model`, issues, 'model')
  if (value.reasoningEffort !== undefined && !text(value.reasoningEffort)) {
    issues.push({ code: 'invalid-value', path: `${path}.reasoningEffort`, message: 'reasoningEffort must be a non-empty string when present' })
  }
  if (allowReason && value.reason !== undefined && !text(value.reason)) {
    issues.push({ code: 'invalid-value', path: `${path}.reason`, message: 'reason must be a non-empty string when present' })
  }
  if (!provider || !model) return undefined
  const reasoningEffort = text(value.reasoningEffort) ? value.reasoningEffort.trim() : undefined
  const reason = allowReason && text(value.reason) ? value.reason.trim() : undefined
  return {
    provider: (providerValue as string).trim(),
    model: (modelValue as string).trim(),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(reason === undefined ? {} : { reason }),
  } as ProfileModelRoute | ProfileFallbackRoute
}

function parseStringList(value: unknown, path: string, issues: ProfileValidationIssue[], label: string): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ code: 'invalid-type', path, message: `${label} must be an array of strings` })
    return undefined
  }
  const out: string[] = []
  for (const [index, item] of value.entries()) {
    if (!text(item)) {
      issues.push({ code: 'invalid-value', path: `${path}[${index}]`, message: `${label} entries must be non-empty strings` })
      continue
    }
    out.push(item.trim())
  }
  return out
}

function parseMember(value: unknown, index: number, issues: ProfileValidationIssue[]): ProfileMember | undefined {
  const path = `members[${index}]`
  if (!record(value)) {
    issues.push({ code: 'invalid-type', path, message: 'member must be an object' })
    return undefined
  }
  addUnknownKeys(value, MEMBER_KEYS, path, issues)
  const nameValue = value.name
  const name = requiredText(nameValue, `${path}.name`, issues, 'member name')
  const memberId = value.id === undefined ? (name ? (nameValue as string).trim() : '') : value.id
  const idValid = idIssue(memberId, `${path}.id`, issues, 'member id')
  if (value.role !== undefined && !text(value.role)) issues.push({ code: 'invalid-value', path: `${path}.role`, message: 'role must be a non-empty string when present' })
  if (value.expert !== undefined && !text(value.expert)) issues.push({ code: 'invalid-value', path: `${path}.expert`, message: 'expert must be a non-empty string when present' })
  const role = text(value.role) ? value.role.trim() : undefined
  const expert = text(value.expert) ? value.expert.trim() : undefined
  const capabilities = value.capabilities === undefined ? undefined : parseStringList(value.capabilities, `${path}.capabilities`, issues, 'capabilities')
  if (value.maxDepth !== undefined && (!Number.isInteger(value.maxDepth) || (value.maxDepth as number) < 0)) {
    issues.push({ code: 'invalid-value', path: `${path}.maxDepth`, message: 'maxDepth must be a non-negative integer' })
  }
  let route: ProfileModelRoute | undefined
  const directRoutePresent = value.provider !== undefined || value.model !== undefined || value.reasoningEffort !== undefined
  if (value.route !== undefined && directRoutePresent) {
    issues.push({ code: 'invalid-value', path: `${path}.route`, message: 'use route or provider/model fields, not both' })
  } else if (value.route !== undefined) {
    route = parseRoute(value.route, `${path}.route`, issues, false) as ProfileModelRoute | undefined
  } else if (directRoutePresent) {
    route = parseRoute({ provider: value.provider, model: value.model, reasoningEffort: value.reasoningEffort }, `${path}.route`, issues, false) as ProfileModelRoute | undefined
  }
  if (!name || !idValid) return undefined
  return {
    id: (memberId as string).trim(),
    name: (nameValue as string).trim(),
    ...(role === undefined ? {} : { role }),
    ...(expert === undefined ? {} : { expert }),
    ...(route === undefined ? {} : { route }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(value.maxDepth === undefined ? {} : { maxDepth: value.maxDepth as number }),
  }
}

function parseTask(value: unknown, index: number, issues: ProfileValidationIssue[]): ProfileSeedTask | undefined {
  const path = `tasks[${index}]`
  if (!record(value)) {
    issues.push({ code: 'invalid-type', path, message: 'task must be an object' })
    return undefined
  }
  addUnknownKeys(value, TASK_KEYS, path, issues)
  const id = idIssue(value.id, `${path}.id`, issues, 'task id')
  const subjectValue = value.subject
  const subject = requiredText(subjectValue, `${path}.subject`, issues, 'task subject')
  const dependsOn = value.dependsOn === undefined ? [] : parseStringList(value.dependsOn, `${path}.dependsOn`, issues, 'dependsOn')
  const acceptance = value.acceptance === undefined ? undefined : parseStringList(value.acceptance, `${path}.acceptance`, issues, 'acceptance')
  if (value.description !== undefined && !text(value.description)) issues.push({ code: 'invalid-value', path: `${path}.description`, message: 'description must be a non-empty string when present' })
  if (value.owner !== undefined && !text(value.owner)) issues.push({ code: 'invalid-value', path: `${path}.owner`, message: 'owner must be a non-empty string when present' })
  const description = text(value.description) ? value.description.trim() : undefined
  const owner = text(value.owner) ? value.owner.trim() : undefined
  if (!id || !subject || dependsOn === undefined) return undefined
  return {
    id: value.id as string,
    subject: (subjectValue as string).trim(),
    ...(description === undefined ? {} : { description }),
    ...(owner === undefined ? {} : { owner }),
    dependsOn,
    ...(acceptance === undefined ? {} : { acceptance }),
  }
}

function validateDag(tasks: readonly ProfileSeedTask[], members: readonly ProfileMember[], issues: ProfileValidationIssue[]): void {
  const byId = new Set<string>()
  for (const [index, task] of tasks.entries()) {
    if (byId.has(task.id)) issues.push({ code: 'duplicate-task', path: `tasks[${index}].id`, message: `duplicate task id "${task.id}"` })
    byId.add(task.id)
  }
  const memberNames = new Set(members.flatMap(member => [member.name, member.id]))
  for (const [index, task] of tasks.entries()) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) issues.push({ code: 'unknown-dependency', path: `tasks[${index}].dependsOn`, message: `unknown dependency "${dependency}"` })
    }
    if (task.owner !== undefined && task.owner !== 'captain' && !memberNames.has(task.owner)) {
      issues.push({ code: 'invalid-value', path: `tasks[${index}].owner`, message: `unknown task owner "${task.owner}"` })
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byTask = new Map(tasks.map(task => [task.id, task]))
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      issues.push({ code: 'dependency-cycle', path: 'tasks', message: `task dependency cycle includes "${id}"` })
      return
    }
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byTask.get(id)?.dependsOn ?? []) if (byTask.has(dependency)) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks) visit(task.id)
}

/** Validate and normalize a profile without any filesystem or runtime effects. */
export function validateProfile(value: unknown): ProfileValidationResult {
  const issues: ProfileValidationIssue[] = []
  if (!record(value)) {
    return { ok: false, issues: [{ code: 'invalid-type', path: '', message: 'profile must be an object' }] }
  }
  addUnknownKeys(value, PROFILE_KEYS, '', issues)
  if (value.schemaVersion !== PROFILE_SCHEMA_VERSION) issues.push({ code: 'invalid-value', path: 'schemaVersion', message: `schemaVersion must be ${PROFILE_SCHEMA_VERSION}` })
  const idValue = value.id
  const versionValue = value.version
  const descriptionValue = value.description
  const id = idIssue(idValue, 'id', issues, 'profile id')
  const version = requiredText(versionValue, 'version', issues, 'version')
  const description = requiredText(descriptionValue, 'description', issues, 'description')
  let protocol: string[] | undefined
  if (typeof value.protocol === 'string' && value.protocol.trim() !== '') protocol = [value.protocol.trim()]
  else if (Array.isArray(value.protocol)) protocol = parseStringList(value.protocol, 'protocol', issues, 'protocol')
  else issues.push({ code: typeof value.protocol === 'undefined' ? 'required' : 'invalid-value', path: 'protocol', message: 'protocol must be a non-empty string or string array' })
  if (!Array.isArray(value.members)) issues.push({ code: typeof value.members === 'undefined' ? 'required' : 'invalid-type', path: 'members', message: 'members must be an array' })
  const members: ProfileMember[] = []
  if (Array.isArray(value.members)) {
    if (value.members.length < 1 || value.members.length > 32) issues.push({ code: 'invalid-value', path: 'members', message: 'members must contain between 1 and 32 entries' })
    for (const [index, memberValue] of value.members.entries()) {
      const member = parseMember(memberValue, index, issues)
      if (member !== undefined) members.push(member)
    }
  }
  const names = new Set<string>()
  const ids = new Set<string>()
  for (const [index, member] of members.entries()) {
    if (names.has(member.name) || ids.has(member.id)) issues.push({ code: 'duplicate-member', path: `members[${index}]`, message: `duplicate member name or id "${member.name}"` })
    names.add(member.name)
    ids.add(member.id)
  }
  const taskPlanning = value.taskPlanning === 'captain' || value.taskPlanning === 'seed' ? value.taskPlanning : undefined
  if (taskPlanning === undefined) issues.push({ code: 'invalid-value', path: 'taskPlanning', message: 'taskPlanning must be "captain" or "seed"' })
  const route = value.route === undefined ? undefined : parseRoute(value.route, 'route', issues, false) as ProfileModelRoute | undefined
  let fallback: ProfileFallbackRoute[] | undefined
  if (value.fallback !== undefined) {
    if (!Array.isArray(value.fallback)) issues.push({ code: 'invalid-type', path: 'fallback', message: 'fallback must be an array of routes' })
    else {
      fallback = []
      for (const [index, item] of value.fallback.entries()) {
        const parsed = parseRoute(item, `fallback[${index}]`, issues, true) as ProfileFallbackRoute | undefined
        if (parsed !== undefined) fallback.push(parsed)
      }
    }
  }
  let review: ProfileReviewPolicy | undefined
  if (value.review !== undefined) {
    if (!record(value.review)) issues.push({ code: 'invalid-type', path: 'review', message: 'review must be an object' })
    else {
      addUnknownKeys(value.review, REVIEW_KEYS, 'review', issues)
      if (value.review.required !== undefined && typeof value.review.required !== 'boolean') issues.push({ code: 'invalid-value', path: 'review.required', message: 'required must be boolean' })
      if (value.review.maxRepairRounds !== undefined && (!Number.isInteger(value.review.maxRepairRounds) || (value.review.maxRepairRounds as number) < 0 || (value.review.maxRepairRounds as number) > 2)) issues.push({ code: 'invalid-value', path: 'review.maxRepairRounds', message: 'maxRepairRounds must be an integer from 0 to 2' })
      const hardGateIds = value.review.hardGateIds === undefined ? undefined : parseStringList(value.review.hardGateIds, 'review.hardGateIds', issues, 'hardGateIds')
      review = {
        ...(value.review.required === undefined ? {} : { required: value.review.required as boolean }),
        ...(value.review.maxRepairRounds === undefined ? {} : { maxRepairRounds: value.review.maxRepairRounds as number }),
        ...(hardGateIds === undefined ? {} : { hardGateIds }),
      }
    }
  }
  const templateId = value.templateId === undefined ? undefined : (idIssue(value.templateId, 'templateId', issues, 'templateId') ? (value.templateId as string) : undefined)
  const tasks: ProfileSeedTask[] = []
  if (value.tasks !== undefined) {
    if (!Array.isArray(value.tasks)) issues.push({ code: 'invalid-type', path: 'tasks', message: 'tasks must be an array' })
    else for (const [index, taskValue] of value.tasks.entries()) {
      const task = parseTask(taskValue, index, issues)
      if (task !== undefined) tasks.push(task)
    }
  }
  if (taskPlanning === 'captain' && (templateId !== undefined || value.tasks !== undefined)) {
    issues.push({ code: 'captain-dag', path: 'taskPlanning', message: 'captain profiles must not carry a fixed templateId or task DAG' })
  }
  if (taskPlanning === 'seed' && templateId === undefined && tasks.length === 0) {
    issues.push({ code: 'seed-dag', path: 'taskPlanning', message: 'seed profiles require templateId or at least one task' })
  }
  if (tasks.length > 0) validateDag(tasks, members, issues)
  if (issues.length > 0 || !id || !version || !description || protocol === undefined || taskPlanning === undefined) return { ok: false, issues }
  return {
    ok: true,
    profile: {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      id: (idValue as string).trim(),
      version: (versionValue as string).trim(),
      description: (descriptionValue as string).trim(),
      protocol,
      members,
      ...(route === undefined ? {} : { route }),
      ...(fallback === undefined ? {} : { fallback }),
      taskPlanning,
      ...(review === undefined ? {} : { review }),
      ...(templateId === undefined ? {} : { templateId: templateId.trim() }),
      ...(tasks.length === 0 ? {} : { tasks }),
    },
  }
}

/** Parse and normalize one profile, throwing before any runtime side effect. */
export function parseProfile(value: unknown): ExpertTeamProfile {
  const result = validateProfile(value)
  if (!result.ok) throw new ProfileValidationError(result.issues)
  return result.profile
}

/** Type guard for already normalized profile data. */
export function isExpertTeamProfile(value: unknown): value is ExpertTeamProfile {
  return validateProfile(value).ok
}

export type ProfileCatalog = ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>> | Iterable<unknown>

/**
 * Resolve only an explicit profile id.  Free-form goals, prefixes and fuzzy
 * matches are intentionally rejected so ordinary user text cannot silently
 * select a profile.
 */
export function resolveProfile(catalog: ProfileCatalog, requestedId: string): ExpertTeamProfile {
  if (typeof requestedId !== 'string' || requestedId.trim() !== requestedId || !SAFE_ID.test(requestedId)) {
    throw new ProfileValidationError([{ code: 'invalid-id', path: 'profile', message: 'profile must be an explicit id with no surrounding whitespace' }])
  }
  let raw: unknown
  if (catalog instanceof Map) raw = catalog.get(requestedId)
  else if (typeof catalog === 'object' && catalog !== null
    && typeof (catalog as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') {
    raw = (catalog as Record<string, unknown>)[requestedId]
  } else {
    for (const item of catalog as Iterable<unknown>) {
      if (record(item) && item.id === requestedId) {
        raw = item
        break
      }
    }
  }
  if (raw === undefined) throw new ProfileValidationError([{ code: 'invalid-value', path: 'profile', message: `profile "${requestedId}" was not found` }])
  const profile = parseProfile(raw)
  if (profile.id !== requestedId) throw new ProfileValidationError([{ code: 'invalid-value', path: 'profile', message: `catalog entry "${requestedId}" has profile id "${profile.id}"` }])
  return profile
}
