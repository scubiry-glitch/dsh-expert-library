/**
 * Zhijian review tools: native expert-team routing for 智见点评.
 *
 * - expert_review_route: structured route lookup — topic type → output
 *   framework → primary field → candidate experts (anonymized for user
 *   sign-off). Replaces the model reading 路由规则.md itself.
 * - expert_review_apply: assemble the review team from the user's sign-off —
 *   creates the team, adds the chosen bk-* experts (Profile baked personas),
 *   seeds the framework task DAG (parallel reviews → fusion → render).
 *
 * Framework E (顾问式自由问答) intentionally does NOT build a team: it is a
 * single-voice advisory answer, handled by the captain directly.
 * @module dsh-expert-library/zhijian/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ExpertToolsCore, ToolsConfig } from '../tools.ts'
import { steerCaptainReport } from '../tools.ts'
import { applyExecutionPlan, compileErrorOf } from '../apply.ts'
import { compileExecutionPlan } from '../v2/compiler.ts'
import { buildZhijianDomainPack } from '../v2/zhijian-pack.ts'
import { frameworkById, GLOBAL_OUTPUT_RULES } from './frameworks.ts'
import { ZHIJIAN_EXPERTS } from './data/experts.generated.ts'
import {
  ROUTE_TOPICS, ROUTE_SCENARIOS, STANCE_TABLE, SPECIAL_ROUTING, ROUTING_CONSTRAINTS,
  scenarioForTopic, topicRouteFor,
} from './routing.ts'
import type { ZhijianFrameworkId, ZhijianRouteResult } from './types.ts'

/** The calling agent, or a loud failure. */
function requireCaptain(exec: ToolRunContext): Agent {
  if (!exec.agent) {
    throw new Error('expert_review tools require a calling agent (exec.agent was undefined)')
  }
  return exec.agent
}

/**
 * Route one request to a framework and candidate roster.
 *
 * The free-form `question` participates in routing: when the `topic` type
 * itself does not match any route, the question text is matched against the
 * topic table as a fallback (see `topicRouteFor`/`scenarioForTopic`).
 *
 * Exported for unit testing at the pure input boundary.
 */
export function routeRequest(topic: string, question?: string): ZhijianRouteResult {
  const route = topicRouteFor(topic, question)
  if (route === undefined) {
    const topics = ROUTE_TOPICS.map(item => item.topic).join('；')
    throw new Error(
      `无法判定话题类型。请从以下话题类型中选择（或改写问题使其匹配）：\n${topics}\n`
      + `特殊路由：${SPECIAL_ROUTING.join('；')}`,
    )
  }
  const scenario = scenarioForTopic(topic, route.framework, question)
  const candidates = (scenario?.candidates ?? [])
    .map(id => ZHIJIAN_EXPERTS.find(meta => meta.id === id))
    .filter((meta): meta is NonNullable<typeof meta> => meta !== undefined)
    .map(meta => ({
      id: meta.id,
      bk: meta.bk,
      field: meta.field,
      stance: meta.stance,
      initials: meta.initials,
      tags: meta.tags,
      ...(meta.deceased === true ? { deceased: true } : {}),
    }))
  return {
    topic: route.topic,
    framework: route.framework,
    primaryField: route.primaryField,
    candidates,
    ...(scenario?.constraints !== undefined ? { constraints: scenario.constraints } : {}),
  }
}

