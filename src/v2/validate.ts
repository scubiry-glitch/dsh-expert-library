/**
 * Pure structural validator for V2 domain packs.
 *
 * Zero third-party dependencies, no I/O: `validateDomainPack(unknown)`
 * either returns the typed pack or a list of {@link PackDiagnostic} with
 * code/path/message/severity — never a bare boolean. Validation covers the
 * full §3 contract: base shapes, safe ids, version strings, duplicate ids,
 * cross-references (scenario → templates/policies, template → roles/tasks,
 * gates → policies, skill package → contributed objects and required tool
 * capabilities), DAG dependency existence and acyclicity, and expert
 * capability claims (non-empty, proficiency 1..5).
 *
 * Severity policy: structural damage (wrong shape, unsafe id, missing
 * required field, dangling reference, cycle, duplicate id) is an `error`
 * and fails validation; stylistic deviations (non-semver version, unused
 * hint) are `warning` and do not.
 * @module dsh-expert-library/v2/validate
 */

import { isSafeKnowledgeId } from '../knowledge.ts'
import {
  SCHEMA_VERSION,
  type CapabilityClaim,
  type DomainPackV2,
  type ExpertV2,
  type KnowledgeProviderManifest,
  type OutputTemplate,
  type PackDiagnostic,
  type PackMeta,
  type Proficiency,
  type QualityPolicy,
  type ScenarioV2,
  type TaskTemplate,
  type TeamTemplate,
  type ToolProviderManifest,
  type ValidationResult,
} from './types.ts'

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/** Whether a parsed JSON value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is a non-empty trimmed string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Whether a value is a plain array. */
function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/** Whether a value is a string array (optionally non-empty). */
function isStringArray(value: unknown, requireNonEmpty = false): value is string[] {
  if (!isArray(value)) return false
  if (requireNonEmpty && value.length === 0) return false
  return value.every(item => typeof item === 'string')
}

/** Mutable diagnostic collector handed through the validation passes. */
class Diagnostics {
  readonly items: PackDiagnostic[] = []

  add(code: string, path: string, message: string, severity: PackDiagnostic['severity'] = 'error'): void {
    this.items.push({ code, path, message, severity })
  }

  get hasErrors(): boolean {
    return this.items.some(item => item.severity === 'error')
  }
}

/** Shared id/version gate for every top-level entity. */
function validateEntityHeader(
  diags: Diagnostics,
  value: Record<string, unknown>,
  path: string,
  label: string,
): { id?: string; version?: string } {
  const id = value['id']
  if (typeof id !== 'string' || !isSafeKnowledgeId(id)) {
    diags.add('unsafe-id', `${path}.id`, `${label} id must be a safe path segment (letters/digits, ._- inside, ≤64 chars)`)
  }
  const version = value['version']
  if (!isNonEmptyString(version)) {
    diags.add('missing-version', `${path}.version`, `${label} version must be a non-empty string`)
  } else if (!SEMVER.test(version.trim())) {
    diags.add('non-semver-version', `${path}.version`, `${label} version "${version}" is not semver; overlays and provenance prefer semver`, 'warning')
  }
  const schemaVersion = value['schemaVersion']
  if (schemaVersion !== undefined && schemaVersion !== SCHEMA_VERSION) {
    diags.add('schema-version-mismatch', `${path}.schemaVersion`, `${label} schemaVersion must be ${SCHEMA_VERSION}, got ${String(schemaVersion)}`)
  }
  return { id: typeof id === 'string' ? id : undefined, version: typeof version === 'string' ? version : undefined }
}

/** Check a record's required field is present with a sane shape. */
function requireField(
  diags: Diagnostics,
  value: Record<string, unknown>,
  field: string,
  path: string,
  predicate: (item: unknown) => boolean,
  message: string,
): void {
  if (!(field in value) || !predicate(value[field])) {
    diags.add('invalid-field', `${path}.${field}`, message)
  }
}

/** Validate one expert record (mutates nothing). */
function validateExpert(diags: Diagnostics, value: Record<string, unknown>, path: string): string | undefined {
  const { id } = validateEntityHeader(diags, value, path, 'expert')
  requireField(diags, value, 'display', path, isRecord, 'expert display must be an object')
  const display = isRecord(value['display']) ? value['display'] : undefined
  if (display !== undefined) {
    if (!isNonEmptyString(display['internalName'])) {
      diags.add('invalid-field', `${path}.display.internalName`, 'expert display.internalName must be a non-empty string')
    }
    if (!isNonEmptyString(display['publicLabel'])) {
      diags.add('invalid-field', `${path}.display.publicLabel`, 'expert display.publicLabel must be a non-empty string (never the real name)')
    }
    if (!isNonEmptyString(display['initials'])) {
      diags.add('invalid-field', `${path}.display.initials`, 'expert display.initials must be a non-empty string (anonymization track)')
    }
  }
  if (!isStringArray(value['domains'], true)) {
    diags.add('invalid-field', `${path}.domains`, 'expert domains must be a non-empty string array')
  }
  const capabilities = value['capabilities']
  if (!isArray(capabilities) || capabilities.length === 0) {
    diags.add('empty-capabilities', `${path}.capabilities`, 'expert must claim at least one capability (routing is capability-first)')
  } else {
    for (const [index, claim] of capabilities.entries()) {
      validateCapabilityClaim(diags, claim, `${path}.capabilities[${index}]`)
    }
  }
  if (value['persona'] !== undefined && !isRecord(value['persona'])) {
    diags.add('invalid-field', `${path}.persona`, 'expert persona must be an object when present')
  }
  return id
}

