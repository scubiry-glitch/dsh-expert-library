/**
 * Collaboration mode tools — parameterized team patterns built on the core
 * team machinery: cross debate, roundtable, PPT generation, research report.
 *
 * Unlike the preset scenarios (fixed rosters), these tools assemble the team
 * from the caller's expert selection and seed the mode-specific task DAG,
 * so the same pattern works with any expert combination (builtin or bk-*).
 * @module dsh-expert-library/collab/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ExpertToolsCore, ToolsConfig } from '../tools.ts'
import { createTeamCore, addMemberCore, createTaskCore } from '../tools.ts'
import { resolveLibrary } from '../expert-library/registry.ts'
import { resolveSkill, skillDescriptionBlock } from '../skills.ts'

/** The calling agent, or a loud failure. */
function requireCaptain(exec: ToolRunContext): Agent {
  if (!exec.agent) {
    throw new Error('collab tools require a calling agent (exec.agent was undefined)')
  }
  return exec.agent
}

/** Validate expert ids against the library; returns their display names. */
async function resolveExpertNames(
  ctx: Context,
  config: ToolsConfig,
  captain: Agent,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const workspace = captain.session.header.cwd ?? process.cwd()
  const library = await resolveLibrary(ctx, workspace, config.knowledgeDir)
  const names = new Map<string, string>()
  for (const id of ids) {
    const expert = library.experts.get(id)
    if (expert === undefined) {
      throw new Error(`unknown expert "${id}" — available: ${[...library.experts.keys()].join(', ')}`)
    }
    names.set(id, expert.name)
  }
  return names
}

/** One task of a collab DAG before creation. */
interface CollabTaskDraft {
  readonly subject: string
  readonly description?: string
  readonly dependencies?: readonly string[]
  /** Expert id owning the task (its member name is resolved later). */
  readonly assigneeExpertId?: string
}

/** Build the team, add the experts, seed the DAG, kick. */
async function buildCollabTeam(
  ctx: Context,
  config: ToolsConfig,
  captain: Agent,
  core: ExpertToolsCore,
  signal: AbortSignal,
  opts: {
    teamName: string
    description: string
    scenarioId?: string
    expertIds: readonly string[]
    tasks: readonly CollabTaskDraft[]
  },
): Promise<{
  team_id: string
  team_name: string
  members: string[]
  tasks: { task_id: string; subject: string; assignee?: string }[]
}> {
  const workspace = captain.session.header.cwd ?? process.cwd()
  const names = await resolveExpertNames(ctx, config, captain, opts.expertIds)

  const team = await createTeamCore(ctx, config, captain, {
    name: opts.teamName,
    description: opts.description,
    ...opts.scenarioId !== undefined ? { scenarioId: opts.scenarioId } : {},
  }, signal)

  const memberNameByExpert = new Map<string, string>()
  const members: string[] = []
  for (const id of opts.expertIds) {
    const added = await addMemberCore(ctx, config, captain, { expert: id }, signal, core.memberSelections)
    memberNameByExpert.set(id, added.member_name)
    members.push(added.member_name)
  }

  const tasks: { task_id: string; subject: string; assignee?: string }[] = []
  for (const draft of opts.tasks) {
    const assignee = draft.assigneeExpertId === undefined
      ? undefined
      : memberNameByExpert.get(draft.assigneeExpertId)
    const created = await createTaskCore(ctx, config, captain, {
      subject: draft.subject,
      ...draft.description !== undefined ? { description: draft.description } : {},
      ...draft.dependencies !== undefined && draft.dependencies.length > 0 ? { dependencies: [...draft.dependencies] } : {},
      ...assignee !== undefined ? { assignee } : {},
    }, signal)
    tasks.push({ task_id: created.task_id, subject: created.subject, ...assignee !== undefined ? { assignee } : {} })
  }

  await core.scheduler.kickTeam(workspace, team.team_id, captain)
  return { team_id: team.team_id, team_name: team.team_name, members, tasks }
}

