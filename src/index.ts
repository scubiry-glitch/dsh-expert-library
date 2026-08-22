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
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectArchivedTeamsActivity, collectTeamsActivity } from './snapshot.ts'
import { readTeam } from './state.ts'
import type { TeamState } from './types.ts'
import {
  installExpertLibrarySettings,
  type ExpertLibrarySettings,
  type ToolExecutionConfig,
} from './settings.ts'
import {
  ProviderTransportService,
  resolveProviderServiceOptions,
  windCliPathCandidate,
  type ProviderConfigInput,
  type ProviderServiceOptions,
} from './host/provider-service.ts'
import { HealthProbeCache, createHealthHandler, type PackDirLike } from './host/health.ts'
import {
  AuditLogFile,
  createAuditHandler,
  resolveAuditLogPath,
} from './host/audit-log.ts'
import { invalidateBuiltinLegacyPack } from './v2/compat.ts'
import {
  providerCallToolEligible,
  registerProviderCallTool,
} from './host/provider-tool.ts'
import { discoverPackDirs, discoverPackDirsIn, listDomainPacks, previewDomainPack } from './v2/preview.ts'

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
/** Session store service key candidates, newest first. */
const SESSION_KEYS = ['sessions'] as const

export const name = 'expert-library'
export const inject = ['tools', 'llm', 'subagents', 'systemPrompt', 'agents']

/**
 * Resolve every candidate team state root: registered workspaces plus every
 * live session's cwd. Team state lives under the captain's session cwd, which
 * the workspace registry does not always know (e.g. a session running in the
 * root home dir), so both sources are unioned. The display name prefers the
 * registered workspace title.
 */
function discoverStateRoots(ctx: Context, runtimeConfig: ToolsConfig): { workspace: string; stateRoot: string }[] {
  const sessions = ctx.get(SESSION_KEYS[0]) as
    | { list(): Array<{ header: { cwd?: string } }> }
    | undefined
  const workspaceRegistry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1])) as WorkspaceRegistry | undefined
  const rootByState = new Map<string, string>()
  for (const workspace of workspaceRegistry?.list() ?? []) {
    rootByState.set(join(workspace.path, runtimeConfig.stateDir), workspace.title || basename(workspace.path) || workspace.path)
  }
  for (const session of sessions?.list() ?? []) {
    const cwd = session.header.cwd
    if (cwd === undefined) continue
    const stateRoot = join(cwd, runtimeConfig.stateDir)
    if (!rootByState.has(stateRoot)) rootByState.set(stateRoot, basename(cwd) || cwd)
  }
  return [...rootByState].map(([stateRoot, title]) => ({
    workspace: title,
    stateRoot,
  }))
}

/**
 * Structural slice of the host sessions service: `get(id)` plus `list()` rows
 * carrying the session's `header.cwd`. Duck-typed because the host service
 * interface is not a peer dependency of this plugin.
 */
interface SessionsSlice {
  get?(id: string): { header: { cwd?: string } } | undefined
  list(): Array<{ id?: string; sessionId?: string; header: { cwd?: string } }>
}

/** Resolve one session's workspace cwd, when the session is known to the host. */
function sessionCwdOf(ctx: Context, sessionId: string): string | undefined {
  const sessions = ctx.get(SESSION_KEYS[0]) as SessionsSlice | undefined
  const direct = sessions?.get?.(sessionId)
  if (direct !== undefined) return direct.header.cwd
  for (const session of sessions?.list() ?? []) {
    if ((session.id ?? session.sessionId) === sessionId) return session.header.cwd
  }
  return undefined
}

/** Cap for the conversation-files listing (the tab is a monitor, not a browser). */
const SESSION_FILES_CAP = 200

/** One input-file row of the conversation files route. */
export interface SessionInputFile {
  readonly name: string
  /** Path relative to the session cwd (what the client sends back). */
  readonly relPath: string
  readonly sizeBytes: number
  readonly updatedAt: number
}

/** Recursively list files under `root`, recording cwd-relative paths. */
async function collectSessionFiles(
  cwd: string,
  dir: string,
  out: SessionInputFile[],
): Promise<void> {
  if (out.length >= SESSION_FILES_CAP) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= SESSION_FILES_CAP) return
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectSessionFiles(cwd, absolute, out)
      continue
    }
    if (!entry.isFile()) continue
    try {
      const info = await stat(absolute)
      out.push({
        name: entry.name,
        relPath: absolute.slice(cwd.length + 1),
        sizeBytes: info.size,
        updatedAt: info.mtimeMs,
      })
    } catch {
      // vanished mid-scan; skip
    }
  }
}

