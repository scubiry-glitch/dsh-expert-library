/**
 * Declarative TeamTemplates for the four collaboration modes
 * (`expert_teams_debate` / `roundtable` / `ppt` / `report`).
 *
 * These templates are the single declarative source of the collab task DAGs
 * that were previously hand-built imperatively in `collab/tools.ts`. Each
 * mode compiles through `compileExecutionPlan` with `params` (topic, expert
 * ids, data, …) + explicit `binding.assignments` (the caller-selected
 * roster), and the apply bridge fans logical tasks out per `expertIds`.
 *
 * Naming/ordering conventions (behavior-preserving):
 * - template ids are `collab.<mode>`; the ScenarioV2 ids equal the V1 builtin
 *   scenario ids (`cross-debate` etc.) so `TeamState.scenarioId` and the
 *   persona knowledge guides are unchanged;
 * - task ids are `t1..tn` in the same creation order the imperative
 *   assemblers produced, and subject/description placeholders reproduce the
 *   exact current strings after interpolation;
 * - role slots declare `capabilities: []` (any library expert qualifies);
 *   cardinality mirrors the current validation (roundtable speakers 2-5,
 *   ppt content 1-3, report analyst 0-3, single-expert report uses a separate
 *   template without the analyst task because the compiler cannot drop
 *   tasks);
 * - `role.note-taker` and `role.fusion`-style optional slots stay at
 *   `min: 0` so unassigned tasks remain in the shared pool.
 * @module dsh-expert-library/collab/templates
 */

import type { DomainPackV2, OutputTemplate, QualityPolicy, RoleSlot, ScenarioV2, TaskTemplate, TeamTemplate } from '../v2/types.ts'
import { SCHEMA_VERSION } from '../v2/types.ts'
import { buildLegacyDomainPack } from '../v2/compat.ts'
import type { Expert } from '../expert-library/types.ts'

/** Version stamp of every collab V2 asset. */
const COLLAB_VERSION = '1.0.0-collab'

/** Shared output template id referenced by every collab task/deliverable. */
const COLLAB_OUTPUT_ID = 'collab.output'

/** Shared (empty) quality policy id so template/scenario refs resolve. */
const COLLAB_QUALITY_ID = 'collab.quality'

/** One collab task: no inputs/capabilities, legacy output schema, no retry. */
function task(id: string, role: string, subject: string, description: string, dependsOn: readonly string[] = []): TaskTemplate {
  return {
    id,
    role,
    dependsOn: [...dependsOn],
    inputs: [],
    allowedCapabilities: [],
    outputSchema: COLLAB_OUTPUT_ID,
    retryPolicy: 'never',
    subject,
    description,
  }
}

/** One collab role slot: unconstrained capabilities, explicit cardinality. */
function slot(id: string, min: number, max: number): RoleSlot {
  return { id, capabilities: [], cardinality: { min, max } }
}

/** 交叉辩论: 规则确认 → 立论 → 反驳 → 回应 → 裁判总结. */
const debate: TeamTemplate = {
  id: 'collab.cross-debate',
  version: COLLAB_VERSION,
  schemaVersion: SCHEMA_VERSION,
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '辩题' },
      data: { type: 'string', description: '辩题相关的数据/背景（数字带口径）' },
      pro: { type: 'string', description: '正方专家 id' },
      con: { type: 'string', description: '反方专家 id' },
      moderator: { type: 'string', default: 'team-lead', description: '主持/裁判专家 id' },
    },
    required: ['topic', 'pro', 'con'],
  },
  slots: [slot('role.moderator', 1, 1), slot('role.pro', 1, 1), slot('role.con', 1, 1)],
  tasks: [
    task('t1', 'role.moderator', '辩题与规则确认', '明确辩题「{topic}」、双方立场与判定标准（论据须带口径与来源），输出辩论议程。'),
    task('t2', 'role.pro', '正方立论（{expertId}）', '陈述立场与核心论据（数据带口径、引用来源）：立场声明 → 论据 2-3 条 → 预期对方弱点。', ['t1']),
    task('t3', 'role.con', '反方反驳（{expertId}）', '逐条反驳正方论据并给出反论据：反驳点 → 反论据（带口径）→ 正方立场中的漏洞。', ['t2']),
    task('t4', 'role.pro', '正方回应（{expertId}）', '回应反驳：承认有效点、澄清误解、强化核心立场。', ['t3']),
    task('t5', 'role.moderator', '裁判总结', '输出辩论纪要：双方核心论点、交锋点、共识、分歧、判定逻辑与最终观点（不强制二选一，可给条件性结论）。', ['t4']),
  ],
  gates: [],
  deliverables: [{ id: 'd1', outputTemplate: COLLAB_OUTPUT_ID, fromTasks: ['t1', 't2', 't3', 't4', 't5'] }],
}

