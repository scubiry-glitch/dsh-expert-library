/** Shared model-visible contract for all explicit-profile plan tools. */
import type { ParameterPropertySpec } from '@deepseek-ai/dsh-tools'

export const PROFILE_STAGE_EXAMPLE = {
  profile: {
    schemaVersion: 1, id: 'research-plan', version: '1', description: 'Produce a verified report',
    protocol: ['Record evidence and obtain independent review'],
    members: [{ id: 'researcher', name: 'Researcher', role: 'research', maxDepth: 0 }],
    taskPlanning: 'captain', review: { required: true, maxRepairRounds: 2 },
  },
  tasks: [{ id: 'collect', subject: 'Collect evidence', owner: 'researcher', dependsOn: [], acceptance: ['Claims cite their sources'] }],
}

const stringList = { type: 'array', items: { type: 'string' } } as const
export const REPORT_BUNDLE_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'Explicit report task. Choose applicable skills from enabled domain packs: craft:{version:3,selections:[{packId,skillId,variant?,reason}],evidence:"craft-evidence.json"}. The Host freezes those skills and their domain-owned quality contracts; no default skill is selected for you. Exact publication filenames only. New report tasks require v3. Historical v1/v2 records remain readable; explicit revisions inherit the source contract by omitting report_bundle. Independent review is required.',
  properties: {
    md: { type: 'string', required: true },
    html: { type: 'string', required: true },
    pdf: { type: 'string', required: true },
    craft: { type: 'object', required: true, additionalProperties: false, properties: {
      version: { type: 'integer', const: 3, required: true },
      selections: { type: 'array', required: true, description: 'One to eight explicitly selected skills; include required dependencies yourself. Paths, digests and resolved policies are Host-only.', items: {
        type: 'object', additionalProperties: false, properties: {
          packId: { type: 'string', required: true }, skillId: { type: 'string', required: true },
          variant: { type: 'string', description: 'A variant declared by this skill; do not invent values.' },
          reason: { type: 'string', required: true, description: 'Why this skill applies to this task.' },
        },
      } },
      evidence: { type: 'string', required: true, description: 'Safe JSON publication filename for the selected skills’ evidence ledger.' },
    } },
  },
} as const satisfies ParameterPropertySpec
const safeId = 'Stable id: 1–64 ASCII letters/digits/dot/underscore/hyphen, starting with a letter or digit.'
const routeProperties = {
  provider: { type: 'string', required: true, description: 'Configured provider id. Must be inside this route object together with model.' },
  model: { type: 'string', required: true, description: 'Configured model id; a sibling member.model does not satisfy route.model.' },
  reasoningEffort: { type: 'string', description: 'Optional nonempty reasoning effort supported by the selected route.' },
} as const
const route = { type: 'object', additionalProperties: false, properties: routeProperties } as const

export const PROFILE_TASK_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'One task. Use owner (not assignee) and dependsOn for dependency task ids; dependencies is a compatibility alias. Preserve the declared graph when correcting other fields. Owners may repeat across tasks.',
  properties: {
    id: { type: 'string', required: true, description: safeId },
    subject: { type: 'string', required: true, description: 'Nonempty task title.' },
    description: { type: 'string', description: 'Concrete work and deliverables; nonempty when provided.' },
    owner: { type: 'string', description: 'Member id or name, or captain. Omission leaves the task in the shared pool.' },
    dependsOn: { ...stringList, description: 'Existing task ids; defaults to []. The graph must be acyclic.' },
    dependencies: { ...stringList, description: 'Alias of dependsOn, normalized to dependsOn. If both are supplied, their task-id sets must agree; conflicts are rejected, never merged.' },
    acceptance: { ...stringList, description: 'Nonempty acceptance statements, carried into the task quality contract alongside output-present.' },
    reportBundle: REPORT_BUNDLE_SCHEMA,
  },
} as const satisfies ParameterPropertySpec

export const PROFILE_TASKS_SCHEMA = {
  type: 'array', items: PROFILE_TASK_SCHEMA,
  description: 'Captain-generated DAG at tool top level. Keep profile.taskPlanning="captain" and omit profile.tasks/templateId. In a same-mode profile edit, omission preserves the current generated DAG; explicit [] clears a captain draft. Seed profiles instead carry nonempty profile.tasks. Use dependsOn (dependencies is accepted as an alias); use [] only for tasks with no prerequisites.',
  examples: [PROFILE_STAGE_EXAMPLE.tasks],
} as const satisfies ParameterPropertySpec

export const PROFILE_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'Explicit profile: use members (not roster), review (not reviewPolicy). Required metadata is shown below. Omitted routes inherit configured selection. Example full call: ' + JSON.stringify(PROFILE_STAGE_EXAMPLE),
  examples: [PROFILE_STAGE_EXAMPLE.profile],
  properties: {
    schemaVersion: { type: 'integer', const: 1, required: true },
    id: { type: 'string', required: true, description: safeId },
    version: { type: 'string', required: true, description: 'Nonempty profile version string.' },
    description: { type: 'string', required: true, description: 'Nonempty purpose.' },
    protocol: { oneOf: [{ type: 'string' }, stringList], required: true, description: 'Nonempty protocol string, or an array of nonempty protocol strings.' },
    members: {
      type: 'array', required: true, description: '1–32 distinct member ids/names, subject to configured team limit. Multiple members may share the same expert persona.',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', description: safeId + ' Defaults to name; supply an ASCII id for a non-ASCII display name.' },
          name: { type: 'string', required: true, description: 'Unique nonempty display name.' },
          role: { type: 'string', description: 'Nonempty work role.' },
          expert: { type: 'string', description: 'Optional existing Expert Library persona id; omit for a custom member.' },
          route: { ...route, description: 'Both provider and model belong here. Do not also supply flat provider/model/reasoningEffort.' },
          provider: { type: 'string', description: 'Legacy flat route; requires sibling model and forbids route.' },
          model: { type: 'string', description: 'Legacy flat route; requires sibling provider and forbids route.' },
          reasoningEffort: { type: 'string', description: 'Legacy flat route option; forbids route.' },
          capabilities: { ...stringList, description: 'Capability ids, not arbitrary Host tool names.' },
          maxDepth: { type: 'integer', description: 'Nonnegative delegation depth; 0 disables child delegation.' },
        },
      },
    },
    route: { ...route, description: 'Optional default route for all members.' },
    fallback: { type: 'array', items: { ...route, properties: { ...routeProperties, reason: { type: 'string' } } } },
    taskPlanning: { type: 'string', enum: ['captain', 'seed'], required: true, description: 'captain: DAG goes in tool top-level tasks; seed: nonempty DAG goes in profile.tasks.' },
    review: {
      type: 'object', additionalProperties: false,
      properties: {
        required: { type: 'boolean' },
        maxRepairRounds: { type: 'integer', enum: [0, 1, 2] },
        hardGateIds: stringList,
      },
    },
    templateId: { type: 'string', description: 'Seed-only metadata; does not load a template. Still requires profile.tasks.' },
    tasks: { type: 'array', items: PROFILE_TASK_SCHEMA, description: 'Nonempty fixed seed DAG. Forbidden inside a captain profile; use tool top-level tasks.' },
  },
} as const satisfies ParameterPropertySpec