/** Validate one capability claim. */
function validateCapabilityClaim(diags: Diagnostics, claim: unknown, path: string): void {
  if (!isRecord(claim)) {
    diags.add('invalid-field', path, 'capability claim must be an object')
    return
  }
  if (!isNonEmptyString(claim['capability'])) {
    diags.add('invalid-field', `${path}.capability`, 'capability claim needs a non-empty dotted capability id')
  }
  const proficiency = claim['proficiency']
  if (typeof proficiency !== 'number' || !Number.isInteger(proficiency) || proficiency < 1 || proficiency > 5) {
    diags.add('proficiency-out-of-range', `${path}.proficiency`, `proficiency must be an integer 1..5, got ${String(proficiency)}`)
  }
  const coverage = claim['coverage']
  if (coverage !== 'high' && coverage !== 'medium' && coverage !== 'low') {
    diags.add('invalid-field', `${path}.coverage`, 'coverage must be one of high|medium|low')
  }
}

/** Validate one scenario record; reference resolution happens later. */
function validateScenario(diags: Diagnostics, value: Record<string, unknown>, path: string): string | undefined {
  const { id } = validateEntityHeader(diags, value, path, 'scenario')
  requireField(diags, value, 'domain', path, isNonEmptyString, 'scenario domain must be a non-empty string')
  if (!isStringArray(value['intents'], true)) {
    diags.add('invalid-field', `${path}.intents`, 'scenario intents must be a non-empty string array (controlled vocabulary)')
  }
  if (!isArray(value['requiredCapabilities'])) {
    diags.add('invalid-field', `${path}.requiredCapabilities`, 'scenario requiredCapabilities must be an array')
  }
  requireField(diags, value, 'routingPolicy', path, isRecord, 'scenario routingPolicy must be an object')
  for (const field of ['teamTemplate', 'outputTemplate', 'qualityPolicy'] as const) {
    if (!isNonEmptyString(value[field])) {
      diags.add('invalid-field', `${path}.${field}`, `scenario ${field} must reference an id (resolved inside the pack)`)
    }
  }
  const knowledgePolicy = value['knowledgePolicy']
  if (!isRecord(knowledgePolicy) || !isStringArray(knowledgePolicy['required'])) {
    diags.add('invalid-field', `${path}.knowledgePolicy`, 'scenario knowledgePolicy.required must be a string array')
  }
  const toolPolicy = value['toolPolicy']
  if (!isRecord(toolPolicy) || !isArray(toolPolicy['allowed'])) {
    diags.add('invalid-field', `${path}.toolPolicy`, 'scenario toolPolicy.allowed must be an array')
  }
  return id
}

/** Validate one team template record. */
function validateTeamTemplate(diags: Diagnostics, value: Record<string, unknown>, path: string): string | undefined {
  const { id } = validateEntityHeader(diags, value, path, 'team template')
  if (!isArray(value['slots']) || value['slots'].length === 0) {
    diags.add('invalid-field', `${path}.slots`, 'team template must declare at least one role slot')
  } else {
    for (const [index, slot] of value['slots'].entries()) {
      const slotPath = `${path}.slots[${index}]`
      if (!isRecord(slot)) {
        diags.add('invalid-field', slotPath, 'role slot must be an object')
        continue
      }
      const slotId = slot['id']
      if (typeof slotId !== 'string' || !isSafeKnowledgeId(slotId)) {
        diags.add('unsafe-id', `${slotPath}.id`, 'role slot id must be a safe path segment')
      }
      if (!isStringArray(slot['capabilities'])) {
        diags.add('invalid-field', `${slotPath}.capabilities`, 'role slot capabilities must be a string array')
      }
      const cardinality = slot['cardinality']
      if (
        !isRecord(cardinality)
        || typeof cardinality['min'] !== 'number'
        || typeof cardinality['max'] !== 'number'
        || !Number.isInteger(cardinality['min'])
        || !Number.isInteger(cardinality['max'])
        || cardinality['min'] < 0
        || cardinality['max'] < cardinality['min']
      ) {
        diags.add('invalid-field', `${slotPath}.cardinality`, 'role slot cardinality must be {min,max} integers with 0 ≤ min ≤ max')
      }
    }
  }
  if (!isArray(value['tasks'])) {
    diags.add('invalid-field', `${path}.tasks`, 'team template tasks must be an array')
  } else {
    for (const [index, task] of value['tasks'].entries()) {
      const taskPath = `${path}.tasks[${index}]`
      if (!isRecord(task)) {
        diags.add('invalid-field', taskPath, 'task template must be an object')
        continue
      }
      const taskId = task['id']
      if (typeof taskId !== 'string' || !isSafeKnowledgeId(taskId)) {
        diags.add('unsafe-id', `${taskPath}.id`, 'task id must be a safe path segment')
      }
      if (!isNonEmptyString(task['role'])) {
        diags.add('invalid-field', `${taskPath}.role`, 'task role must reference a role slot id')
      }
      if (!isStringArray(task['dependsOn'])) {
        diags.add('invalid-field', `${taskPath}.dependsOn`, 'task dependsOn must be a string array of task ids')
      }
      if (!isArray(task['inputs'])) {
        diags.add('invalid-field', `${taskPath}.inputs`, 'task inputs must be an array')
      }
      if (!isStringArray(task['allowedCapabilities'])) {
        diags.add('invalid-field', `${taskPath}.allowedCapabilities`, 'task allowedCapabilities must be a string array')
      }
      const retryPolicy = task['retryPolicy']
      if (retryPolicy !== 'never' && retryPolicy !== 'provider-only' && retryPolicy !== 'quality-repair') {
        diags.add('invalid-field', `${taskPath}.retryPolicy`, 'task retryPolicy must be never|provider-only|quality-repair')
      }
    }
  }
  if (!isArray(value['gates'])) {
    diags.add('invalid-field', `${path}.gates`, 'team template gates must be an array')
  } else {
    for (const [index, gate] of value['gates'].entries()) {
      const gatePath = `${path}.gates[${index}]`
      if (!isRecord(gate)) continue // binding resolution reports precise errors later
      if (!isNonEmptyString(gate['policy'])) {
        diags.add('invalid-field', `${gatePath}.policy`, 'gate binding policy must reference a QualityPolicy id')
      }
      if (!isNonEmptyString(gate['gate'])) {
        diags.add('invalid-field', `${gatePath}.gate`, 'gate binding gate must reference a gate id inside the policy')
      }
    }
  }
  if (!isArray(value['deliverables'])) {
    diags.add('invalid-field', `${path}.deliverables`, 'team template deliverables must be an array')
  }
  return id
}

