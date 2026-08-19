/**
 * Expert Library for DeepSeek Harness — an Expert Teams-based expert system.
 *
 * A host-plane plugin that registers the `expert_teams_*` tools and one usage
 * section into the global system prompt. Forked from the dsh-agent-teams
 * plugin and independently iterated (all registration surfaces renamed to
 * `expert_teams_*` / `expert-teams/*` / `/plugins/dsh-expert-library/*`, so it
 * no longer depends on or conflicts with the original plugin). Built on the
 * same mechanism (captain + durable continuable members + dependency tasks +
 * mailbox messaging + shared scheduler), extended with:
 * - a preset expert registry: each expert has its own persona, its preset
 *   "expert AI model" route (provider/model/reasoning effort), and a
 *   knowledge pack folder;
 * - preset task scenarios: `expert_teams_scenario_apply` assembles the
 *   experts and seeds the task DAG for a scenario in one call;
 * - knowledge packs: files dropped into
 *   `<workspace>/<knowledgeDir>/{experts,scenarios,shared}/` are picked up
 *   lazily and pointed to by member personas (no rebuild/restart needed).
 *
 * Installation (bundle): `dsh plugin --profile <name> add <this package>`
 * (or a local path). The bundle patch mounts this plugin row into the host
 * composition; the tools register into the shared `tools` registry and the
 * usage section into the global system prompt, so the plugin needs no realm.
 *
 * @module dsh-expert-library
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Declaration merge only: makes ctx.llm, ctx.subagents and ctx.systemPrompt visible.
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { registerExpertTeamsTools, type ToolsConfig } from './tools.ts'
import { registerZhijianTools } from './zhijian/tools.ts'
import { registerCollabTools } from './collab/tools.ts'
import { BUILTIN_EXPERT_BY_ID } from './expert-library/builtin-experts.ts'
import { BUILTIN_SCENARIO_BY_ID } from './expert-library/builtin-scenarios.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectArchivedTeamsActivity, collectTeamsActivity } from './snapshot.ts'

/**
 * Structural slice of the web server service, compatible with both the
 * published `dsh-host-webserver@0.0.1-rc.1` (`ctx.httpServer` /
 * `HttpServerService`) and the renamed `webServer` / `WebServer` in later
 * builds: the beta transition renames the service without changing the route
 * registration shape.
 */
interface WebRouteHost {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const
/** Workspace registry service key candidates, newest first. */
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'] as const

export const name = 'expert-library'
export const inject = ['tools', 'llm', 'subagents', 'systemPrompt', 'agents']

/** Plugin configuration. */
export interface Config {
  /**
   * State directory name under the captain's workspace; team state lives at
   * `<workspace>/<stateDir>/<teamId>/` (default `.expert-teams`).
   */
  stateDir?: string
  /** `ctx.subagents` provider used to spawn members; must support continuable children and personas (default `spawn`). */
  memberProvider?: string
  /** Optional default AI model route applied to every member without a preset expert route. */
  memberModel?: { provider: string; model: string; reasoningEffort?: string }
  /** Member delegation depth cap (default `1`; `0` forbids delegation entirely). */
  memberMaxDepth?: number
  /** Team size cap in members (default `8`). */
  maxMembers?: number
  /** Knowledge pack directory name under the captain's workspace (default `knowledge`). */
  knowledgeDir?: string
  /** Prompt-section order for the usage policy (default `117`, after delegation policy). */
  promptSectionOrder?: number
}

const memberModelSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
})

export const Config: z<Config> = z.object({
  stateDir: z.string().default('.expert-teams'),
  memberProvider: z.string().default('spawn'),
  memberModel: memberModelSchema,
  memberMaxDepth: z.natural().default(1),
  maxMembers: z.natural().min(1).default(8),
  knowledgeDir: z.string().default('knowledge'),
  promptSectionOrder: z.natural().default(117),
})

