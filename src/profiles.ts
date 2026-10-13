import { parseArtifactInputs, validatePlanArtifactFlow, type PlannedArtifactInput } from './plan-artifact-flow.ts'
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

import { canonicalDigest } from './v2/digest.ts'
import type { ExecutionPlan } from './v2/compiler.ts'
import type { ModelPolicy } from './v2/types.ts'
import { PROFILE_STAGE_EXAMPLE } from './profile-schema.ts'
import { isReportBundle, type ReportBundle } from './report-bundle.ts'
import { isTaskMaterialSelection, type TaskPromptBinding, type TaskSkillBinding } from './task-material-binding.ts'

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

/** Research analysis chosen in the same authenticated Host plan confirmation as the roster. */
export interface ProfileAnalysisFramework {
  readonly id: string
  readonly question: string
  readonly axes: readonly string[]
  readonly hypotheses: readonly string[]
  readonly falsifiers: readonly string[]
}

/** Route shortlist and proposed expert choice shown in the Host plan approval. */
export interface ProfileExpertSelection {
  readonly topic: string
  readonly question: string
  readonly routeFramework: string
  readonly candidateIds: readonly string[]
  readonly selectedIds: readonly string[]
}

/** A task used by a seed profile's fixed DAG. */
export interface ProfileSeedTask {
  readonly humanChoice?: { readonly sourceTaskId: string; readonly artifact: string; readonly options: readonly string[] }
  readonly produces?: readonly string[]
  readonly artifactInputs?: readonly PlannedArtifactInput[]
  readonly id: string
  readonly subject: string
  readonly description?: string
  readonly owner?: string
  readonly dependsOn: readonly string[]
  readonly acceptance?: readonly string[]
  readonly reportBundle?: ReportBundle
  readonly skillBindings?: readonly TaskSkillBinding[]
  readonly promptBinding?: TaskPromptBinding
  /** Data capabilities this task may invoke through expert_provider_call. */
  readonly allowedCapabilities?: readonly string[]
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
  readonly analysisFramework?: ProfileAnalysisFramework
  readonly expertSelection?: ProfileExpertSelection
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
    super(`${issues.slice(0, 12).map(issue => `${issue.path}: ${issue.message}`).join('; ') || 'invalid profile'}${issues.length > 12 ? `; ${issues.length - 12} more issue(s)` : ''}. Valid captain call shape (routes omitted to inherit configuration): ${JSON.stringify(PROFILE_STAGE_EXAMPLE)}`)
    this.name = 'ProfileValidationError'
    this.issues = issues
  }
}