/** Validate one output template record. */
function validateOutputTemplate(diags: Diagnostics, value: Record<string, unknown>, path: string): string | undefined {
  const { id } = validateEntityHeader(diags, value, path, 'output template')
  const media = value['media']
  if (
    !isArray(media)
    || media.length === 0
    || !media.every(item => item === 'markdown' || item === 'html' || item === 'pdf' || item === 'pptx' || item === 'json')
  ) {
    diags.add('invalid-field', `${path}.media`, 'output template media must be a non-empty array of markdown|html|pdf|pptx|json')
  }
  if (!isArray(value['sections'])) {
    diags.add('invalid-field', `${path}.sections`, 'output template sections must be an array')
  }
  const renderModes = value['renderModes']
  if (!isRecord(renderModes) || Object.keys(renderModes).length === 0) {
    diags.add('invalid-field', `${path}.renderModes`, 'output template needs at least one render mode (e.g. discussion/final)')
  } else {
    for (const [mode, policy] of Object.entries(renderModes)) {
      if (!isRecord(policy) || typeof policy['anonymize'] !== 'boolean') {
        diags.add('invalid-field', `${path}.renderModes.${mode}`, 'render mode policy must set anonymize: boolean')
      }
    }
  }
  return id
}

/** Validate one quality policy record. */
function validateQualityPolicy(diags: Diagnostics, value: Record<string, unknown>, path: string): string | undefined {
  const { id } = validateEntityHeader(diags, value, path, 'quality policy')
  const gates = value['gates']
  if (!isArray(gates)) {
    diags.add('invalid-field', `${path}.gates`, 'quality policy gates must be an array')
    return id
  }
  for (const [index, gate] of gates.entries()) {
    const gatePath = `${path}.gates[${index}]`
    if (!isRecord(gate)) {
      diags.add('invalid-field', gatePath, 'gate spec must be an object')
      continue
    }
    if (!isNonEmptyString(gate['id'])) {
      diags.add('invalid-field', `${gatePath}.id`, 'gate id must be a non-empty string')
    }
    const kind = gate['kind']
    if (kind !== 'deterministic' && kind !== 'semantic' && kind !== 'visual') {
      diags.add('invalid-field', `${gatePath}.kind`, 'gate kind must be deterministic|semantic|visual')
    }
    if (!isStringArray(gate['appliesTo'])) {
      diags.add('invalid-field', `${gatePath}.appliesTo`, 'gate appliesTo must be a string array')
    }
    const severity = gate['severity']
    if (severity !== 'hard' && severity !== 'soft') {
      diags.add('invalid-field', `${gatePath}.severity`, 'gate severity must be hard|soft')
    }
    const phase = gate['phase']
    if (
      phase !== undefined
      && phase !== 'structure' && phase !== 'data' && phase !== 'compliance'
      && phase !== 'format' && phase !== 'style' && phase !== 'semantic' && phase !== 'final'
    ) {
      diags.add('invalid-field', `${gatePath}.phase`, 'gate phase must be structure|data|compliance|format|style|semantic|final')
    }
  }
  const maxRepairRounds = value['maxRepairRounds']
  if (maxRepairRounds !== undefined && (typeof maxRepairRounds !== 'number' || !Number.isInteger(maxRepairRounds) || maxRepairRounds < 0 || maxRepairRounds > 2)) {
    diags.add('invalid-field', `${path}.maxRepairRounds`, 'maxRepairRounds must be an integer 0..2 (design cap is 2)')
  }
  return id
}

/** Validate the common fields of one tool transport. */
function validateTransportCommon(
  diags: Diagnostics,
  transport: Record<string, unknown>,
  path: string,
): void {
  if (!isNonEmptyString(transport['id'])) {
    diags.add('invalid-field', `${path}.id`, 'transport id must be a non-empty string')
  }
  const timeoutMs = transport['timeoutMs']
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    diags.add('invalid-field', `${path}.timeoutMs`, 'transport timeoutMs must be a positive integer of milliseconds')
  }
  if (transport['readOnly'] !== undefined && typeof transport['readOnly'] !== 'boolean') {
    diags.add('invalid-field', `${path}.readOnly`, 'transport readOnly must be boolean when present')
  }
  const auth = transport['auth']
  if (auth !== undefined && (!isRecord(auth) || !isNonEmptyString(auth['credentialRef']))) {
    diags.add('invalid-field', `${path}.auth`, 'transport auth must reference the credential layer (credentialRef), never a secret')
  }
}