/** Register the Zhijian review tools. */
export function registerZhijianTools(
  ctx: Context,
  config: ToolsConfig,
  core: ExpertToolsCore,
): void {
  ctx.tools.register(defineTool({
    name: 'expert_review_route',
    description: '智见点评路由：按话题类型判定输出框架、主责领域与候选专家（3-5 位），供队长展示给用户拍板。候选以「BK 号 · 主领域 · 首字母」匿名呈现（内部保留实名）。框架 E（自由提问/FAQ/购房决策）不建队，由队长直接以顾问口吻回答。',
    parameters: {
      topic: {
        type: 'string',
        required: true,
        description: '话题类型或问题描述（如"城市月度市场分析""政策解读""宏观形势展望""金融风险""城市机会""行业经营""服务业务""制度设计""多视角综合分析""自由提问"），或直接粘贴用户问题。',
      },
      question: { type: 'string', description: '具体问题/待点评内容（可选，用于辅助判定）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topic: { type: 'string', required: true },
          framework: { type: 'string', required: true },
          primaryField: { type: 'string', required: true },
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                bk: { type: 'string', required: true },
                field: { type: 'string', required: true },
                stance: { type: 'string', required: true },
                initials: { type: 'string', required: true },
                tags: { type: 'array', items: { type: 'string' }, required: true },
                deceased: { type: 'boolean' },
              },
            },
          },
          constraints: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderRoute(value as unknown as ZhijianRouteResult),
      }],
    },
    async execute(args, exec) {
      void requireCaptain(exec)
      const result = routeRequest(args.topic, args.question)
      return {
        topic: result.topic,
        framework: result.framework,
        primaryField: result.primaryField,
        candidates: result.candidates.map(candidate => ({
          id: candidate.id,
          bk: candidate.bk,
          field: candidate.field,
          stance: candidate.stance,
          initials: candidate.initials,
          tags: [...candidate.tags],
          ...(candidate.deceased === true ? { deceased: true } : {}),
        })),
        ...(result.constraints !== undefined ? { constraints: result.constraints } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_review_apply',
    description: '智见点评组队：按用户拍板选定的专家（expert_review_route 输出的 bk-* id）组建点评团队——创建团队（记录场景）、添加专家成员（Profile 已烘焙进 persona）、按输出框架生成任务 DAG（每位专家独立研判 → 融合合成 → 校对渲染）。框架 E 不适用（直接回答，不要调用本工具）。',
    parameters: {
      topic_type: { type: 'string', required: true, description: '话题类型（同 expert_review_route 的 topic）。' },
      framework: {
        type: 'string',
        enum: ['A', 'B', 'C', 'D'],
        required: true,
        description: '输出框架（来自 expert_review_route 的 framework；E 除外）。',
      },
      selected_experts: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '用户拍板选定的专家 id 列表（bk-xxx），1-5 位。',
      },
      data: { type: 'string', required: true, description: '数据本体（指标/数值/口径/城市/时段；口径缺失必须先问用户，不得省略）。' },
      data_source: { type: 'string', description: '数据来源（统计局/克而瑞/贝壳/中指/自算）。' },
      city: { type: 'string', description: '数据覆盖城市/区域。' },
      period: { type: 'string', description: '数据时段。' },
      output_form: {
        type: 'string',
        enum: ['discussion', 'final'],
        description: '输出形态：discussion=讨论稿（默认，带匿名标注），final=正式稿（去标注，仅留数据来源）。',
      },
      team_name: { type: 'string', description: '团队名（默认"智见点评·<话题>"）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
          team_name: { type: 'string', required: true },
          framework: { type: 'string', required: true },
          members: {
            type: 'array',
            items: { type: 'string' },
            required: true,
          },
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
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `智见点评团队已组建：${value.team_name}（${value.team_id}），框架 ${value.framework}。\n成员：${value.members.join('、')}\n任务：${value.tasks.map(t => `${t.task_id}${t.assignee ? `(${t.assignee})` : ''} ${t.subject}`).join('；')}${value.note !== undefined ? `\n注意：${value.note}` : ''}`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const signal = exec.signal
      const frameworkId = args.framework as ZhijianFrameworkId
      const framework = frameworkById(frameworkId)
      if (framework === undefined) {
        throw new Error(`未知框架 "${args.framework}" — 可选 A/B/C/D（E 不建队）`)
      }

      // 1. Validate the selected experts.
      const selected = [...new Set(args.selected_experts)]
      if (selected.length === 0) throw new Error('selected_experts 不能为空')
      if (selected.length > 5) throw new Error('一次点评最多 5 位专家')
      const metas = selected.map(id => ZHIJIAN_EXPERTS.find(meta => meta.id === id))
      if (metas.some(meta => meta === undefined)) {
        throw new Error(`存在未知专家 id：${selected.filter(id => !ZHIJIAN_EXPERTS.some(meta => meta.id === id)).join(', ')}`)
      }

      // 2. Route context for the team scenario id.
      const scenario = scenarioForTopic(args.topic_type, frameworkId)
      const dataContext = [
        `数据本体：${args.data}`,
        ...(args.data_source !== undefined ? [`数据来源：${args.data_source}`] : []),
        ...(args.city !== undefined ? [`城市/区域：${args.city}`] : []),
        ...(args.period !== undefined ? [`数据时段：${args.period}`] : []),
      ].join('\n')
      const outputForm = args.output_form === 'final' ? '正式稿' : '讨论稿'
      const teamName = args.team_name?.trim() || `智见点评·${args.topic_type.slice(0, 20)}`

      // 3. Compile the framework TeamTemplate (zhijian.team.<framework>) with
      // the runtime-shape params. The compiler's user-sign-off flow
      // (params.selectedExpertIds → the unique `user-signoff` reviewer slot)
      // drives the roster; framework steps/constraints and the data context
      // are folded into params and interpolated into the task copy by the
      // apply bridge, so the DAG is declarative while the strings match the
      // previous imperative assembler exactly.
      const steps = framework.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')
      const constraints = framework.constraints.map((rule, index) => `${index + 1}. ${rule}`).join('\n')
      const wordLimitLine = framework.wordLimit === undefined ? '' : `\n字数约束：${framework.wordLimit}`
      const wordLimitParen = framework.wordLimit === undefined ? '' : `（${framework.wordLimit}）`
      const fusionExtraRules = GLOBAL_OUTPUT_RULES
        .filter(rule => rule.includes('数字') || rule.includes('文风'))
        .map(rule => `5. ${rule}`)
        .join('\n')
      const compiled = compileExecutionPlan({
        pack: buildZhijianDomainPack(),
        templateId: `zhijian.team.${frameworkId}`,
        ...(scenario === undefined ? {} : { scenarioId: scenario.id }),
        params: {
          selectedExpertIds: selected,
          data: args.data,
          outputForm: args.output_form ?? 'discussion',
          dataContext,
          frameworkName: framework.name,
          frameworkSteps: steps,
          frameworkConstraints: constraints,
          wordLimitLine,
          frameworkWordLimitParen: wordLimitParen,
          outputFormText: outputForm,
          fusionExtraRules,
        },
      })
      if (!compiled.ok) throw compileErrorOf(compiled)

      // 4. Apply through the common plan adapter: create → members → tasks →
      //    kick, with the whole assembly inside one try block so any failure
      //    rolls the half-built team back (the imperative assembler had no
      //    rollback and could wedge the captain's slot).
      const expertDisplay = new Map<string, { name: string; field: string; initials: string }>()
      for (const meta of metas) {
        expertDisplay.set(meta!.id, { name: meta!.name, field: meta!.field, initials: meta!.initials })
      }
      const applied = await applyExecutionPlan(ctx, config, captain, compiled.plan, {
        teamName,
        description: [
          `智见点评任务：${args.topic_type}（框架 ${framework.name}）`,
          `输出形态：${outputForm}`,
          dataContext,
          `基调融合：先定主基调 keynote（据数据事实判定；用户指定基调则严格跟随），偏离观点降级为边界条件/风险提示。`,
        ].join('\n\n'),
        expertDisplay,
      }, signal, core)

      // Direct the first expert to start (parallelism seed, best effort).
      if (applied.members.length > 0) {
        steerCaptainReport(captain, 'expert-library', `点评团队已组建，请通过 expert_teams_status 跟踪进度；等待专家完成后整理融合稿呈现给用户。`)
      }

      return {
        team_id: applied.team_id,
        team_name: applied.team_name,
        framework: framework.id,
        members: applied.members.map(member => member.member_name),
        tasks: applied.tasks,
        ...(scenario === undefined
          ? { note: `未匹配到标准场景（候选由路由规则 §一 直接判定），任务 DAG 按框架 ${framework.id} 生成。` }
          : {}),
      }
    },
  }))
}

/** Render the route result as compact text for the captain. */
function renderRoute(result: ZhijianRouteResult): string {
  const lines = [
    `话题：${result.topic}`,
    `框架：${result.framework}（${frameworkById(result.framework)?.name ?? ''}）`,
    `主责领域：${result.primaryField}`,
    `候选专家（${result.candidates.length} 位，供用户拍板，展示请匿名）：`,
    ...result.candidates.map(candidate =>
      `  - ${candidate.bk} · ${candidate.field} · ${candidate.initials}（${candidate.stance}${candidate.deceased === true ? '，已故仅引历史观点' : ''}）tags=${candidate.tags.join('/')}`),
    ...(result.constraints !== undefined ? [`约束：${result.constraints}`] : []),
    `\n立场对照（同题对比选法）：`,
    ...STANCE_TABLE.map(pair => `  - ${pair.topic}：乐观/底部 ${pair.optimistic.join('、')} vs 风险 ${pair.risk.join('、')}${pair.unique !== undefined ? `；独特视角 ${pair.unique.join('、')}` : ''}`),
    `\n执行约束：${ROUTING_CONSTRAINTS.join('；')}`,
  ]
  return lines.join('\n')
}