/** 圆桌研讨: N 位专家并行发言（fan-out）→ 纪要整理. */
const roundtable: TeamTemplate = {
  id: 'collab.roundtable',
  version: COLLAB_VERSION,
  schemaVersion: SCHEMA_VERSION,
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '研讨议题' },
      data: { type: 'string', description: '议题相关数据/背景' },
      noteTaker: { type: 'string', description: '纪要整理专家 id（缺省共享池）' },
    },
    required: ['topic'],
  },
  slots: [slot('role.speaker', 2, 5), slot('role.note-taker', 0, 1)],
  tasks: [
    task('t1', 'role.speaker', '专家发言（{expertId}）', '以本人立场独立发言：核心判断 → 依据（数据带口径）→ 前瞻。议题：{topic}'),
    task('t2', 'role.note-taker', '圆桌纪要整理', '综合全部发言整理纪要（用 expert_teams_status 读取各任务 output）：共识点、分歧点（含各自依据）、开放问题、后续可验证的观察指标。议题：{topic}', ['t1']),
  ],
  gates: [],
  deliverables: [{ id: 'd1', outputTemplate: COLLAB_OUTPUT_ID, fromTasks: ['t1', 't2'] }],
}

/** PPT 生成: 内容架构 → 内容供给（fan-out）→ 逐页文案. */
const ppt: TeamTemplate = {
  id: 'collab.ppt-gen',
  version: COLLAB_VERSION,
  schemaVersion: SCHEMA_VERSION,
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'PPT 主题' },
      audience: { type: 'string', default: '缺省由你判断', description: '目标听众' },
      pageCountText: { type: 'string', description: '预计页数显示文本（如 "12" 或 "10-15"）' },
      data: { type: 'string', description: '可用素材/数据（数字带口径）' },
    },
    required: ['topic'],
  },
  slots: [slot('role.architect', 1, 1), slot('role.content', 1, 3), slot('role.writer', 1, 1)],
  tasks: [
    task('t1', 'role.architect', '内容架构', '确定听众（{audience}）、目标与篇幅（{pageCountText} 页），输出 PPT 大纲：章节结构 + 每页标题与要点。主题：{topic}'),
    task('t2', 'role.content', '内容供给（{expertId}）', '按大纲供给关键数据、结论与案例（数字带口径与来源），标注每页建议引用。主题：{topic}', ['t1']),
    task('t3', 'role.writer', '逐页文案生成', '按大纲与内容产出逐页文案（markdown 内容包）：封面/目录/每页标题+要点（每页≤5 条）/图表建议/演讲备注。主题：{topic}', ['t1', 't2']),
  ],
  gates: [],
  deliverables: [{ id: 'd1', outputTemplate: COLLAB_OUTPUT_ID, fromTasks: ['t1', 't2', 't3'] }],
}

/** 研报生成（≥2 位研判专家）: 梳理 → 研判（fan-out）→ 融合成文. */
const report: TeamTemplate = {
  id: 'collab.research-report',
  version: COLLAB_VERSION,
  schemaVersion: SCHEMA_VERSION,
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '研报主题' },
      data: { type: 'string', description: '可用素材/数据（数字带口径）' },
      dataLine: { type: 'string', description: '嵌入任务描述的数据行（含换行；无数据为空串）' },
      writer: { type: 'string', default: 'docs-coordinator', description: '成文专家 id' },
    },
    required: ['topic'],
  },
  slots: [slot('role.researcher', 1, 1), slot('role.analyst', 0, 3), slot('role.writer', 1, 1)],
  tasks: [
    task('t1', 'role.researcher', '资料与数据梳理', '梳理主题相关资料与数据：关键事实、数据口径、时间线、争议点。主题：{topic}{dataLine}'),
    task('t2', 'role.analyst', '专家研判（{expertId}）', '以本人立场独立研判：核心判断 → 关键事实与分析（数字带口径）→ 展望与不确定性。主题：{topic}{dataLine}', ['t1']),
    task('t3', 'role.writer', '融合成文', '整合全部研判输出完整研报（markdown）：标题、摘要、正文（背景/分析/展望）、结论、风险提示、附录（数据与口径）。主题：{topic}{dataLine}。先定主基调 keynote，偏离观点降级为边界条件。', ['t1', 't2']),
  ],
  gates: [],
  deliverables: [{ id: 'd1', outputTemplate: COLLAB_OUTPUT_ID, fromTasks: ['t1', 't2', 't3'] }],
}