/** Validate one tool transport against the closed kind union. */
function validateTransport(diags: Diagnostics, value: unknown, path: string): { kind?: string; id?: string } {
  if (!isRecord(value)) {
    diags.add('invalid-field', path, 'tool transport must be an object')
    return {}
  }
  validateTransportCommon(diags, value, path)
  const kind = value['kind']
  switch (kind) {
    case 'mcp-stdio': {
      if (!isNonEmptyString(value['command'])) {
        diags.add('invalid-field', `${path}.command`, 'mcp-stdio transport needs a non-empty command')
      }
      const args = value['args']
      if (args !== undefined && !isStringArray(args)) {
        diags.add('invalid-field', `${path}.args`, 'mcp-stdio args must be a string array when present')
      }
      break
    }
    case 'mcp-http': {
      if (!isNonEmptyString(value['endpoint'])) {
        diags.add('invalid-field', `${path}.endpoint`, 'mcp-http transport needs a non-empty endpoint URL')
      }
      break
    }
    case 'http-api': {
      if (!isNonEmptyString(value['baseUrl'])) {
        diags.add('invalid-field', `${path}.baseUrl`, 'http-api transport needs a non-empty baseUrl')
      }
      break
    }
    case 'local-cli': {
      if (!isNonEmptyString(value['command'])) {
        diags.add('invalid-field', `${path}.command`, 'local-cli transport needs a non-empty command')
      }
      const workingDirectory = value['workingDirectory']
      if (workingDirectory !== undefined && typeof workingDirectory !== 'string') {
        diags.add('invalid-field', `${path}.workingDirectory`, 'local-cli workingDirectory must be a string when present')
      }
      break
    }
    default:
      diags.add('invalid-field', `${path}.kind`, 'transport kind must be mcp-stdio|mcp-http|http-api|local-cli')
      return { kind: undefined, id: typeof value['id'] === 'string' ? value['id'] : undefined }
  }
  return { kind, id: typeof value['id'] === 'string' ? value['id'] : undefined }
}

/** Validate one tool provider manifest. */
function validateToolProvider(diags: Diagnostics, value: Record<string, unknown>, path: string): string | undefined {
  const { id } = validateEntityHeader(diags, value, path, 'tool provider')
  const capabilities = value['capabilities']
  if (!isArray(capabilities) || capabilities.length === 0) {
    diags.add('invalid-field', `${path}.capabilities`, 'tool provider must declare at least one capability')
  } else {
    for (const [index, capability] of capabilities.entries()) {
      const capPath = `${path}.capabilities[${index}]`
      if (!isRecord(capability)) {
        diags.add('invalid-field', capPath, 'tool capability must be an object')
        continue
      }
      if (!isNonEmptyString(capability['capability'])) {
        diags.add('invalid-field', `${capPath}.capability`, 'tool capability needs a non-empty dotted id')
      }
      if (!isNonEmptyString(capability['operation'])) {
        diags.add('invalid-field', `${capPath}.operation`, 'tool capability needs a provider-local operation id')
      }
    }
  }
  const transports = value['transports']
  const transportIds = new Set<string>()
  if (!isArray(transports) || transports.length === 0) {
    diags.add('invalid-field', `${path}.transports`, 'tool provider must declare at least one transport (mcp-stdio|mcp-http|http-api|local-cli)')
  } else {
    const seen = new Set<string>()
    for (const [index, transport] of transports.entries()) {
      const { id: transportId } = validateTransport(diags, transport, `${path}.transports[${index}]`)
      if (transportId !== undefined) {
        if (seen.has(transportId)) {
          diags.add('duplicate-transport-id', `${path}.transports[${index}].id`, `transport id "${transportId}" is declared more than once in this provider`)
        }
        seen.add(transportId)
        transportIds.add(transportId)
      }
    }
  }
  // Capability → transport binding: a declared transportId must resolve.
  if (isArray(capabilities)) {
    for (const [index, capability] of capabilities.entries()) {
      if (!isRecord(capability)) continue
      const transportId = capability['transportId']
      if (transportId !== undefined && typeof transportId === 'string' && !transportIds.has(transportId)) {
        diags.add('dangling-transport', `${path}.capabilities[${index}].transportId`, `capability transportId "${transportId}" does not match any transport of this provider`)
      }
    }
  }
  return id
}

/** Validate one knowledge provider manifest. */
function validateKnowledgeProvider(diags: Diagnostics, value: Record<string, unknown>, path: string): string | undefined {
  const { id } = validateEntityHeader(diags, value, path, 'knowledge provider')
  const kind = value['kind']
  if (kind !== 'files' && kind !== 'structured-wiki' && kind !== 'search-index' && kind !== 'database' && kind !== 'stream') {
    diags.add('invalid-field', `${path}.kind`, 'knowledge provider kind must be files|structured-wiki|search-index|database|stream')
  }
  const capabilities = value['capabilities']
  if (
    !isStringArray(capabilities, true)
    || !capabilities.every(item => item === 'search' || item === 'read' || item === 'cite' || item === 'history' || item === 'write' || item === 'validate')
  ) {
    diags.add('invalid-field', `${path}.capabilities`, 'knowledge provider capabilities must be a non-empty subset of search|read|cite|history|write|validate')
  }
  const freshness = value['freshness']
  if (freshness !== 'static' && freshness !== 'monthly' && freshness !== 'daily' && freshness !== 'realtime') {
    diags.add('invalid-field', `${path}.freshness`, 'knowledge provider freshness must be static|monthly|daily|realtime')
  }
  return id
}

