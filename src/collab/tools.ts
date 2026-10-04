/**
 * Collaboration mode tools — parameterized team patterns built on the core
 * team machinery: cross debate, roundtable, PPT generation, research report.
 *
 * Unlike the preset scenarios (fixed rosters), these tools assemble the team
 * from the caller's expert selection, so the same pattern works with any
 * expert combination (builtin or bk-*). Each mode is now a **thin parameter
 * adapter**: the mode's declarative TeamTemplate (src/collab/templates.ts) is
 * compiled through `compileExecutionPlan` with the caller's params and
 * explicit roster assignments, and the compiled plan is materialized by the
 * common staged-plan boundary. Models are frozen in the reviewable plan;
 * execution requires authenticated user approval or a bound Host grant.
 * @module dsh-expert-library/collab/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { stageCompiledPlanCore, scenarioApproveCore, type ExpertToolsCore, type ToolsConfig } from '../tools.ts'
import { compileErrorOf } from '../apply.ts'
import { readTeam } from '../state.ts'
import { stateRootOf } from '../team-core.ts'
import { compileExecutionPlan } from '../v2/compiler.ts'
import { resolveLibrary } from '../expert-library/registry.ts'
import { resolveSkill, skillDescriptionBlock } from '../skills.ts'
import { buildCollabDomainPack } from './templates.ts'
import { resolveManagedRuntimePack } from '../host/pack-runtime.ts'
import { stancePairForTopic, STANCE_TABLE } from '../zhijian/routing.ts'
import { REPORT_BUNDLE_SCHEMA } from '../profile-schema.ts'
import { isReportBundle, requireNewReportCraftSelection, type ReportBundle } from '../report-bundle.ts'

/** The calling agent, or a loud failure. */
function requireCaptain(exec: ToolRunContext): Agent {
  if (!exec.agent) {
    throw new Error('collab tools require a calling agent (exec.agent was undefined)')
  }
  return exec.agent
}

/**
 * Build one collab team from a declarative plan: validate the caller's expert
 * selection against the live library, compile the mode's TeamTemplate with
 * the caller's params + explicit roster assignments, then stage it through
 * the same model-freezing and authenticated approval boundary as all presets.
 * A waiting plan is durable but has no team or member side effects.
 */
async function applyCollabPlan(
  ctx: Context,
  config: ToolsConfig,
  captain: Agent,
  core: ExpertToolsCore,
  signal: AbortSignal,
  opts: {
    teamName: string
    description: string
    /** Mode id — also the ScenarioV2 id recorded on the team (persona guides). */
    mode: string
    /** Collab TeamTemplate id to compile. */
    templateId: string
    /** Caller-selected experts (deduped roster); validated against the library. */
    expertIds: readonly string[]
    /** Template parameters (topic, data, pro/con, …). */
    params: Record<string, unknown>
    /** Explicit roster assignments per role slot. */
    assignments?: Record<string, readonly string[]>
    /** Explicit AI-selected report contract on the final producer, never a Host default. */
    reportBundle?: ReportBundle
    reportTaskId?: string
  },
): Promise<{
  team_id?: string
  status: 'waiting_user' | 'applied'
  plan_id: string
  digest: string
  revision: number
  team_name: string
  members: string[]
  tasks: { task_id: string; subject: string; assignee?: string }[]
}> {
  const workspace = captain.session.header.cwd ?? process.cwd()
  const library = await resolveLibrary(ctx, workspace, config.knowledgeDir)
  for (const id of opts.expertIds) {
    if (!library.experts.has(id)) {
      throw new Error(`unknown expert "${id}" — available: ${[...library.experts.keys()].join(', ')}`)
    }
  }
  const pack = (await resolveManagedRuntimePack(ctx, config, buildCollabDomainPack([...library.experts.values()]))).pack
  const result = compileExecutionPlan({
    pack,
    templateId: opts.templateId,
    scenarioId: opts.mode,
    params: opts.params,
    ...(opts.assignments === undefined ? {} : { binding: { assignments: opts.assignments } }),
  })
  if (!result.ok) throw compileErrorOf(result)
  let plan = result.plan
  if (opts.reportBundle !== undefined) {
    if (plan.tasks.filter(task => task.id === opts.reportTaskId).length !== 1) throw new Error('report final producer task is missing or ambiguous')
    plan = { ...plan, tasks: plan.tasks.map(task => task.id === opts.reportTaskId ? { ...task, reportBundle: opts.reportBundle } : task) }
  }
  const staged = await stageCompiledPlanCore(ctx, config, captain, plan, {
    teamName: opts.teamName,
    description: opts.description,
  }, { compiled_source: `collab.${opts.mode}`, preset_args: JSON.stringify(opts), team_name: opts.teamName, goal: opts.description })
  const approved = await scenarioApproveCore(ctx, config, captain, staged.planId, signal, core, staged.digest, staged.revision)
  const planRef = { plan_id: approved.planId, digest: approved.digest, revision: approved.revision }
  if (approved.appliedTeamId === undefined) {
    return { ...planRef, status: 'waiting_user', team_name: approved.runtime.teamName, members: [], tasks: [] }
  }
  const team = await readTeam(stateRootOf(workspace, config), approved.appliedTeamId)
  if (team === undefined) throw new Error('approved collaboration team not found')
  return {
    ...planRef,
    status: 'applied',
    team_id: team.id,
    team_name: team.name,
    members: team.members.map(member => member.name),
    tasks: team.tasks.map(task => ({ task_id: task.id, subject: task.subject, ...(task.assignee === undefined ? {} : { assignee: task.assignee }) })),
  }
}