/** The model-facing usage policy: when and how to drive the Expert Library. */
function usageSectionText(toolNames: string): string {
  const expertIds = [...BUILTIN_EXPERT_BY_ID.keys()].join(', ')
  const scenarioIds = [...BUILTIN_SCENARIO_BY_ID.keys()].join(', ')
  return `When the user asks to run something with the Expert Library (e.g. "用专家库审查最近的提交" / "use Expert Teams to research X"), you are the captain of a multi-agent team. Follow this protocol:
1. Prefer expert_teams_scenario_apply when the goal matches a preset scenario (${scenarioIds}): it creates the team, adds the preset experts with their preset AI model routes, and seeds the task DAG in one call. Pass the concrete target in \`goal\`.
2. Otherwise call expert_teams_create with a team name and the goal as description. You become the captain and may lead one team at a time.
3. Call expert_teams_add_member once per role the goal needs. Prefer \`expert=<id>\` from the Expert Library (${expertIds}): each expert brings its own persona, preset AI model route (provider/model/reasoning effort), and knowledge pack guide; do not ask the user to choose models per member. Explicit provider/model/reasoning_effort are only for routes the user explicitly requested. Members are durable subagents: they wait for your messages, then work a full turn.
4. Break the goal into tasks with expert_teams_create_task and wire dependencies. Assign role-specific work when useful; unassigned ready work belongs to the shared pool. The scheduler automatically claims one ready task for each truly idle member and wakes it, including across later rounds.
5. Lead by delegation: monitor with expert_teams_status, send guidance with expert_teams_send_message, and let idle teammates execute ready work. Do not duplicate a teammate's work merely because its turn is slow.
6. If work is blocked, stale, or needs takeover, always call expert_teams_reassign_task first. Reassign to another idle member, or use assignee=captain before doing it yourself. Reassignment revokes the old attempt and waits for that member to quiesce, preventing late results from overwriting the new attempt.
7. Tasks carry attempt_id capabilities. Members must use the current attempt_id for updates; stale-attempt errors mean ownership changed. Poll status until every required task is terminal and every member is idle/ready.
8. Present the team's results to the user, then expert_teams_delete the team unless the user wants to keep working with it.

Zhijian (智见点评) review flow — when the user asks 请专家点评 / 让专家看看数据 (real-estate market data):
1. Call expert_review_route with the question/topic: it returns the output framework (A 五维 / B 四段 / C 用户视角五层 / D 多分类融合 / E 顾问式), the primary field, and 3-5 candidate experts (anonymized BK·领域·首字母).
2. Present the candidates to the USER for sign-off — never auto-select. For 同题对比 prefer one 乐观/底部派 + one 风险揭示派 from the stance table.
3. If the data 口径 (source/city/period) is missing, ask the user first — never generate a review without it.
4. Call expert_review_apply with the user's selected experts, framework and data: it builds the team (Profile-baked personas) and the framework task DAG (parallel expert reviews → fusion under the keynote → anonymized render).
5. Framework E (free question/FAQ/购房决策) does NOT build a team: answer directly as a neutral market observer in one voice (结论先行 + 多维框架 + 破除误区 + 量化阈值 + 可操作落点 + 口径校准), numbers must be verified, ≤2000 字 default.
6. 匿名化对外只列「领域·首字母」; 已故专家（顾云昌 bk-022）只可引用历史观点; 编数字比不回答更严重.

Collaboration modes — for 交叉辩论 / 圆桌研讨 / PPT 生成 / 研报生成:
1. expert_teams_debate: two opposing experts debate (立论→反驳→回应), a moderator judges; pass pro_expert/con_expert with opposing stances (立场对照表可参考), moderator defaults to team-lead.
2. expert_teams_roundtable: 2-5 experts speak in parallel, a note taker folds the minutes (共识/分歧/开放问题/观察指标).
3. expert_teams_ppt: architecture first (docs-coordinator), content experts supply data, then per-page copy + speaker notes as a markdown pack.
4. expert_teams_report: material review first, parallel expert analysis, then a full report (标题/摘要/正文/结论/风险/附录, markdown) written by docs-coordinator.
These tools assemble the team from the caller's expert selection and seed the mode DAG; the same patterns also exist as preset scenarios (cross-debate/roundtable/ppt-gen/research-report) for expert_teams_scenario_apply.

Knowledge packs: files under the workspace <knowledgeDir>/{experts,scenarios,shared}/ are read by members directly (pointed to by their personas); never edit team.json or inbox files directly — use the expert_teams_* tools.

Tools: ${toolNames}`
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ToolsConfig = {
    stateDir: config.stateDir ?? '.expert-teams',
    memberProvider: config.memberProvider ?? 'spawn',
    memberModel: config.memberModel,
    memberMaxDepth: config.memberMaxDepth ?? 1,
    maxMembers: config.maxMembers ?? 8,
    knowledgeDir: config.knowledgeDir ?? 'knowledge',
  }

  // Provider registration is a sibling plugin's effect (`subagent-spawn` /
  // `subagent-fork` rows), which can land after this mount under the Loader's
  // concurrent activation — so capability validation happens at the first
  // member spawn (`spawnMember`), the earliest point the provider list is
  // settled, rather than here.

  const toolNames = [
    'expert_teams_create',
    'expert_teams_scenario_apply',
    'expert_teams_add_member',
    'expert_teams_remove_member',
    'expert_teams_create_task',
    'expert_teams_reassign_task',
    'expert_teams_claim_task',
    'expert_teams_update_task',
    'expert_teams_send_message',
    'expert_teams_status',
    'expert_teams_delete',
    'expert_review_route',
    'expert_review_apply',
    'expert_teams_debate',
    'expert_teams_roundtable',
    'expert_teams_ppt',
    'expert_teams_report',
  ].join(', ')
  ctx.systemPrompt.section({
    name: 'expert-library:usage',
    order: config.promptSectionOrder ?? 117,
    text: usageSectionText(toolNames),
  })

  const core = registerExpertTeamsTools(ctx, resolved)
  registerZhijianTools(ctx, resolved, core)
  registerCollabTools(ctx, resolved, core)

  // The activity panel data/artwork routes need the Web server and the
  // workspace registry, which headless profiles do not mount; under
  // concurrent activation they may also bind after this plugin. Register the
  // routes lazily: try now, then on each service binding event. In a webless
  // profile the plugin stays tool-only and never blocks boot.
  let webRegistered = false
  const registerWebSurface = (): void => {
    if (webRegistered) return
    const webServer = (ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1])) as WebRouteHost | undefined
    const workspaceRegistry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1])) as WorkspaceRegistry | undefined
    if (webServer === undefined || workspaceRegistry === undefined) return
    webRegistered = true

    // Activity panel data route: the browser floater polls this for team
    // snapshots (disk truth + live subagent activity). Mirrors the Claude
    // Code desktop watcher's server-side snapshot pattern.
    ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-expert-library/state',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const roots = workspaceRegistry.list().map((workspace) => ({
        workspace: workspace.title,
        stateRoot: join(workspace.path, resolved.stateDir),
      }))
      // ?archived=1 serves teams moved to archive/ (post-delete review).
      const snapshots = url.searchParams.get('archived') === '1'
        ? await collectArchivedTeamsActivity(ctx, roots)
        : await collectTeamsActivity(ctx, roots)
      const body = JSON.stringify({ teams: snapshots })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(body)
    },
  }), 'expert-teams: activity route')

  // Whale mascot artwork: serve the packaged role/action images to the
  // activity panel. An explicit allowlist guards the route (no path
  // traversal); the images ship with the bundle (files: assets/).
  const artDir = fileURLToPath(new URL('../assets/expert-teams/', import.meta.url))
  const ART_ALLOWLIST = new Set([
    'team-lead.png', 'researcher.png', 'engineer.png', 'designer.png',
    'qa-engineer.png', 'security-reviewer.png', 'data-analyst.png',
    'docs-coordinator.png', 'action-working.png', 'action-thinking.png',
    'action-reporting.png', 'action-celebrating.png', 'action-sleeping.png',
    'action-sending.png',
  ])
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/plugins/dsh-expert-library/assets',
    handler: async (req, res) => {
      let name: string
      try {
        name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '')
      } catch {
        // Malformed percent-encoding: treat as an unknown asset, not a 400.
        res.writeHead(404)
        res.end()
        return
      }
      if (!ART_ALLOWLIST.has(name)) {
        res.writeHead(404)
        res.end()
        return
      }
      try {
        const data = await readFile(join(artDir, name))
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=86400',
        })
        res.end(data)
      } catch (error: unknown) {
        ctx.logger.warn(`expert-teams: artwork read failed for ${name}: ${String(error)}`)
        res.writeHead(404)
        res.end()
      }
      },
    }), 'expert-teams: artwork route')
  }

  registerWebSurface()
  ctx.on('internal/service', (name) => {
    if (WEB_SERVER_KEYS.includes(name as (typeof WEB_SERVER_KEYS)[number])
      || WORKSPACE_KEYS.includes(name as (typeof WORKSPACE_KEYS)[number])) {
      registerWebSurface()
    }
  })
}