/** Validate one method pack record. */
function validateMethodPack(diags: Diagnostics, value: Record<string, unknown>, path: string): string | undefined {
  const { id } = validateEntityHeader(diags, value, path, 'method pack')
  if (!isNonEmptyString(value['name'])) {
    diags.add('invalid-field', `${path}.name`, 'method pack name must be a non-empty string')
  }
  if (value['mediaType'] !== 'agent-instructions') {
    diags.add('invalid-field', `${path}.mediaType`, "method pack mediaType must be 'agent-instructions' (methodology prose, never executed)")
  }
  if (value['load'] !== 'progressive') {
    diags.add('invalid-field', `${path}.load`, "method pack load must be 'progressive' (loaded at task-compile time, never persona-injected)")
  }
  if (typeof value['body'] !== 'string' || value['body'].trim() === '') {
    diags.add('invalid-field', `${path}.body`, 'method pack body must be a non-empty string (static methodology, never executed)')
  }
  return id
}

/** Validate one domain knowledge base manifest (§3.3 structured KB). */
function validateDomainKnowledge(diags: Diagnostics, value: Record<string, unknown>, path: string): string | undefined {
  const { id } = validateEntityHeader(diags, value, path, 'domain knowledge base')
  if (!isNonEmptyString(value['domain'])) {
    diags.add('invalid-field', `${path}.domain`, 'domain knowledge base must declare the domain it covers')
  }
  if (!isNonEmptyString(value['boundary'])) {
    diags.add('invalid-field', `${path}.boundary`, 'domain knowledge base must declare its boundary (what belongs inside)')
  }
  const ontology = value['ontology']
  if (
    !isRecord(ontology)
    || !isArray(ontology['entities'])
    || !ontology['entities'].every(entity => isRecord(entity) && isNonEmptyString(entity['id']) && isNonEmptyString(entity['description']))
  ) {
    diags.add('invalid-field', `${path}.ontology`, 'ontology must declare entities [{id, description}]; relations are optional')
  } else if (ontology['relations'] !== undefined) {
    const relations = ontology['relations']
    if (
      !isArray(relations)
      || !relations.every(relation => isRecord(relation) && isNonEmptyString(relation['id']) && isNonEmptyString(relation['from']) && isNonEmptyString(relation['to']))
    ) {
      diags.add('invalid-field', `${path}.ontology.relations`, 'ontology relations must each carry id/from/to')
    }
  }
  const collections = value['collections']
  if (!isArray(collections) || collections.length === 0) {
    diags.add('invalid-field', `${path}.collections`, 'domain knowledge base must declare at least one collection')
  } else {
    for (const [index, collection] of collections.entries()) {
      const colPath = `${path}.collections[${index}]`
      if (!isRecord(collection) || !isNonEmptyString(collection['id']) || !isSafeKnowledgeId(String(collection['id']))) {
        diags.add('invalid-field', `${colPath}.id`, 'collection id must be a safe path segment')
        continue
      }
      const root = collection['root']
      if (!isNonEmptyString(root) || (typeof root === 'string' && !isSafeRelativeRoot(root))) {
        diags.add('invalid-field', `${colPath}.root`, 'collection root must be a safe relative path under the knowledge base root (no .., no absolute path)')
      }
    }
  }
  const snapshot = value['snapshot']
  if (
    !isRecord(snapshot)
    || !isNonEmptyString(snapshot['id'])
    || !isNonEmptyString(snapshot['takenAt'])
    || !isNonEmptyString(snapshot['digest'])
    || typeof snapshot['recordCount'] !== 'number'
    || !Number.isInteger(snapshot['recordCount'])
    || snapshot['recordCount'] < 0
  ) {
    diags.add('invalid-field', `${path}.snapshot`, 'snapshot must carry id/takenAt/digest and a non-negative integer recordCount')
  }
  const retrievalProfiles = value['retrievalProfiles']
  if (
    !isArray(retrievalProfiles)
    || !retrievalProfiles.every(profile => isRecord(profile)
      && isNonEmptyString(profile['id'])
      && (profile['method'] === 'keyword' || profile['method'] === 'semantic' || profile['method'] === 'graph' || profile['method'] === 'full-read'))
  ) {
    diags.add('invalid-field', `${path}.retrievalProfiles`, 'retrievalProfiles must each carry id and method keyword|semantic|graph|full-read')
  }
  const policies = value['policies']
  if (
    !isRecord(policies)
    || (policies['citation'] !== 'required' && policies['citation'] !== 'optional')
    || (policies['freshness'] !== 'static' && policies['freshness'] !== 'monthly' && policies['freshness'] !== 'daily' && policies['freshness'] !== 'realtime')
    || (policies['access'] !== 'readonly' && policies['access'] !== 'append')
  ) {
    diags.add('invalid-field', `${path}.policies`, 'policies must declare citation required|optional, freshness static|monthly|daily|realtime, access readonly|append')
  }
  return id
}

/** Whether a skill/package source root is a safe relative path (no escape). */
function isSafeRelativeRoot(root: string): boolean {
  if (root === '' || root.startsWith('/') || root.startsWith('\\') || root.includes('..') || root.includes(':')) {
    return false
  }
  // Every segment must be a non-empty safe path segment (Windows-style
  // absolute drive paths and trailing/duplicate separators are rejected).
  return root.split(/[/\\]/).every(segment => segment !== '' && isSafeKnowledgeId(segment))
}