/** Keep a pending plan visibly distinct from a materialized team. */
function renderCollabPlan(label: string, value: {
  status: string; plan_id: string; team_id?: string; team_name: string;
  members: readonly string[]; tasks: readonly { task_id: string; subject: string; assignee?: string }[];
}): string {
  if (value.status === 'waiting_user') {
    return `${label}计划已暂存：${value.team_name}（${value.plan_id}）。请在研究计划面板确认成员模型和任务安排。当前等待用户确认，尚未创建团队或成员；结束当前回合，不要重复批准或绕过确认。`
  }
  return `${label}团队已组建：${value.team_name}（${value.team_id}）。成员：${value.members.join('、')}\n任务：${value.tasks.map(t => `${t.task_id}(${t.assignee ?? '共享'}) ${t.subject}`).join('；')}`
}

/** Register the four collaboration mode tools. */
export function registerCollabTools(
  ctx: Context,
  config: ToolsConfig,
  core: ExpertToolsCore,
): void {
  ctx.tools.register(defineTool({
    name: 'expert_teams_debate',
    description: '先暂存研究计划供用户确认（有 Host 认证授权才执行）。交叉辩论：两位立场对立的专家就同一议题立论-反驳-回应，主持专家裁判总结，输出辩论纪要（论点/交锋点/共识/分歧/裁判结论）。pro_expert/con_expert 可省略——省略时按立场对照表（乐观/底部派 vs 风险揭示派）自动配对。',
    parameters: {
      topic: { type: 'string', required: true, description: '辩题（如"一线城市是否已见底"）。' },
      pro_expert: { type: 'string', description: '正方专家 id（立场偏乐观/支持方）；省略时按立场对照表自动选乐观/底部派。' },
      con_expert: { type: 'string', description: '反方专家 id（立场偏风险/反对方）；省略时按立场对照表自动选风险揭示派。' },
      moderator: { type: 'string', description: '主持/裁判专家 id（默认 team-lead）。' },
      data: { type: 'string', description: '辩题相关的数据/背景（数字带口径；可缺省时由双方自行引用）。' },
      team_name: { type: 'string', description: '团队名（默认"辩论·<辩题>"）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team_id: { type: 'string' },
          status: { type: 'string', enum: ['waiting_user', 'applied'], required: true },
          plan_id: { type: 'string', required: true },
          digest: { type: 'string', required: true },
          revision: { type: 'number', required: true },
          team_name: { type: 'string', required: true },
          members: { type: 'array', items: { type: 'string' }, required: true },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                task_id: { type: 'string', required: true },
                subject: { type: 'string', required: true },
                assignee: { type: 'string' },
              },
            },
            required: true,
          },
          paired: { type: 'string', description: '自动配对说明（当 pro/con 省略时）。' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${renderCollabPlan('辩论', value)}${value.paired !== undefined ? `\n立场配对：${value.paired}` : ''}`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      // P1.3: 立场自动配对 — 省略 pro/con 时按立场对照表选 乐观/底部派 vs 风险揭示派。
      let pairedNote: string | undefined
      let proExpert = args.pro_expert?.trim() ?? ''
      let conExpert = args.con_expert?.trim() ?? ''
      if (proExpert === '' && conExpert === '') {
        const pair = stancePairForTopic(args.topic)
        if (pair === undefined || pair.optimistic.length === 0 || pair.risk.length === 0) {
          throw new Error(`话题「${args.topic}」未命中立场对照表（${STANCE_TABLE.map(p => p.topic).join('；')}），请显式提供 pro_expert/con_expert`)
        }
        proExpert = pair.optimistic[0]!
        conExpert = pair.risk[0]!
        pairedNote = `自动配对（立场对照·${pair.topic}）：${proExpert}（乐观/底部） vs ${conExpert}（风险揭示）`
      } else if (proExpert === '' || conExpert === '') {
        throw new Error('正方与反方专家必须同时提供，或同时省略以自动配对')
      }
      if (proExpert === conExpert) throw new Error('正方与反方必须选择不同专家，不能使用同一 expert')
      const moderator = args.moderator?.trim() || 'team-lead'
      // Role dedup: the moderator may coincide with a debater (e.g. pro is
      // team-lead) — never add the same expert twice as two members.
      const roster = [...new Set([moderator, proExpert, conExpert])]
      const dataBlock = args.data === undefined ? '' : `\n\n辩题背景数据：\n${args.data}`
      const result = await applyCollabPlan(ctx, config, captain, core, exec.signal, {
        teamName: args.team_name?.trim() || `辩论·${args.topic.slice(0, 20)}`,
        description: `交叉辩论：${args.topic}${dataBlock}\n\n输出要求：辩论纪要（双方核心论点、交锋点、共识、分歧、裁判结论）。对外引用身份只标「领域·首字母」。`,
        mode: 'cross-debate',
        templateId: 'collab.cross-debate',
        expertIds: roster,
        params: {
          topic: args.topic,
          ...(args.data !== undefined ? { data: args.data } : {}),
          pro: proExpert,
          con: conExpert,
          moderator,
        },
        assignments: {
          'role.moderator': [moderator],
          'role.pro': [proExpert],
          'role.con': [conExpert],
        },
      })
      if (result.status === 'waiting_user') exec.concludeTurn?.()
      return { ...result, ...(pairedNote === undefined ? {} : { paired: pairedNote }) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_roundtable',
    description: '先暂存研究计划供用户确认（有 Host 认证授权才执行）。圆桌研讨：2-5 位专家就同一议题独立发言（并行），纪要将共识/分歧/开放问题整理成文。',
    parameters: {
      topic: { type: 'string', required: true, description: '研讨议题。' },
      experts: { type: 'array', items: { type: 'string' }, required: true, description: '发言专家 id 列表（2-5 位）。' },
      data: { type: 'string', description: '议题相关数据/背景（数字带口径）。' },
      note_taker: { type: 'string', description: '纪要整理专家 id（默认共享池：任一空闲专家）。' },
      team_name: { type: 'string', description: '团队名（默认"圆桌·<议题>"）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team_id: { type: 'string' },
          status: { type: 'string', enum: ['waiting_user', 'applied'], required: true },
          plan_id: { type: 'string', required: true },
          digest: { type: 'string', required: true },
          revision: { type: 'number', required: true },
          team_name: { type: 'string', required: true },
          members: { type: 'array', items: { type: 'string' }, required: true },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                task_id: { type: 'string', required: true },
                subject: { type: 'string', required: true },
                assignee: { type: 'string' },
              },
            },
            required: true,
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderCollabPlan('圆桌', value),
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const experts = [...new Set(args.experts)]
      if (experts.length < 2) throw new Error('圆桌研讨至少需要 2 位专家')
      if (experts.length > 5) throw new Error('圆桌研讨最多 5 位专家')
      const noteTaker = args.note_taker?.trim()
      // An independent note_taker (not among the speakers) is automatically
      // added to the roster so the 纪要 task has an actual member; when it
      // coincides with a speaker the roster stays deduplicated.
      const roster = noteTaker === undefined
        ? experts
        : experts.includes(noteTaker) ? experts : [...experts, noteTaker]
      const dataBlock = args.data === undefined ? '' : `\n\n议题背景数据：\n${args.data}`
      const result = await applyCollabPlan(ctx, config, captain, core, exec.signal, {
        teamName: args.team_name?.trim() || `圆桌·${args.topic.slice(0, 20)}`,
        description: `圆桌研讨：${args.topic}${dataBlock}\n\n输出要求：圆桌纪要（各专家核心观点、共识、分歧、开放问题、观察指标）。对外引用身份只标「领域·首字母」。`,
        mode: 'roundtable',
        templateId: 'collab.roundtable',
        expertIds: roster,
        params: {
          topic: args.topic,
          ...(args.data !== undefined ? { data: args.data } : {}),
          ...(noteTaker !== undefined ? { noteTaker } : {}),
        },
        assignments: {
          'role.speaker': experts,
          // No note_taker → the optional slot stays empty → the 纪要 task is
          // unassigned (shared pool), exactly like the imperative assembler.
          'role.note-taker': noteTaker === undefined ? [] : [noteTaker],
        },
      })
      if (result.status === 'waiting_user') exec.concludeTurn?.()
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_ppt',
    description: '先暂存研究计划供用户确认（有 Host 认证授权才执行）。PPT 生成：内容架构先行（听众/目标/大纲），领域专家供给关键内容，最终产出逐页文案与演讲备注（markdown 内容包，可直接导入 PPT 工具排版）。',
    parameters: {
      topic: { type: 'string', required: true, description: 'PPT 主题。' },
      content_experts: { type: 'array', items: { type: 'string' }, required: true, description: '内容供给专家 id 列表（1-3 位，提供数据与结论）。' },
      audience: { type: 'string', description: '目标听众（如"管理层""投资客户"），缺省由架构专家判断。' },
      page_count: { type: 'number', description: '预计页数（默认 10-15 页）。' },
      data: { type: 'string', description: '可用素材/数据（数字带口径）。' },
      template: { type: 'string', description: '可选：渲染模板/风格指定（如 "ink-press" 视频模板或 pptfast 主题名）；指定后「渲染和出图」任务严格按该模板渲染。' },
      skill_id: { type: 'string', description: '兼容旧调用的显式本地 skill id；返回实际来源路径，仅作参考，不表示已纳入领域包报告工艺验收。新工艺从当前启用领域包目录选择并记录理由。' },
      team_name: { type: 'string', description: '团队名（默认"PPT·<主题>"）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team_id: { type: 'string' },
          status: { type: 'string', enum: ['waiting_user', 'applied'], required: true },
          plan_id: { type: 'string', required: true },
          digest: { type: 'string', required: true },
          revision: { type: 'number', required: true },
          team_name: { type: 'string', required: true },
          members: { type: 'array', items: { type: 'string' }, required: true },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                task_id: { type: 'string', required: true },
                subject: { type: 'string', required: true },
                assignee: { type: 'string' },
              },
            },
            required: true,
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderCollabPlan('PPT', value),
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const contentExperts = [...new Set(args.content_experts)]
      if (contentExperts.length === 0) throw new Error('content_experts 不能为空')
      if (contentExperts.length > 3) throw new Error('内容供给专家最多 3 位')
      // PPT 架构与文案固定由 docs-coordinator 负责（未选则自动补入）。
      const roster = contentExperts.includes('docs-coordinator')
        ? contentExperts
        : ['docs-coordinator', ...contentExperts]
      const dataBlock = args.data === undefined ? '' : `\n\n可用素材：\n${args.data}`
      const audienceLine = args.audience === undefined ? '' : `\n听众：${args.audience}`
      const pagesLine = args.page_count === undefined ? '' : `\n预计页数：${args.page_count}`
      // The template threads through like audience/page_count/skill_id: a
      // team-description line when provided, and a param (`templateLine`, the
      // render task's interpolation value — always present so `{templateLine}`
      // never leaks as a literal placeholder when no template was given).
      const templateLine = args.template === undefined ? '' : `\n指定模板：${args.template.trim()}`
      const templateBlock = args.template === undefined ? '' : templateLine
      let skillBlock = ''
      if (args.skill_id !== undefined) {
        const workspace = captain.session.header.cwd ?? process.cwd()
        const resolved = await resolveSkill(ctx, workspace, config.knowledgeDir, args.skill_id.trim())
        skillBlock = `\n\n兼容 skill 引用（仅参考，不是领域包报告质量合同）：\n${skillDescriptionBlock(resolved)}`
      }
      const result = await applyCollabPlan(ctx, config, captain, core, exec.signal, {
        teamName: args.team_name?.trim() || `PPT·${args.topic.slice(0, 20)}`,
        description: `PPT 生成：${args.topic}${audienceLine}${pagesLine}${templateBlock}${dataBlock}${skillBlock}\n\n输出要求：markdown 内容包（封面、目录、逐页标题+要点、图表建议、演讲备注）与渲染成品（高工艺 HTML 幻灯片 / PPTX，可选产品视频）。`,
        mode: 'ppt-gen',
        templateId: 'collab.ppt-gen',
        expertIds: roster,
        params: {
          topic: args.topic,
          ...(args.audience !== undefined ? { audience: args.audience } : {}),
          // The architecture task interpolates the page count as display text
          // (number or the "10-15" default), matching the previous assembler.
          pageCountText: String(args.page_count ?? '10-15'),
          ...(args.data !== undefined ? { data: args.data } : {}),
          ...(args.template !== undefined ? { template: args.template.trim() } : {}),
          // Always present: the render task's `{templateLine}` placeholder
          // resolves to the template line (with leading newline) or to ''.
          templateLine,
        },
        assignments: {
          'role.architect': ['docs-coordinator'],
          'role.content': contentExperts,
          'role.writer': ['docs-coordinator'],
        },
      })
      if (result.status === 'waiting_user') exec.concludeTurn?.()
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_report',
    description: '先暂存研究计划供用户确认（有 Host 认证授权才执行）。研报生成：资料梳理、多专家研判、融合稿、最终 MD/HTML/PDF 和证据账本。必须从当前启用领域包工艺目录由 AI 显式选择一个或多个 skill 并提供 report_bundle v3；Host 冻结所选材料与门禁，最终任务须独立审核。',
    parameters: {
      topic: { type: 'string', required: true, description: '研报主题。' },
      experts: { type: 'array', items: { type: 'string' }, required: true, description: '研判专家 id 列表（1-4 位，视角互补，如宏观+风险）。' },
      data: { type: 'string', description: '可用素材/数据（数字带口径）。' },
      writer: { type: 'string', description: '成文专家 id（默认 docs-coordinator；未选则自动补入）。' },
      report_bundle: { ...REPORT_BUNDLE_SCHEMA, required: true },
      team_name: { type: 'string', description: '团队名（默认"研报·<主题>"）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team_id: { type: 'string' },
          status: { type: 'string', enum: ['waiting_user', 'applied'], required: true },
          plan_id: { type: 'string', required: true },
          digest: { type: 'string', required: true },
          revision: { type: 'number', required: true },
          team_name: { type: 'string', required: true },
          members: { type: 'array', items: { type: 'string' }, required: true },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                task_id: { type: 'string', required: true },
                subject: { type: 'string', required: true },
                assignee: { type: 'string' },
              },
            },
            required: true,
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderCollabPlan('研报', value),
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      if (!isReportBundle(args.report_bundle)) throw new Error('REPORT_SKILL_SELECTION_REQUIRED: expert_teams_report requires report_bundle with exact md/html/pdf names and craft:{version:3,selections:[{packId,skillId,variant?,reason}],evidence:"craft-evidence.json"}. Inspect the current session enabled domain craft catalog at /plugins/dsh-expert-library/craft-skills?session_id=<current-session>, choose applicable skills yourself, then retry. No team or member was created.')
      requireNewReportCraftSelection(args.report_bundle)
      const experts = [...new Set(args.experts)]
      if (experts.length === 0) throw new Error('experts 不能为空')
      if (experts.length > 4) throw new Error('研判专家最多 4 位')
      const writer = args.writer?.trim() || 'docs-coordinator'
      const roster = experts.includes(writer) ? experts : [...experts, writer]
      const dataBlock = args.data === undefined ? '' : `\n\n可用素材：\n${args.data}`
      // The provided data is carried explicitly in every task description so
      // members working the DAG see it in their assignment prompt, not only in
      // the team description.
      const dataLine = args.data === undefined ? '' : `\n可用素材/数据（带口径）：\n${args.data}`
      // A single expert owns the 梳理 task and the writer finishes; with ≥2
      // experts the analyst slot fans out one 研判 task per remaining expert.
      // The single-expert variant template omits the analyst task entirely
      // (the compiler cannot drop tasks), reproducing the previous DAG.
      const multi = experts.length >= 2
      const lead = experts[0]!
      const result = await applyCollabPlan(ctx, config, captain, core, exec.signal, {
        teamName: args.team_name?.trim() || `研报·${args.topic.slice(0, 20)}`,
        description: `研报生成：${args.topic}${dataBlock}\n\n输出要求：按显式选择的领域包工艺交付最终 MD、HTML、PDF 与证据账本，数字带口径，引用身份匿名化；在最终文件上完成独立审核。`,
        mode: 'research-report',
        templateId: multi ? 'collab.research-report' : 'collab.research-report-single',
        reportBundle: args.report_bundle,
        reportTaskId: multi ? 't4' : 't3',
        expertIds: roster,
        params: {
          topic: args.topic,
          ...(args.data !== undefined ? { data: args.data } : {}),
          dataLine,
          writer,
        },
        assignments: multi
          ? { 'role.researcher': [lead], 'role.analyst': experts.slice(1), 'role.writer': [writer] }
          : { 'role.researcher': [lead], 'role.writer': [writer] },
      })
      if (result.status === 'waiting_user') exec.concludeTurn?.()
      return result
    },
  }))
}