/** Plugin configuration. */
export interface Config {
  /**
   * State directory name under the captain's workspace; team state lives at
   * `<workspace>/<stateDir>/<teamId>/` (default `expert-teams`, visible:
   * 任务单目录运行——input/output/artifacts 与交付物同处一个可见目录).
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
  /** Domain pack directory name under each workspace root (default `domain-packs`). */
  packsDir?: string
  /** Prompt-section order for the usage policy (default `117`, after delegation policy). */
  promptSectionOrder?: number
  /** Whether the usage policy section is announced to agents (default `true`). */
  announceToAgent?: boolean
  /** Library-wide default model route for members without a preset route (alias of `memberModel`). */
  defaultModel?: { provider: string; model: string; reasoningEffort?: string }
  /** Per-tool execution policy (API vs CLI vs auto) for external capabilities. */
  toolExecution?: Record<string, ToolExecutionConfig>
  /** Provider path/endpoint configuration (wind/zyt/beike); env/probe defaults apply when absent. */
  providers?: {
    /** Wind skill CLI path (`scripts/cli.mjs`); default probes `~/.agents/skills/wind-mcp-skill/scripts/cli.mjs` / `WIND_SKILL_CLI`. */
    wind?: { cliPath?: string }
    /** zyt API base URL + optional CLI binary; defaults `https://dss.ke.com` / `ZYT_BASE_URL` / `ZYT_CLI`. */
    zyt?: { baseUrl?: string; cliCommand?: string; preferCli?: boolean }
    /** beike MCP endpoint + optional CLI binary; defaults `https://building.ke.com/mcp` / `BEIKE_MCP_BASE_URL` / `BEIKE_CLI`. */
    beike?: { baseUrl?: string; cliCommand?: string; preferCli?: boolean }
  }
}

const memberModelSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
})

const toolExecutionEntrySchema = z.object({
  mode: z.string(),
  api: z.object({
    baseUrl: z.string(),
    timeoutMs: z.natural(),
    maxRetries: z.natural(),
  }),
  cli: z.object({
    command: z.string(),
    workingDirectory: z.string(),
    timeoutMs: z.natural(),
  }),
  readOnly: z.boolean(),
  preferredRoles: z.array(z.string()),
})

const providerWindSchema = z.object({
  cliPath: z.string(),
})

const providerZytSchema = z.object({
  baseUrl: z.string(),
  cliCommand: z.string(),
  preferCli: z.boolean(),
})

const providerBeikeSchema = z.object({
  baseUrl: z.string(),
  cliCommand: z.string(),
  preferCli: z.boolean(),
})