/** Validate one skill package manifest (§3.7, local-only sources). */
function validateSkillPackage(diags: Diagnostics, value: Record<string, unknown>, path: string): string | undefined {
  const { id } = validateEntityHeader(diags, value, path, 'skill package')
  const source = value['source']
  if (!isRecord(source)) {
    diags.add('invalid-field', `${path}.source`, 'skill package source must record kind/root/digest (local-only)')
  } else {
    const kind = source['kind']
    if (kind !== 'builtin' && kind !== 'workspace') {
      diags.add('invalid-field', `${path}.source.kind`, 'skill package source.kind must be builtin|workspace — remote sources are forbidden at runtime')
    }
    if (!isNonEmptyString(source['root']) || (typeof source['root'] === 'string' && !isSafeRelativeRoot(source['root']))) {
      diags.add('invalid-field', `${path}.source.root`, 'skill package source.root must be a safe relative path of the locally installed skill (no .., no absolute path, no drive letter)')
    }
    if (!isNonEmptyString(source['digest'])) {
      diags.add('invalid-field', `${path}.source.digest`, 'skill package source.digest must be a whole-package digest (re-installs re-verify)')
    }
    if (source['license'] === undefined) {
      diags.add('missing-license', `${path}.source.license`, 'skill package has no license; outputs default to internalOnly', 'warning')
    }
    const upstream = source['upstreamProvenance']
    if (upstream !== undefined) {
      if (!isRecord(upstream) || !isNonEmptyString(upstream['repository']) || !isNonEmptyString(upstream['revision'])) {
        diags.add('invalid-field', `${path}.source.upstreamProvenance`, 'upstreamProvenance is audit-only and must carry repository+revision when present; the loader never contacts it')
      }
    }
  }
  const contributions = value['contributions']
  if (!isRecord(contributions)) {
    diags.add('invalid-field', `${path}.contributions`, 'skill package contributions must be an object (all lists optional, ids resolve inside the pack)')
  } else {
    for (const key of ['methodPacks', 'knowledgeProviders', 'outputTemplates', 'qualityPolicies', 'toolRequirements', 'teamTemplates'] as const) {
      if (contributions[key] !== undefined && !isStringArray(contributions[key])) {
        diags.add('invalid-field', `${path}.contributions.${key}`, `skill package contributions.${key} must be a string array of ids`)
      }
    }
  }
  const lazyMedia = value['lazyMedia']
  if (lazyMedia !== undefined) {
    if (!isArray(lazyMedia)) {
      diags.add('invalid-field', `${path}.lazyMedia`, 'skill package lazyMedia must be an array')
    } else {
      for (const [index, media] of lazyMedia.entries()) {
        const mediaPath = `${path}.lazyMedia[${index}]`
        if (!isRecord(media) || !isNonEmptyString(media['path']) || typeof media['bytes'] !== 'number' || !isNonEmptyString(media['sha256'])) {
          diags.add('invalid-field', mediaPath, 'lazy media entry must carry path/bytes/sha256 (digest-pinned, lazily read)')
        }
      }
    }
  }
  const permissions = value['permissions']
  if (!isRecord(permissions) || !isStringArray(permissions['execScripts'])) {
    diags.add('invalid-field', `${path}.permissions`, 'skill package permissions must list execScripts (may be empty; scripts must register as controlled ToolProviders)')
  }
  if (isRecord(permissions) && isRecord(source) && source['license'] === undefined && permissions['internalOnly'] !== true) {
    diags.add('unlicensed-not-internal', `${path}.permissions.internalOnly`, 'skill package without a license must set permissions.internalOnly = true')
  }
  return id
}

/** Detect duplicate ids across one collection and report each collision. */
function checkDuplicateIds(diags: Diagnostics, ids: (string | undefined)[], section: string): void {
  const seen = new Map<string, number>()
  for (const [index, id] of ids.entries()) {
    if (id === undefined) continue
    const firstIndex = seen.get(id)
    if (firstIndex === undefined) {
      seen.set(id, index)
      continue
    }
    diags.add('duplicate-id', `pack.${section}[${index}].id`, `duplicate id "${id}" in ${section} (first defined at index ${firstIndex})`)
  }
}

/** Iterative DFS cycle detection over task dependency edges. */
function checkTaskGraph(diags: Diagnostics, template: Record<string, unknown>, path: string): void {
  const tasks = isArray(template['tasks']) ? template['tasks'] : []
  const tasksById = new Map<string, Record<string, unknown>>()
  const taskIds = new Set<string>()
  for (const task of tasks) {
    if (isRecord(task) && typeof task['id'] === 'string') {
      tasksById.set(task['id'], task)
      taskIds.add(task['id'])
    }
  }
  const depsOf = (task: Record<string, unknown>): string[] => {
    const dependsOn = task['dependsOn']
    return isStringArray(dependsOn) ? dependsOn : []
  }
  for (const [index, task] of tasks.entries()) {
    if (!isRecord(task)) continue
    const taskId = typeof task['id'] === 'string' ? task['id'] : `#${index}`
    for (const dependency of depsOf(task)) {
      if (!taskIds.has(dependency)) {
        diags.add('dangling-dependency', `${path}.tasks[${index}].dependsOn`, `task "${taskId}" depends on unknown task "${dependency}"`)
      }
    }
  }
  const visiting = new Set<string>()
  const done = new Set<string>()
  for (const root of taskIds) {
    if (done.has(root)) continue
    const stack: { id: string; expanded: boolean }[] = [{ id: root, expanded: false }]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (frame === undefined) continue
      if (!frame.expanded) {
        if (done.has(frame.id)) { stack.pop(); continue }
        if (visiting.has(frame.id)) {
          diags.add('dag-cycle', `${path}.tasks`, `dependency cycle detected involving task "${frame.id}"`)
          break
        }
        visiting.add(frame.id)
        for (const dependency of depsOf(tasksById.get(frame.id) ?? {})) {
          if (taskIds.has(dependency)) stack.push({ id: dependency, expanded: false })
        }
        frame.expanded = true
        continue
      }
      visiting.delete(frame.id)
      done.add(frame.id)
      stack.pop()
    }
  }
}