const PROFILE_KEYS = new Set([
  'schemaVersion', 'id', 'version', 'description', 'protocol', 'members',
  'route', 'fallback', 'taskPlanning', 'review', 'templateId', 'tasks', 'analysisFramework', 'expertSelection',
])
const FRAMEWORK_KEYS = new Set(['id', 'question', 'axes', 'hypotheses', 'falsifiers'])
const EXPERT_SELECTION_KEYS = new Set(['topic', 'question', 'routeFramework', 'candidateIds', 'selectedIds'])
const ROUTE_KEYS = new Set(['provider', 'model', 'reasoningEffort', 'reason'])
const MEMBER_KEYS = new Set(['id', 'name', 'role', 'expert', 'route', 'provider', 'model', 'reasoningEffort', 'capabilities', 'maxDepth'])
const REVIEW_KEYS = new Set(['required', 'maxRepairRounds', 'hardGateIds'])
const TASK_KEYS = new Set(['id', 'subject', 'description', 'owner', 'dependsOn', 'dependencies', 'acceptance', 'reportBundle', 'produces', 'artifactInputs', 'humanChoice', 'skillBindings', 'promptBinding', 'allowedCapabilities'])
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
    if (!allowed.has(key)) {
      const aliases: Record<string, string> = { roster: 'members', reviewPolicy: 'review', dependencies: 'dependsOn', assignee: 'owner' }
      const replacement = aliases[key]
      issues.push({ code: 'unknown-key', path: path ? `${path}.${key}` : key,
        message: `unknown profile field${replacement !== undefined && allowed.has(replacement) ? `; use ${replacement} instead of ${key}` : ''}; allowed fields: ${[...allowed].join(', ')}` })
    }
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
  if (!provider || !model) {
    issues.push({ code: 'invalid-value', path, message: 'route requires both provider and model inside the same object: route: { provider: <configured provider>, model: <configured model> }; do not move model to the member level' })
    return undefined
  }
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
  // Validate both spellings before choosing the canonical representation.
  // An empty canonical field must never silently erase a nonempty alias.
  const canonicalDependencies = value.dependsOn === undefined ? undefined : parseStringList(value.dependsOn, `${path}.dependsOn`, issues, 'dependsOn')
  const aliasDependencies = value.dependencies === undefined ? undefined : parseStringList(value.dependencies, `${path}.dependencies`, issues, 'dependencies')
  if (canonicalDependencies !== undefined && aliasDependencies !== undefined) {
    const canonicalSet = new Set(canonicalDependencies)
    const aliasSet = new Set(aliasDependencies)
    if (canonicalSet.size !== aliasSet.size || [...canonicalSet].some(id => !aliasSet.has(id))) {
      issues.push({ code: 'invalid-value', path: `${path}.dependencies`, message: 'dependsOn and dependencies conflict; supply one field or the same task-id set in both. Preserve the intended prerequisites; the fields are never merged.' })
    }
  }
  const dependsOn = canonicalDependencies ?? aliasDependencies ?? []
  const produces = value.produces === undefined ? undefined : parseStringList(value.produces, `${path}.produces`, issues, 'produces')
  if (produces?.some(name => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/u.test(name))) issues.push({code:'invalid-value',path:`${path}.produces`,message:'produces must contain safe publication filenames'})
  let artifactInputs: PlannedArtifactInput[] | undefined
  try { if (value.artifactInputs !== undefined) artifactInputs = parseArtifactInputs(value.artifactInputs) }
  catch (error) { issues.push({code:'invalid-value',path:`${path}.artifactInputs`,message:String(error)}) }
  const acceptance = value.acceptance === undefined ? undefined : parseStringList(value.acceptance, `${path}.acceptance`, issues, 'acceptance')
  const allowedCapabilities = value.allowedCapabilities === undefined ? undefined : parseStringList(value.allowedCapabilities, `${path}.allowedCapabilities`, issues, 'allowedCapabilities')
  let humanChoice: ProfileSeedTask['humanChoice']
  if (value.humanChoice !== undefined) {
    const gate = value.humanChoice
    if (!record(gate) || Object.keys(gate).some(key => !['sourceTaskId', 'artifact', 'options'].includes(key))
      || !text(gate.sourceTaskId) || !text(gate.artifact) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/u.test(gate.artifact)
      || !Array.isArray(gate.options) || gate.options.length < 1 || gate.options.length > 8
      || gate.options.some(option => !text(option) || option.length > 80)
      || new Set(gate.options).size !== gate.options.length) {
      issues.push({ code: 'invalid-value', path: `${path}.humanChoice`, message: 'humanChoice requires sourceTaskId, safe published artifact, and 1–8 unique nonempty options' })
    } else humanChoice = { sourceTaskId: gate.sourceTaskId.trim(), artifact: gate.artifact.trim(), options: [...gate.options] as string[] }
  }
  if (value.reportBundle !== undefined && !isReportBundle(value.reportBundle)) {
    issues.push({ code: 'invalid-value', path: `${path}.reportBundle`, message: 'reportBundle requires exact safe publication filenames {md:"report.md",html:"report.html",pdf:"report.pdf"}' })
  }
  if (value.skillBindings !== undefined || value.promptBinding !== undefined) {
    if (!isTaskMaterialSelection(value.skillBindings, value.promptBinding)) issues.push({ code: 'invalid-value', path: `${path}.skillBindings`, message: 'skillBindings requires 1–4 distinct registered producer skills and one fixed plugin promptBinding' })
  }
  if (value.description !== undefined && !text(value.description)) issues.push({ code: 'invalid-value', path: `${path}.description`, message: 'description must be a non-empty string when present' })
  if (value.owner !== undefined && !text(value.owner)) issues.push({ code: 'invalid-value', path: `${path}.owner`, message: 'owner must be a non-empty string when present' })
  const description = text(value.description) ? value.description.trim() : undefined
  const owner = text(value.owner) ? value.owner.trim() : undefined
  if (!id || !subject
    || (value.dependsOn !== undefined && canonicalDependencies === undefined)
    || (value.dependencies !== undefined && aliasDependencies === undefined)) return undefined
  return {
    id: value.id as string,
    subject: (subjectValue as string).trim(),
    ...(description === undefined ? {} : { description }),
    ...(owner === undefined ? {} : { owner }),
    dependsOn,
    ...(produces === undefined ? {} : { produces }),
    ...(allowedCapabilities === undefined ? {} : { allowedCapabilities }),
    ...(artifactInputs === undefined ? {} : { artifactInputs }),    ...(acceptance === undefined ? {} : { acceptance }),
    ...(humanChoice === undefined ? {} : { humanChoice }),
    ...(isReportBundle(value.reportBundle) ? { reportBundle: structuredClone(value.reportBundle) } : {}),
    ...(isTaskMaterialSelection(value.skillBindings, value.promptBinding) ? { skillBindings: structuredClone(value.skillBindings as TaskSkillBinding[]), promptBinding: structuredClone(value.promptBinding as TaskPromptBinding) } : {}),
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
    if (task.humanChoice !== undefined) {
      const source = tasks.find(candidate => candidate.id === task.humanChoice!.sourceTaskId)
      if (task.owner !== 'captain' || source === undefined || !task.dependsOn.includes(source.id)
        || !source.produces?.includes(task.humanChoice.artifact)
        || task.produces !== undefined || task.reportBundle !== undefined
        || task.dependsOn.length !== 1
        || task.artifactInputs?.length !== 1
        || task.artifactInputs[0]?.fromTask !== source.id
        || task.artifactInputs[0]?.artifact !== task.humanChoice.artifact) {
        issues.push({ code: 'invalid-value', path: `tasks[${index}].humanChoice`, message: 'human choice must be captain-owned, depend only on one task publishing its candidate artifact, and declare that exact artifact input' })
      }
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
  if (!issues.length) try { validatePlanArtifactFlow(tasks) } catch (error) { issues.push({ code: 'invalid-value', path: 'tasks', message: String(error) }) }
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
  let analysisFramework: ProfileAnalysisFramework | undefined
  if (value.analysisFramework !== undefined) {
    const framework = value.analysisFramework
    if (!record(framework)) issues.push({ code: 'invalid-type', path: 'analysisFramework', message: 'analysisFramework must be an object' })
    else {
      addUnknownKeys(framework, FRAMEWORK_KEYS, 'analysisFramework', issues)
      const frameworkId = idIssue(framework.id, 'analysisFramework.id', issues, 'framework id')
      const question = requiredText(framework.question, 'analysisFramework.question', issues, 'research question')
      const axes = parseStringList(framework.axes, 'analysisFramework.axes', issues, 'axes')
      const hypotheses = parseStringList(framework.hypotheses, 'analysisFramework.hypotheses', issues, 'hypotheses')
      const falsifiers = parseStringList(framework.falsifiers, 'analysisFramework.falsifiers', issues, 'falsifiers')
      if (axes !== undefined && (axes.length < (value.version === '5.0.0' && value.id === '98wiki-deep-research' ? 1 : 2) || axes.length > 6)) issues.push({ code: 'invalid-value', path: 'analysisFramework.axes', message: 'research framework needs 1..6 axes for V5, otherwise 2..6' })
      if (hypotheses !== undefined && (hypotheses.length < (value.version === '5.0.0' && value.id === '98wiki-deep-research' ? 1 : 2) || hypotheses.length > 8)) issues.push({ code: 'invalid-value', path: 'analysisFramework.hypotheses', message: 'research framework needs 1..8 hypotheses for V5, otherwise 2..8' })
      if (falsifiers !== undefined && (falsifiers.length < 1 || falsifiers.length > 8)) issues.push({ code: 'invalid-value', path: 'analysisFramework.falsifiers', message: 'research framework needs 1..8 falsifiers' })
      if (frameworkId && question && axes !== undefined && hypotheses !== undefined && falsifiers !== undefined) {
        analysisFramework = { id: (framework.id as string).trim(), question: (framework.question as string).trim(), axes, hypotheses, falsifiers }
      }
    }
  }
  let expertSelection: ProfileExpertSelection | undefined
  if (value.expertSelection !== undefined) {
    const selection = value.expertSelection
    if (!record(selection)) issues.push({ code: 'invalid-type', path: 'expertSelection', message: 'expertSelection must be an object' })
    else {
      addUnknownKeys(selection, EXPERT_SELECTION_KEYS, 'expertSelection', issues)
      const topic = requiredText(selection.topic, 'expertSelection.topic', issues, 'route topic')
      const question = requiredText(selection.question, 'expertSelection.question', issues, 'route question')
      const routeFramework = requiredText(selection.routeFramework, 'expertSelection.routeFramework', issues, 'route framework')
      const candidateIds = parseStringList(selection.candidateIds, 'expertSelection.candidateIds', issues, 'route candidate ids')
      const selectedIds = parseStringList(selection.selectedIds, 'expertSelection.selectedIds', issues, 'selected expert ids')
      if (topic && question && routeFramework && candidateIds !== undefined && selectedIds !== undefined)
        expertSelection = { topic: (selection.topic as string).trim(), question: (selection.question as string).trim(),
          routeFramework: (selection.routeFramework as string).trim(), candidateIds, selectedIds }
    }
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
      if (value.review.maxRepairRounds !== undefined && (!Number.isInteger(value.review.maxRepairRounds) || (value.review.maxRepairRounds as number) < 0 || (value.review.maxRepairRounds as number) > 20)) issues.push({ code: 'invalid-value', path: 'review.maxRepairRounds', message: 'maxRepairRounds must be an integer from 0 to 20' })
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
    issues.push({ code: 'captain-dag', path: 'taskPlanning', message: 'captain profiles must not carry a fixed templateId or task DAG; place generated tasks at tool top level, outside profile' })
  }
  // The explicit profile tool has no template catalog resolver: accepting a
  // templateId without a materialized task DAG would therefore compile an
  // empty team while claiming to be a fixed seed plan. Keep this boundary
  // fail-closed until a real template hydration path exists.
  if (taskPlanning === 'seed' && tasks.length === 0) {
    issues.push({ code: 'seed-dag', path: 'tasks', message: 'seed profiles require at least one task; templateId alone cannot materialize a DAG' })
  }
  if (tasks.length > 0) validateDag(tasks, members, issues)
  if (review?.required === false && tasks.some(task => task.reportBundle !== undefined)) issues.push({ code: 'invalid-value', path: 'review.required', message: 'reportBundle requires structured independent review; required cannot be false' })
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
      ...(analysisFramework === undefined ? {} : { analysisFramework }),
      ...(expertSelection === undefined ? {} : { expertSelection }),
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

/**
 * Turn a validated profile into the same immutable execution-plan shape used
 * by scenario compilation. This is intentionally a small, dependency-free
 * adapter: seed profiles provide their declared DAG, while captain profiles
 * provide only the roster and leave the task list empty for a later staged
 * edit. No team or member is created here.
 */
export function profileToExecutionPlan(
  profile: ExpertTeamProfile,
  params: Readonly<Record<string, unknown>> = {},
): ExecutionPlan {
  const memberByName = new Map<string, ProfileMember>()
  const roster = profile.members.map(member => {
    memberByName.set(member.name, member)
    memberByName.set(member.id, member)
    const model = member.route ?? profile.route
    return {
      slotId: member.id,
      expertId: member.id,
      ...(member.expert === undefined ? {} : { sourceExpertId: member.expert }),
      profileId: profile.id,
      ...(model === undefined ? {} : { modelPolicy: { ...model }, modelRouteSource: member.route === undefined ? 'profile-default' as const : 'profile-member' as const }),
      ...(profile.fallback === undefined ? {} : { fallbackRoutes: profile.fallback.map(route => ({
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      })) as readonly ModelPolicy[] }),
      displayName: member.name,
      ...(member.role === undefined ? {} : { role: member.role }),
      ...(member.capabilities === undefined ? {} : { capabilities: [...member.capabilities] }),
      ...(member.maxDepth === undefined ? {} : { maxDepth: member.maxDepth }),
      approval: 'none' as const,
    }
  })
  const declaredTasks = profile.tasks ?? []
  const taskById = new Map(declaredTasks.map(task => [task.id, task]))
  const executionOrder: string[] = []
  const remaining = new Set(declaredTasks.map(task => task.id))
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(id => (taskById.get(id)?.dependsOn ?? []).every(dep => executionOrder.includes(dep)))
      .sort()
    if (ready.length === 0) throw new ProfileValidationError([{ code: 'dependency-cycle', path: 'tasks', message: 'profile task graph cannot be topologically sorted' }])
    executionOrder.push(...ready)
    for (const id of ready) remaining.delete(id)
  }
  const tasks = declaredTasks.map(task => {
    const owner = task.owner === undefined || task.owner === 'captain' ? undefined : memberByName.get(task.owner)
    return {
      id: task.id,
      role: task.owner ?? 'captain',
      expertIds: owner === undefined ? [] : [owner.id],
      ...(task.owner === 'captain' ? { owner: 'captain' as const } : {}),
      dependsOn: [...task.dependsOn],
      inputs: [],
      ...(task.produces === undefined ? {} : { produces: [...task.produces] }),
      ...(task.artifactInputs === undefined ? {} : { artifactInputs: structuredClone(task.artifactInputs) }),
      ...(task.humanChoice === undefined ? {} : { humanChoice: structuredClone(task.humanChoice) }),
      allowedCapabilities: task.allowedCapabilities === undefined ? [...(owner?.capabilities ?? [])] : [...task.allowedCapabilities],
      outputSchema: 'text',
      retryPolicy: 'quality-repair' as const,
      subject: task.subject,
      ...(task.acceptance === undefined ? {} : { acceptance: [...task.acceptance] }),
      ...(task.reportBundle === undefined ? {} : { reportBundle: structuredClone(task.reportBundle) }),
      ...(task.skillBindings === undefined ? {} : { skillBindings: structuredClone(task.skillBindings), promptBinding: structuredClone(task.promptBinding!) }),
      ...(task.description === undefined ? {} : { description: task.description }),
    }
  })
  const template = { id: `profile:${profile.id}`, version: profile.version }
  const scenario = { id: profile.id, version: profile.version }
  const core = {
    schemaVersion: 2 as const,
    template,
    scenario,
    params: { ...params,
      ...(profile.analysisFramework === undefined ? {} : { analysisFramework: structuredClone(profile.analysisFramework) }),
      ...(profile.expertSelection === undefined ? {} : { expertSelection: structuredClone(profile.expertSelection) }) },
    roster,
    tasks,
    executionOrder,
    gates: [],
    deliverables: [],
    bindings: { tool: [], knowledge: [], outputTemplates: [], qualityPolicies: [] },
    protocol: [...profile.protocol],
    ...(profile.review === undefined ? {} : { reviewPolicy: { ...profile.review, ...(profile.review.hardGateIds === undefined ? {} : { hardGateIds: [...profile.review.hardGateIds] }) } }),
  }
  const digest = canonicalDigest(core)
  return {
    ...core,
    planId: `ep-${digest.slice(0, 16)}`,
    digest,
    provenance: [
      { step: 'profile', detail: `${profile.id}@${profile.version}` },
      { step: 'task-planning', detail: profile.taskPlanning },
      ...(profile.review === undefined ? [] : [{ step: 'review-policy', detail: JSON.stringify(profile.review) }]),
    ],
  }
}