export const Config: z<Config> = z.object({
  stateDir: z.string().default('expert-teams'),
  memberProvider: z.string().default('spawn'),
  memberModel: memberModelSchema,
  memberMaxDepth: z.natural().default(1),
  maxMembers: z.natural().min(1).default(8),
  knowledgeDir: z.string().default('knowledge'),
  packsDir: z.string().default('domain-packs'),
  promptSectionOrder: z.natural().default(117),
  announceToAgent: z.boolean().default(true),
  defaultModel: memberModelSchema,
  toolExecution: z.dict(toolExecutionEntrySchema),
  providers: z.object({
    wind: providerWindSchema,
    zyt: providerZytSchema,
    beike: providerBeikeSchema,
  }),
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
  // Runtime knobs consumed by the tools. The object is mutated in place when
  // the settings source changes, so tools registered once always read the
  // latest authoritative values (entry config or the settings scope).
  const runtimeConfig: ToolsConfig = {
    stateDir: config.stateDir ?? 'expert-teams',
    memberProvider: config.memberProvider ?? 'spawn',
    memberModel: config.defaultModel ?? config.memberModel,
    memberMaxDepth: config.memberMaxDepth ?? 1,
    maxMembers: config.maxMembers ?? 8,
    knowledgeDir: config.knowledgeDir ?? 'knowledge',
    packsDir: config.packsDir ?? 'domain-packs',
    toolExecution: config.toolExecution,
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

  const core = registerExpertTeamsTools(ctx, runtimeConfig)
  registerZhijianTools(ctx, runtimeConfig, core)
  registerCollabTools(ctx, runtimeConfig, core)

  // Provider-call audit persistence: one JSONL file shared across restarts
  // (the in-memory registry audit is the live source; the file is the
  // cross-restart memory). Path resolution: the DSH data dir when DSH_HOME is
  // set, else `<cwd>/.expert-teams/provider-audit.jsonl` — see audit-log.ts
  // for the documented decision. Writes are async, non-blocking, and
  // best-effort; a failing audit log never breaks a provider call.
  const auditLog = new AuditLogFile(resolveAuditLogPath())

  // Provider transport runtime (Phase 2): registers the wind/zyt/beike
  // manifests and attaches invokers. Registered once under the
  // `providerTransport` service; rebuilt when the effective settings change
  // (the settings namespace may edit toolExecution overlays at runtime). The
  // service is optional for the rest of the plugin — a webless/headless
  // profile simply never resolves provider capabilities.
  let providerService: ProviderTransportService | undefined
  const syncProviders = (): void => {
    const value = current()
    const options: ProviderServiceOptions = {
      ...resolveProviderServiceOptions(value as ProviderConfigInput),
      auditLog,
    }
    if (providerService === undefined) {
      providerService = new ProviderTransportService(ctx, options)
      ctx.effect(() => ctx.provide('providerTransport', providerService), 'expert-library: provider transport service')
    } else {
      try {
        providerService.reconfigure(options)
      } catch (error: unknown) {
        ctx.logger.warn(`expert-library: provider reconfigure failed: ${String(error)}`)
      }
    }
    syncProviderTool()
  }

  // The member-level `expert_provider_call` tool is registered only once the
  // provider service is available with at least one registered provider —
  // webless/headless profiles skip it silently (the tool body also fails
  // closed at execute time if the service ever loses all providers).
  let providerToolRegistered = false
  const syncProviderTool = (): void => {
    if (providerToolRegistered || !providerCallToolEligible(providerService)) return
    registerProviderCallTool(ctx)
    providerToolRegistered = true
  }

  // The usage policy section is injected while the plugin is announced to
  // agents; turning the announcement off (settings or entry config) removes it
  // so non-expert sessions are not polluted.
  let disposeSection: (() => void) | undefined
  const syncAnnounce = (): void => {
    const value = current()
    const announce = value.announceToAgent ?? true
    if (announce && disposeSection === undefined) {
      disposeSection = ctx.systemPrompt.section({
        name: 'expert-library:usage',
        order: value.promptSectionOrder ?? 117,
        text: usageSectionText(toolNames),
      })
    } else if (!announce && disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
  }

  let current: () => Config = () => config
  const applySource = (source: () => Config): void => {
    current = source
    const value = current()
    runtimeConfig.stateDir = value.stateDir ?? 'expert-teams'
    runtimeConfig.memberProvider = value.memberProvider ?? 'spawn'
    runtimeConfig.memberModel = value.defaultModel ?? value.memberModel
    runtimeConfig.memberMaxDepth = value.memberMaxDepth ?? 1
    runtimeConfig.maxMembers = value.maxMembers ?? 8
    runtimeConfig.knowledgeDir = value.knowledgeDir ?? 'knowledge'
    runtimeConfig.packsDir = value.packsDir ?? 'domain-packs'
    runtimeConfig.toolExecution = value.toolExecution
    // Pack edits via settings take effect without a restart: drop the builtin
    // pack cache on every settings commit — the next compile rebuilds it
    // lazily (mtime staleness also catches external pack regeneration; see
    // src/v2/compat.ts builtinLegacyPack).
    invalidateBuiltinLegacyPack()
    syncAnnounce()
    syncProviders()
  }

  // Optional settings wiring: while a settings service exists, the
  // `expert-library` namespace overrides the entry config; otherwise the entry
  // is the only source and everything behaves exactly as composed. Every
  // commit re-runs the full apply: runtimeConfig fields refresh in place and
  // the provider registry is rebuilt (reconfigure disposes the old invokers
  // by replacing the registry wholesale), so endpoint/path edits take effect
  // without a restart.
  installExpertLibrarySettings(ctx, config ?? {}, {
    setSource: (source) => applySource(source as () => Config),
    onChange: () => applySource(current),
  })
  applySource(() => config)

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
      const roots = discoverStateRoots(ctx, runtimeConfig)
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

  // Task-project document route: serves output/artifact files from a team's
  // isolated task project so the activity panel's document list can open each
  // expert deliverable. Access is scoped to the plugin's own projects: the
  // team id must resolve to a real team, the task must exist in that team's
  // durable record, and the file must be a single segment inside the fixed
  // `output`/`artifacts` directory of the task project — no traversal, no
  // internal manifests, no workspace files outside the team.
  const PROJECT_CONTENT_TYPES: Record<string, string> = {
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.markdown': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.text': 'text/plain; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.yaml': 'text/yaml; charset=utf-8',
    '.yml': 'text/yaml; charset=utf-8',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
  }
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-expert-library/project',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const teamId = url.searchParams.get('team') ?? ''
        const taskId = url.searchParams.get('task') ?? ''
        const dir = url.searchParams.get('dir') ?? ''
        const file = url.searchParams.get('file') ?? ''
        // Strict single-segment checks: team ids may keep unicode letters and
        // digits (sanitizeKey) but never path separators; files must be one
        // plain segment inside a fixed directory.
        const teamIdOk = /^[\p{L}\p{N}][\p{L}\p{N}-]{0,119}$/u.test(teamId)
        const fileOk = file !== '' && file !== '.' && file !== '..' && file.length <= 200
          && !file.includes('/') && !file.includes('\\')
        const dirOk = dir === 'output' || dir === 'artifacts'
        if (!teamIdOk || taskId === '' || !dirOk || !fileOk) {
          res.writeHead(400)
          res.end()
          return
        }
        // Internal bookkeeping files are not expert documents.
        if (dir === 'artifacts' && (file === 'manifest.json' || file === 'project.json')) {
          res.writeHead(404)
          res.end()
          return
        }
        // Locate the team across every candidate state root (ids are unique
        // per workspace, so the first hit wins) and resolve the task project.
        let dirPath: string | undefined
        for (const { stateRoot } of discoverStateRoots(ctx, runtimeConfig)) {
          let state: TeamState | undefined
          try {
            state = await readTeam(stateRoot, teamId)
          } catch {
            state = undefined
          }
          if (state === undefined) continue
          const task = state.tasks.find((candidate) => candidate.id === taskId)
          if (task === undefined || task.project === undefined) continue
          dirPath = join(stateRoot, state.id, task.project.path, dir)
          break
        }
        if (dirPath === undefined) {
          res.writeHead(404)
          res.end()
          return
        }
        const absolute = join(dirPath, file)
        if (!absolute.startsWith(dirPath + sep)) {
          res.writeHead(400)
          res.end()
          return
        }
        try {
          const data = await readFile(absolute)
          const extension = absolute.slice(absolute.lastIndexOf('.'))
          res.writeHead(200, {
            'content-type': PROJECT_CONTENT_TYPES[extension] ?? 'application/octet-stream',
            'cache-control': 'no-store',
          })
          res.end(data)
        } catch {
          res.writeHead(404)
          res.end()
        }
      },
    }), 'expert-teams: project route')

  // Conversation files: the 文件 tab. `session-files` lists the documents the
  // user uploaded into this conversation (dsh-files stores them under
  // `<sessionCwd>/.dsh-filess/<sessionId>/`); `workspace-file` serves one file
  // inside the session cwd raw so the tab can preview text/markdown/images/
  // PDFs inline. Office documents (xlsx/docx/pptx/univer) are previewed by the
  // univer plugin's own /univer-api/state viewer instead.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-expert-library/session-files',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const files: SessionInputFile[] = []
      if (sessionId !== '') {
        const cwd = sessionCwdOf(ctx, sessionId)
        if (cwd !== undefined) {
          await collectSessionFiles(cwd, join(cwd, '.dsh-filess', sessionId), files)
        }
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify({ files }))
    },
  }), 'expert-teams: session files route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-expert-library/workspace-file',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const rawPath = url.searchParams.get('path') ?? ''
      if (sessionId === '' || rawPath === '') {
        res.writeHead(400)
        res.end()
        return
      }
      const cwd = sessionCwdOf(ctx, sessionId)
      if (cwd === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      // Containment: the served file must resolve strictly inside the session
      // workspace (no traversal, no absolute escapes).
      const absolute = resolvePath(cwd, rawPath)
      if (!absolute.startsWith(cwd + sep)) {
        res.writeHead(403)
        res.end()
        return
      }
      try {
        const info = await stat(absolute)
        if (!info.isFile()) {
          res.writeHead(404)
          res.end()
          return
        }
        const data = await readFile(absolute)
        const extension = absolute.slice(absolute.lastIndexOf('.'))
        res.writeHead(200, {
          'content-type': PROJECT_CONTENT_TYPES[extension] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        })
        res.end(data)
      } catch {
        res.writeHead(404)
        res.end()
      }
    },
  }), 'expert-teams: workspace file route')

  // Domain Pack read-only preview (Phase 1 §11 「设置页只读预览校验」): lists
  // the builtin pack plus workspace `domain-packs/` packs with live
  // validation health, and with `?id=<SafeId>` returns one pack's preview
  // plus full loader/validator diagnostics. GET-only, no writes; the wire
  // summaries never carry secrets or full persona/profile prose.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-expert-library/packs',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const id = url.searchParams.get('id') ?? ''
      if (id !== '') {
        // Same SafeId rule as isSafeKnowledgeId: unicode letters/digits
        // first, `._-` inside, ≤64 chars — no separators, no traversal.
        if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(id)) {
          res.writeHead(400)
          res.end()
          return
        }
        const preview = await previewDomainPack(ctx, id, runtimeConfig.packsDir)
        if (preview === undefined) {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(preview))
        return
      }
      const list = await listDomainPacks(ctx, runtimeConfig.packsDir)
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(list))
    },
  }), 'expert-teams: domain pack preview route')

  // Provider failure observability: read-only audit tail route. Merges the
  // persisted JSONL tail (cross-restart memory) with the live in-memory
  // registry audit (first-class), deduped by record identity, bounded by
  // ?limit= (default 100, max 500). Entries carry only
  // kind/providerId/version/operation/outcome/at + detail — never credentials.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-expert-library/audit',
    handler: createAuditHandler({
      auditLog,
      resolveMemory: () => providerService?.audit() ?? [],
    }),
  }), 'expert-teams: provider audit route')

  // Health observation (设置页数据源/包健康): read-only probes of the three
  // provider data sources and the generated domain packs. All I/O lives in
  // src/host/health.ts behind injectable seams; a 30s single-flight cache
  // absorbs repeated page polls. Secrets never leave the host — the wire
  // carries only keyPresent booleans and non-secret metadata.
  const healthCache = new HealthProbeCache()
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-expert-library/health',
    handler: createHealthHandler({
      cache: healthCache,
      resolve: async () => {
        const value = current()
        const options = resolveProviderServiceOptions(value as ProviderConfigInput)
        // Pack dirs: the plugin module root's packsDir (the shipped
        // domain-packs/) plus every workspace root's packsDir, deduped.
        const moduleRoot = fileURLToPath(new URL('../', import.meta.url))
        const packsDir = runtimeConfig.packsDir ?? 'domain-packs'
        const packDirs: PackDirLike[] = []
        const seen = new Set<string>()
        for (const pack of await discoverPackDirsIn(moduleRoot, packsDir)) {
          if (seen.has(pack.dir)) continue
          seen.add(pack.dir)
          packDirs.push(pack)
        }
        for (const pack of await discoverPackDirs(ctx, packsDir)) {
          if (seen.has(pack.dir)) continue
          seen.add(pack.dir)
          packDirs.push(pack)
        }
        return {
          providers: {
            wind: { cliPath: windCliPathCandidate(value as ProviderConfigInput) },
            ...(options.zyt !== undefined ? { zyt: { baseUrl: options.zyt.baseUrl } } : {}),
            ...(options.beike !== undefined ? { beike: { baseUrl: options.beike.baseUrl } } : {}),
          },
          registered: providerService?.providers ?? [],
          packDirs,
        }
      },
    }),
  }), 'expert-teams: health route')
  }

  registerWebSurface()
  ctx.on('internal/service', (name) => {
    if (WEB_SERVER_KEYS.includes(name as (typeof WEB_SERVER_KEYS)[number])
      || WORKSPACE_KEYS.includes(name as (typeof WORKSPACE_KEYS)[number])
      || SESSION_KEYS.includes(name as (typeof SESSION_KEYS)[number])) {
      registerWebSurface()
    }
  })
}