/** Register the four collaboration mode tools. */
export function registerCollabTools(
  ctx: Context,
  config: ToolsConfig,
  core: ExpertToolsCore,
): void {
  ctx.tools.register(defineTool({
    name: 'expert_teams_debate',
    description: '交叉辩论：两位立场对立的专家就同一议题立论-反驳-回应，主持专家裁判总结，输出辩论纪要（论点/交锋点/共识/分歧/裁判结论）。',
    parameters: {
      topic: { type: 'string', required: true, description: '辩题（如"一线城市是否已见底"）。' },
      pro_expert: { type: 'string', required: true, description: '正方专家 id（立场偏乐观/支持方）。' },
      con_expert: { type: 'string', required: true, description: '反方专家 id（立场偏风险/反对方），须与正方立场对立。' },
      moderator: { type: 'string', description: '主持/裁判专家 id（默认 team-lead）。' },
      data: { type: 'string', description: '辩题相关的数据/背景（数字带口径；可缺省时由双方自行引用）。' },
      team_name: { type: 'string', description: '团队名（默认"辩论·<辩题>"）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
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
        text: `辩论团队已组建：${value.team_name}（${value.team_id}）。成员：${value.members.join('、')}\n任务：${value.tasks.map(t => `${t.task_id}(${t.assignee ?? '共享'}) ${t.subject}`).join('；')}`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const moderator = args.moderator?.trim() || 'team-lead'
      const dataBlock = args.data === undefined ? '' : `\n\n辩题背景数据：\n${args.data}`
      const result = await buildCollabTeam(ctx, config, captain, core, exec.signal, {
        teamName: args.team_name?.trim() || `辩论·${args.topic.slice(0, 20)}`,
        description: `交叉辩论：${args.topic}${dataBlock}\n\n输出要求：辩论纪要（双方核心论点、交锋点、共识、分歧、裁判结论）。对外引用身份只标「领域·首字母」。`,
        scenarioId: 'cross-debate',
        expertIds: [moderator, args.pro_expert, args.con_expert],
        tasks: [
          { subject: '辩题与规则确认', description: `明确辩题「${args.topic}」、双方立场与判定标准（论据须带口径与来源），输出辩论议程。`, assigneeExpertId: moderator },
          { subject: `正方立论（${args.pro_expert}）`, description: `陈述立场与核心论据（数据带口径、引用来源）：立场声明 → 论据 2-3 条 → 预期对方弱点。`, dependencies: [], assigneeExpertId: args.pro_expert },
          { subject: `反方反驳（${args.con_expert}）`, description: '逐条反驳正方论据并给出反论据：反驳点 → 反论据（带口径）→ 正方立场中的漏洞。', dependencies: ['t2'], assigneeExpertId: args.con_expert },
          { subject: `正方回应（${args.pro_expert}）`, description: '回应反驳：承认有效点、澄清误解、强化核心立场。', dependencies: ['t3'], assigneeExpertId: args.pro_expert },
          { subject: '裁判总结', description: '输出辩论纪要：双方核心论点、交锋点、共识、分歧、判定逻辑与最终观点（不强制二选一，可给条件性结论）。', dependencies: ['t4'], assigneeExpertId: moderator },
        ],
      })
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_roundtable',
    description: '圆桌研讨：2-5 位专家就同一议题独立发言（并行），纪要将共识/分歧/开放问题整理成文。',
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
          team_id: { type: 'string', required: true },
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
        text: `圆桌团队已组建：${value.team_name}（${value.team_id}）。成员：${value.members.join('、')}\n任务：${value.tasks.map(t => `${t.task_id}(${t.assignee ?? '共享'}) ${t.subject}`).join('；')}`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const experts = [...new Set(args.experts)]
      if (experts.length < 2) throw new Error('圆桌研讨至少需要 2 位专家')
      if (experts.length > 5) throw new Error('圆桌研讨最多 5 位专家')
      const dataBlock = args.data === undefined ? '' : `\n\n议题背景数据：\n${args.data}`
      const tasks: CollabTaskDraft[] = experts.map((id, index) => ({
        subject: `专家发言（${id}）`,
        description: `以本人立场独立发言：核心判断 → 依据（数据带口径）→ 前瞻。议题：${args.topic}`,
      }))
      tasks.push({
        subject: '圆桌纪要整理',
        description: `综合全部发言整理纪要（用 expert_teams_status 读取各任务 output）：共识点、分歧点（含各自依据）、开放问题、后续可验证的观察指标。议题：${args.topic}`,
        dependencies: experts.map((_id, index) => `t${index + 1}`),
        ...(args.note_taker !== undefined ? { assigneeExpertId: args.note_taker } : {}),
      })
      const result = await buildCollabTeam(ctx, config, captain, core, exec.signal, {
        teamName: args.team_name?.trim() || `圆桌·${args.topic.slice(0, 20)}`,
        description: `圆桌研讨：${args.topic}${dataBlock}\n\n输出要求：圆桌纪要（各专家核心观点、共识、分歧、开放问题、观察指标）。对外引用身份只标「领域·首字母」。`,
        scenarioId: 'roundtable',
        expertIds: experts,
        tasks,
      })
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_ppt',
    description: 'PPT 生成：内容架构先行（听众/目标/大纲），领域专家供给关键内容，最终产出逐页文案与演讲备注（markdown 内容包，可直接导入 PPT 工具排版）。',
    parameters: {
      topic: { type: 'string', required: true, description: 'PPT 主题。' },
      content_experts: { type: 'array', items: { type: 'string' }, required: true, description: '内容供给专家 id 列表（1-3 位，提供数据与结论）。' },
      audience: { type: 'string', description: '目标听众（如"管理层""投资客户"），缺省由架构专家判断。' },
      page_count: { type: 'number', description: '预计页数（默认 10-15 页）。' },
      data: { type: 'string', description: '可用素材/数据（数字带口径）。' },
      skill_repo: { type: 'string', description: '可选：外部 skill 的 GitHub repo（owner/repo），其 SKILL.md 会缓存到 knowledge/skills/ 供成员参考（如 Vincentwei1021/video-shotcraft）。' },
      team_name: { type: 'string', description: '团队名（默认"PPT·<主题>"）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
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
        text: `PPT 团队已组建：${value.team_name}（${value.team_id}）。成员：${value.members.join('、')}\n任务：${value.tasks.map(t => `${t.task_id}(${t.assignee ?? '共享'}) ${t.subject}`).join('；')}`,
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
      let skillBlock = ''
      if (args.skill_repo !== undefined) {
        const workspace = captain.session.header.cwd ?? process.cwd()
        const resolved = await resolveSkill(ctx, workspace, config.knowledgeDir, args.skill_repo.trim())
        skillBlock = `\n\n${skillDescriptionBlock(resolved)}`
      }
      const tasks: CollabTaskDraft[] = [
        {
          subject: '内容架构',
          description: `确定听众（${args.audience ?? '缺省由你判断'}）、目标与篇幅（${args.page_count ?? '10-15'} 页），输出 PPT 大纲：章节结构 + 每页标题与要点。主题：${args.topic}`,
          assigneeExpertId: 'docs-coordinator',
        },
        ...contentExperts
          .filter(id => id !== 'docs-coordinator')
          .map((id, index) => ({
            subject: `内容供给（${id}）`,
            description: `按大纲供给关键数据、结论与案例（数字带口径与来源），标注每页建议引用。主题：${args.topic}`,
            dependencies: ['t1'],
            assigneeExpertId: id,
          })),
        {
          subject: '逐页文案生成',
          description: `按大纲与内容产出逐页文案（markdown 内容包）：封面/目录/每页标题+要点（每页≤5 条）/图表建议/演讲备注。主题：${args.topic}`,
          dependencies: ['t1', ...contentExperts.filter(id => id !== 'docs-coordinator').map((_id, index) => `t${index + 2}`)],
          assigneeExpertId: 'docs-coordinator',
        },
      ]
      const result = await buildCollabTeam(ctx, config, captain, core, exec.signal, {
        teamName: args.team_name?.trim() || `PPT·${args.topic.slice(0, 20)}`,
        description: `PPT 生成：${args.topic}${audienceLine}${pagesLine}${dataBlock}${skillBlock}\n\n输出要求：markdown 内容包（封面、目录、逐页标题+要点、图表建议、演讲备注），可直接导入 PPT 工具排版。`,
        scenarioId: 'ppt-gen',
        expertIds: roster,
        tasks,
      })
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_report',
    description: '研报生成：资料梳理先行，多位专家并行研判（各视角），融合成结构完整的研报（标题/摘要/正文/结论/风险/附录，markdown）。',
    parameters: {
      topic: { type: 'string', required: true, description: '研报主题。' },
      experts: { type: 'array', items: { type: 'string' }, required: true, description: '研判专家 id 列表（1-4 位，视角互补，如宏观+风险）。' },
      data: { type: 'string', description: '可用素材/数据（数字带口径）。' },
      writer: { type: 'string', description: '成文专家 id（默认 docs-coordinator；未选则自动补入）。' },
      team_name: { type: 'string', description: '团队名（默认"研报·<主题>"）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
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
        text: `研报团队已组建：${value.team_name}（${value.team_id}）。成员：${value.members.join('、')}\n任务：${value.tasks.map(t => `${t.task_id}(${t.assignee ?? '共享'}) ${t.subject}`).join('；')}`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const experts = [...new Set(args.experts)]
      if (experts.length === 0) throw new Error('experts 不能为空')
      if (experts.length > 4) throw new Error('研判专家最多 4 位')
      const writer = args.writer?.trim() || 'docs-coordinator'
      const roster = experts.includes(writer) ? experts : [...experts, writer]
      const dataBlock = args.data === undefined ? '' : `\n\n可用素材：\n${args.data}`
      const tasks: CollabTaskDraft[] = [
        {
          subject: '资料与数据梳理',
          description: `梳理主题相关资料与数据：关键事实、数据口径、时间线、争议点。主题：${args.topic}`,
          assigneeExpertId: experts[0],
        },
        ...experts.slice(1).map((id, index) => ({
          subject: `专家研判（${id}）`,
          description: `以本人立场独立研判：核心判断 → 关键事实与分析（数字带口径）→ 展望与不确定性。主题：${args.topic}`,
          dependencies: ['t1'],
          assigneeExpertId: id,
        })),
        {
          subject: '融合成文',
          description: `整合全部研判输出完整研报（markdown）：标题、摘要、正文（背景/分析/展望）、结论、风险提示、附录（数据与口径）。主题：${args.topic}。先定主基调 keynote，偏离观点降级为边界条件。`,
          dependencies: ['t1', ...experts.slice(1).map((_id, index) => `t${index + 2}`)],
          assigneeExpertId: writer,
        },
      ]
      const result = await buildCollabTeam(ctx, config, captain, core, exec.signal, {
        teamName: args.team_name?.trim() || `研报·${args.topic.slice(0, 20)}`,
        description: `研报生成：${args.topic}${dataBlock}\n\n输出要求：完整研报（标题、摘要、正文、结论、风险提示、附录），数字带口径，引用身份匿名化。`,
        scenarioId: 'research-report',
        expertIds: roster,
        tasks,
      })
      return result
    },
  }))
}