/**
 * Validate an unknown document as a {@link DomainPackV2}.
 *
 * @param input - the parsed JSON value (typically `JSON.parse` of pack.json
 *   plus its sections, or an object built by an adapter).
 * @returns `ok` with the typed pack when no error-severity diagnostics were
 *   produced; warnings (e.g. non-semver versions) do not fail validation.
 */
export function validateDomainPack(input: unknown): ValidationResult<DomainPackV2> {
  const diags = new Diagnostics()
  if (!isRecord(input)) {
    diags.add('invalid-shape', 'pack', 'domain pack must be a JSON object')
    return { ok: false, diagnostics: diags.items }
  }

  const pack = input['pack']
  if (!isRecord(pack)) {
    diags.add('invalid-shape', 'pack.pack', 'pack metadata (pack.json) must be an object')
  } else {
    validateEntityHeader(diags, pack, 'pack.pack', 'pack')
    if (!isNonEmptyString(pack['name'])) {
      diags.add('invalid-field', 'pack.pack.name', 'pack name must be a non-empty string')
    }
  }

  const sections: Array<[keyof DomainPackV2, string, (diags: Diagnostics, value: Record<string, unknown>, path: string) => string | undefined]> = [
    ['experts', 'experts', validateExpert],
    ['teamTemplates', 'teamTemplates', validateTeamTemplate],
    ['outputTemplates', 'outputTemplates', validateOutputTemplate],
    ['qualityPolicies', 'qualityPolicies', validateQualityPolicy],
    ['scenarios', 'scenarios', validateScenario],
    ['toolProviders', 'toolProviders', validateToolProvider],
    ['knowledgeProviders', 'knowledgeProviders', validateKnowledgeProvider],
    ['domainKnowledge', 'domainKnowledge', validateDomainKnowledge],
    ['methodPacks', 'methodPacks', validateMethodPack],
    ['skillPackages', 'skillPackages', validateSkillPackage],
  ]
  const idsBySection = new Map<string, (string | undefined)[]>()
  for (const [key, label, validateItem] of sections) {
    const list = input[key as string]
    if (!isArray(list)) {
      diags.add('invalid-shape', `pack.${label}`, `pack ${label} must be an array`)
      idsBySection.set(label, [])
      continue
    }
    const ids: (string | undefined)[] = []
    for (const [index, item] of list.entries()) {
      if (!isRecord(item)) {
        diags.add('invalid-shape', `pack.${label}[${index}]`, `${label} entry must be an object`)
        ids.push(undefined)
        continue
      }
      ids.push(validateItem(diags, item, `pack.${label}[${index}]`))
    }
    idsBySection.set(label, ids)
    checkDuplicateIds(diags, ids, label)
  }

  // Cross-reference resolution — only meaningful for ids that parsed.
  const knownIds = (label: string): Set<string> => new Set((idsBySection.get(label) ?? []).filter((id): id is string => id !== undefined))

  const templateIds = knownIds('teamTemplates')
  const outputIds = knownIds('outputTemplates')
  const qualityIds = knownIds('qualityPolicies')

  const scenarios = isArray(input['scenarios']) ? input['scenarios'] : []
  for (const [index, scenario] of scenarios.entries()) {
    if (!isRecord(scenario)) continue
    const path = `pack.scenarios[${index}]`
    const scenarioId = typeof scenario['id'] === 'string' ? scenario['id'] : `#${index}`
    const teamTemplate = scenario['teamTemplate']
    if (typeof teamTemplate === 'string' && !templateIds.has(teamTemplate)) {
      diags.add('dangling-reference', `${path}.teamTemplate`, `scenario "${scenarioId}" references unknown team template "${teamTemplate}"`)
    }
    const outputTemplate = scenario['outputTemplate']
    if (typeof outputTemplate === 'string' && !outputIds.has(outputTemplate)) {
      diags.add('dangling-reference', `${path}.outputTemplate`, `scenario "${scenarioId}" references unknown output template "${outputTemplate}"`)
    }
    const qualityPolicy = scenario['qualityPolicy']
    if (typeof qualityPolicy === 'string' && !qualityIds.has(qualityPolicy)) {
      diags.add('dangling-reference', `${path}.qualityPolicy`, `scenario "${scenarioId}" references unknown quality policy "${qualityPolicy}"`)
    }
  }

  const templates = isArray(input['teamTemplates']) ? input['teamTemplates'] : []
  const policies = isArray(input['qualityPolicies']) ? input['qualityPolicies'] : []
  const gateIdsByPolicy = new Map<string, Set<string>>()
  for (const [index, policy] of policies.entries()) {
    if (!isRecord(policy) || typeof policy['id'] !== 'string') continue
    const gateIds = new Set<string>()
    const gates = isArray(policy['gates']) ? policy['gates'] : []
    for (const gate of gates) {
      if (isRecord(gate) && typeof gate['id'] === 'string') gateIds.add(gate['id'])
    }
    gateIdsByPolicy.set(policy['id'], gateIds)
  }
  for (const [index, template] of templates.entries()) {
    if (!isRecord(template)) continue
    const path = `pack.teamTemplates[${index}]`
    const templateId = typeof template['id'] === 'string' ? template['id'] : `#${index}`
    // Task roles must reference declared slots.
    const slotIds = new Set<string>()
    const slots = isArray(template['slots']) ? template['slots'] : []
    for (const slot of slots) {
      if (isRecord(slot) && typeof slot['id'] === 'string') slotIds.add(slot['id'])
    }
    const tasks = isArray(template['tasks']) ? template['tasks'] : []
    for (const [taskIndex, task] of tasks.entries()) {
      if (!isRecord(task)) continue
      const role = task['role']
      if (typeof role === 'string' && !slotIds.has(role)) {
        diags.add('dangling-reference', `${path}.tasks[${taskIndex}].role`, `task role "${role}" does not match any slot of template "${templateId}"`)
      }
    }
    // Task graph: dependency existence + acyclicity.
    checkTaskGraph(diags, template, path)
    // Gate bindings resolve to policy + gate ids.
    const gates = isArray(template['gates']) ? template['gates'] : []
    for (const [gateIndex, binding] of gates.entries()) {
      if (!isRecord(binding)) continue
      const policyId = binding['policy']
      if (typeof policyId === 'string') {
        if (!gateIdsByPolicy.has(policyId)) {
          diags.add('dangling-reference', `${path}.gates[${gateIndex}].policy`, `gate binding references unknown quality policy "${policyId}"`)
        } else {
          const gate = binding['gate']
          if (typeof gate === 'string' && !gateIdsByPolicy.get(policyId)?.has(gate)) {
            diags.add('dangling-reference', `${path}.gates[${gateIndex}].gate`, `gate binding references unknown gate "${gate}" in policy "${policyId}"`)
          }
        }
      }
    }
    // Deliverable output templates resolve.
    const deliverables = isArray(template['deliverables']) ? template['deliverables'] : []
    for (const [dIndex, deliverable] of deliverables.entries()) {
      if (!isRecord(deliverable)) continue
      const outputTemplate = deliverable['outputTemplate']
      if (typeof outputTemplate === 'string' && !outputIds.has(outputTemplate)) {
        diags.add('dangling-reference', `${path}.deliverables[${dIndex}].outputTemplate`, `deliverable references unknown output template "${outputTemplate}"`)
      }
    }
  }

  // Knowledge providers may serve domain knowledge bases by id.
  const domainKnowledgeIds = knownIds('domainKnowledge')
  const knowledgeProviders = isArray(input['knowledgeProviders']) ? input['knowledgeProviders'] : []
  for (const [index, provider] of knowledgeProviders.entries()) {
    if (!isRecord(provider)) continue
    const providerId = typeof provider['id'] === 'string' ? provider['id'] : `#${index}`
    const refs = provider['domainKnowledgeIds']
    if (!isStringArray(refs)) continue
    for (const ref of refs) {
      if (!domainKnowledgeIds.has(ref)) {
        diags.add('dangling-reference', `pack.knowledgeProviders[${index}].domainKnowledgeIds`, `knowledge provider "${providerId}" references unknown domain knowledge base "${ref}"`)
      }
    }
  }

  // SkillPackage contribution resolution — every contributed id must resolve
  // inside this pack; tool requirements resolve against provider capability ids.
  const methodPackIds = knownIds('methodPacks')
  const knowledgeIds = knownIds('knowledgeProviders')
  const toolCapabilityIds = new Set<string>()
  const providers = isArray(input['toolProviders']) ? input['toolProviders'] : []
  for (const provider of providers) {
    if (!isRecord(provider)) continue
    const capabilities = isArray(provider['capabilities']) ? provider['capabilities'] : []
    for (const capability of capabilities) {
      if (isRecord(capability) && typeof capability['capability'] === 'string') toolCapabilityIds.add(capability['capability'])
    }
  }
  const contributionTargets: ReadonlyArray<readonly [key: string, ids: Set<string>]> = [
    ['methodPacks', methodPackIds],
    ['knowledgeProviders', knowledgeIds],
    ['outputTemplates', outputIds],
    ['qualityPolicies', qualityIds],
    ['teamTemplates', templateIds],
  ]
  const skillPackages = isArray(input['skillPackages']) ? input['skillPackages'] : []
  for (const [index, skillPackage] of skillPackages.entries()) {
    if (!isRecord(skillPackage)) continue
    const path = `pack.skillPackages[${index}]`
    const skillId = typeof skillPackage['id'] === 'string' ? skillPackage['id'] : `#${index}`
    const contributions = isRecord(skillPackage['contributions']) ? skillPackage['contributions'] : undefined
    if (contributions === undefined) continue
    for (const [key, targetIds] of contributionTargets) {
      const contributed = contributions[key]
      if (!isStringArray(contributed)) continue
      for (const ref of contributed) {
        if (!targetIds.has(ref)) {
          diags.add('dangling-reference', `${path}.contributions.${key}`, `skill package "${skillId}" contributes unknown ${key} id "${ref}"`)
        }
      }
    }
    const toolRequirements = contributions['toolRequirements']
    if (isStringArray(toolRequirements)) {
      for (const ref of toolRequirements) {
        if (!toolCapabilityIds.has(ref)) {
          diags.add('dangling-reference', `${path}.contributions.toolRequirements`, `skill package "${skillId}" requires capability "${ref}" no installed tool provider declares`)
        }
      }
    }
  }

  if (diags.hasErrors) {
    return { ok: false, diagnostics: diags.items }
  }
  return { ok: true, value: input as unknown as DomainPackV2, diagnostics: diags.items }
}

// Re-exported for adapter consumers that construct claims programmatically.
export { validateCapabilityClaim as validateClaimShape }
export type { CapabilityClaim, Proficiency, TaskTemplate, ExpertV2, ScenarioV2, TeamTemplate, OutputTemplate, QualityPolicy, PackMeta, ToolProviderManifest, KnowledgeProviderManifest }