/**
 * 研报生成（单研判专家）: the analyst task must not exist when there is no
 * analyst — the compiler cannot drop tasks, so a variant template omits it
 * (t1 梳理 → t2 融合), reproducing the imperative assembler's 1-expert DAG.
 */
const reportSingle: TeamTemplate = {
  id: 'collab.research-report-single',
  version: COLLAB_VERSION,
  schemaVersion: SCHEMA_VERSION,
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '研报主题' },
      data: { type: 'string', description: '可用素材/数据（数字带口径）' },
      dataLine: { type: 'string', description: '嵌入任务描述的数据行（含换行；无数据为空串）' },
      writer: { type: 'string', default: 'docs-coordinator', description: '成文专家 id' },
    },
    required: ['topic'],
  },
  slots: [slot('role.researcher', 1, 1), slot('role.writer', 1, 1)],
  tasks: [
    task('t1', 'role.researcher', '资料与数据梳理', '梳理主题相关资料与数据：关键事实、数据口径、时间线、争议点。主题：{topic}{dataLine}'),
    task('t2', 'role.writer', '融合成文', '整合全部研判输出完整研报（markdown）：标题、摘要、正文（背景/分析/展望）、结论、风险提示、附录（数据与口径）。主题：{topic}{dataLine}。先定主基调 keynote，偏离观点降级为边界条件。', ['t1']),
  ],
  gates: [],
  deliverables: [{ id: 'd1', outputTemplate: COLLAB_OUTPUT_ID, fromTasks: ['t1', 't2'] }],
}

/** Every collab TeamTemplate (declaration order = compile/test order). */
export const COLLAB_TEAM_TEMPLATES: readonly TeamTemplate[] = [debate, roundtable, ppt, report, reportSingle]

/** Mode id (V1 builtin scenario id) → collab template id. */
export const COLLAB_TEMPLATE_BY_MODE: Readonly<Record<string, string>> = {
  'cross-debate': 'collab.cross-debate',
  'roundtable': 'collab.roundtable',
  'ppt-gen': 'collab.ppt-gen',
  'research-report': 'collab.research-report',
  'research-report-single': 'collab.research-report-single',
}

/** Shared collab output template (one unspecified required section). */
export const COLLAB_OUTPUT_TEMPLATE: OutputTemplate = {
  id: COLLAB_OUTPUT_ID,
  version: COLLAB_VERSION,
  schemaVersion: SCHEMA_VERSION,
  media: ['markdown'],
  sections: [{ id: 'deliverable', required: true }],
  renderModes: { final: { anonymize: false } },
}

/** Shared collab quality policy: no executable gates (runtime has none yet). */
export const COLLAB_QUALITY_POLICY: QualityPolicy = {
  id: COLLAB_QUALITY_ID,
  version: COLLAB_VERSION,
  schemaVersion: SCHEMA_VERSION,
  gates: [],
  maxRepairRounds: 0,
}

/** Minimal ScenarioV2 per mode: ids equal the V1 builtin scenario ids. */
function collabScenario(id: string, name: string): ScenarioV2 {
  return {
    id,
    version: COLLAB_VERSION,
    schemaVersion: SCHEMA_VERSION,
    domain: 'collab',
    intents: [`collab.${id}`],
    requiredCapabilities: [],
    routingPolicy: { candidateHints: [] },
    teamTemplate: COLLAB_TEMPLATE_BY_MODE[id] ?? `collab.${id}`,
    outputTemplate: COLLAB_OUTPUT_ID,
    qualityPolicy: COLLAB_QUALITY_ID,
    knowledgePolicy: { required: [] },
    toolPolicy: { allowed: [] },
  }
}

/** The four mode scenarios (single-expert report is a variant, not a scenario). */
export const COLLAB_SCENARIOS: readonly ScenarioV2[] = [
  collabScenario('cross-debate', 'Cross Debate'),
  collabScenario('roundtable', 'Roundtable'),
  collabScenario('ppt-gen', 'PPT Generation'),
  collabScenario('research-report', 'Research Report'),
]

/**
 * Build the compile pack for one collab apply: the resolved library experts
 * projected through the conservative V1 adapter, plus the collab templates,
 * the shared output template/quality policy and the four mode scenarios.
 */
export function buildCollabDomainPack(experts: readonly Expert[]): DomainPackV2 {
  const legacy = buildLegacyDomainPack({ experts, scenarios: [] })
  return {
    ...legacy,
    teamTemplates: COLLAB_TEAM_TEMPLATES,
    outputTemplates: [COLLAB_OUTPUT_TEMPLATE, ...legacy.outputTemplates],
    qualityPolicies: [COLLAB_QUALITY_POLICY, ...legacy.qualityPolicies],
    scenarios: COLLAB_SCENARIOS,
  }
}
