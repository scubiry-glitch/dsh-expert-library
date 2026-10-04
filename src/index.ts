import { craftSessionContext } from './report-craft-delivery.ts'
import { scopedSkillCraftDiscovery } from './skill-craft-discovery.ts'
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
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { registerExpertTeamsTools, scenarioApproveFromHost, scenarioDiscardCore, scenarioEditCore, type ToolsConfig } from './tools.ts'
import { registerZhijianTools } from './zhijian/tools.ts'
import { registerCollabTools } from './collab/tools.ts'
import { registerTeamWaitTool } from './team-wait.ts'
import { BUILTIN_EXPERT_BY_ID } from './expert-library/builtin-experts.ts'
import { BUILTIN_SCENARIO_BY_ID } from './expert-library/builtin-scenarios.ts'
import { ZHIJIAN_EXPERT_BY_ID, ALL_EXPERT_METAS, zhijianMetaById } from './zhijian/registry.ts'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectArchivedTeamsActivity, collectTeamsActivity } from './snapshot.ts'
import { archiveTeamDir, findTeamByCaptain, haltTeam, listArchivedTeamIds, readArchivedTeam, readTeam, resumeTeam, recordRetiredMemberIds, writeTeam, withTeamLock } from './state.ts'
import type { TeamState } from './types.ts'
import { droppedSessionEvents } from './events.ts'
import { handleManage } from './host/manage.ts'
import { authorizeManageRequest, resolveManageToken } from './host/auth.ts'
import { createPackCenterHost } from './host/pack-center-host.ts'
import { createPackCenterRouteHandler } from './host/pack-center-routes.ts'
import { listStagedPlanIds, readStagedPlan, recoverStagedPlans } from './staged-plan.ts'
import { authorizePlanExecution, revokePlanExecution, readPlanExecutionAuthorization, PLAN_AUTHORIZATION_SCOPE } from './plan-authorization.ts'
import { captureSharedTaskContext } from './shared-task-context.ts'
import { captainGoalRules } from './goal-prompts.ts'
import { installProviderRequestQueue } from './provider-request-queue.ts'
import { handleTeamRoutes, type TeamRouteRequest, type TeamRouteTarget } from './host/team-routes.ts'
import { planToWire, teamToWire, type TeamWireResponse } from './team-wire.ts'
import { teamLockKey, workspaceOf, stateRootOf } from './team-core.ts'
import { interruptMember } from './members.ts'
import { waitForMemberIdle } from './team-core.ts'

/**
 * Resolve the vendored-pack root. Deliberately not under the plugin module
 * root: that directory is replaced on package upgrade, which would silently
 * drop every installed pack. Empty when no DSH home is known — the
 * pack-source surface then refuses rather than choosing somewhere to write.
 */
function resolveVendorPacksDir(configured: string | undefined): string {
  const explicit = configured?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const home = process.env['DSH_HOME']?.trim()
  return home === undefined || home === '' ? '' : join(home, 'vendor-packs')
}
import {
  effectiveMemberModel,
  installExpertLibrarySettings,
  normalizeUpdatePolicy,
  PackCenterUpdatePolicySchema,
  type ExpertLibrarySettings,
  type PackCenterUpdatePolicy,
  type ToolExecutionConfig,
} from './settings.ts'
import { createPackCenterAutoUpdate } from './host/pack-center-auto-update.ts'
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
import { registerRenderPublishTool } from './host/render-publish.ts'
import { invalidateBuiltinLegacyPack } from './v2/compat.ts'
import { invalidateRuntimePack } from './v2/runtime-pack.ts'
import {
  providerCallToolEligible,
  registerProviderCallTool,
} from './host/provider-tool.ts'
import { discoverPackDirs, discoverPackDirsIn, listDomainPacks, previewDomainPack } from './v2/preview.ts'
import { loadPackFromDir } from './v2/pack-loader.ts'
import { readRegistry } from './host/pack-registry.ts'
import { buildZhijianDomainPack } from './v2/zhijian-pack.ts'
import { resolveManagedRuntimePack } from './host/pack-runtime.ts'
import type { DomainPackV2 } from './v2/types.ts'
import {
  collectSkillEntries,
  discoverSkillRoots,
  liveSkillsInventoryLine,
  skillDiscoveryPromptSection,
} from './skills-discovery.ts'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'

// Data-only profile contract.  Exporting it from the host entry keeps profile
// catalogs usable by headless callers without importing the runtime/plugin.
export * from './profiles.ts'
export * from './quality-run.ts'
export * from './capability-scope.ts'
export * from './staged-plan.ts'

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

/** Reconcile staged plans at plugin startup, before a new tool request can
 * observe a stale running record. The scan is deliberately best effort per
 * workspace: a malformed plan must be reported without preventing the host
 * plugin from loading for other workspaces. */
async function recoverStagedPlanRoots(ctx: Context, runtimeConfig: ToolsConfig): Promise<void> {
  const roots = discoverStateRoots(ctx, runtimeConfig)
  const fallbackRoot = join(process.cwd(), runtimeConfig.stateDir)
  const allRoots = roots.some(root => root.stateRoot === fallbackRoot)
    ? roots
    : [...roots, { workspace: process.cwd(), stateRoot: fallbackRoot }]
  await Promise.all(allRoots.map(async ({ stateRoot }) => {
    try {
      await recoverStagedPlans(stateRoot)
    } catch (error: unknown) {
      ctx.logger.warn(`expert-library: staged plan recovery failed for ${stateRoot}: ${String(error)}`)
    }
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
  /** Member delegation depth cap (default `0`; `0` forbids delegation entirely). */
  memberMaxDepth?: number
  /** Maximum concurrently active team members, including independent review (default `2`). */
  maxActiveMembers?: number
  /** Host-local provider stream limits, shared by captain, members and auxiliary calls. */
  providerRequestConcurrency?: Record<string, number>
  /** Team size cap in members (default `8`). */
  maxMembers?: number
  /** Knowledge pack directory name under the captain's workspace (default `knowledge`). */
  knowledgeDir?: string
  /** Domain pack directory name under each workspace root (default `domain-packs`). */
  packsDir?: string
  /**
   * Shared token admitting non-loopback access to `/manage/*`. Prefer the
   * {@link MANAGE_TOKEN_ENV} environment variable so the secret stays out of
   * the settings file. Unset means the write surface is loopback-only.
   */
  manageToken?: string
  /**
   * Directory holding packs vendored from external sources. Defaults to
   * `<DSH_HOME>/vendor-packs`; empty (no DSH home) disables the pack-source
   * surface entirely rather than picking a directory to write into.
   */
  vendorPacksDir?: string
  /** HTTPS center origin and private storage. Changes require plugin restart. */
  packCenterOrigin?: string
  packCenterDir?: string
  /**
   * 宿主侧半自动更新策略（三档：manual/download/patch_auto），热生效、无需重启。
   * manual（默认）保持零周期网络；见 src/host/pack-center-auto-update.ts。
   */
  packCenterUpdatePolicy?: PackCenterUpdatePolicy
  /** Locator hosts whose packs install on validation success, without review. */
  packSourceAllowlist?: string[]
  /** Prompt-section order for the usage policy (default `117`, after delegation policy). */
  promptSectionOrder?: number
  /** Whether the usage policy section is announced to agents (default `true`). */
  announceToAgent?: boolean
  /** Library-wide default model route for members without a preset route (alias of `memberModel`). */
  defaultModel?: { provider: string; model: string; reasoningEffort?: string }
  /** Workspace domain pack ids enabled for runtime compile; absent/empty = every valid workspace pack. */
  enabledPacks?: string[]
  /** Workspace domain pack id order (first = highest precedence); absent = discovery order. */
  packPriority?: string[]
  /** Per-expert model route override (expert id → route); wins over the preset expert route. */
  expertModelOverrides?: Record<string, { provider: string; model: string; reasoningEffort?: string }>
  /** Per-tool execution policy (API vs CLI vs auto) for external capabilities. */
  toolExecution?: Record<string, ToolExecutionConfig>
  /** Tool ids to exclude from this preset's model-facing tool catalog (e.g. `expert_teams_claim_task`); absent/empty = register everything. Host-layer tools registered by `index.ts` (e.g. `render_publish`) are NOT affected. */
  disabledTools?: string[]
  /** Provider path/endpoint configuration (wind/zyt/beike/localdb); env/probe defaults apply when absent. */
  providers?: {
    /** Wind skill CLI path (`scripts/cli.mjs`); default probes `~/.agents/skills/wind-mcp-skill/scripts/cli.mjs` / `WIND_SKILL_CLI`. */
    wind?: { cliPath?: string }
    /** zyt API base URL + optional CLI binary; defaults `https://dss.ke.com` / `ZYT_BASE_URL` / `ZYT_CLI`. */
    zyt?: { baseUrl?: string; cliCommand?: string; preferCli?: boolean }
    /** beike MCP endpoint + optional CLI binary; defaults `https://building.ke.com/mcp` / `BEIKE_MCP_BASE_URL` / `BEIKE_CLI`. */
    beike?: { baseUrl?: string; cliCommand?: string; preferCli?: boolean }
    /** 本地 SQLite 数据库灵活注册：显式列表 + 目录扫描；无效 id / 不存在的文件一律跳过（fail-closed）。 */
    localdb?: {
      databases?: { id: string; path: string; description?: string; caliber?: string; sensitivity?: string }[]
      scanDirs?: string[]
    }
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

const providerLocalDbDatabaseSchema = z.object({
  id: z.string(),
  path: z.string(),
  description: z.string(),
  caliber: z.string(),
  sensitivity: z.string(),
})

const providerLocalDbSchema = z.object({
  databases: z.array(providerLocalDbDatabaseSchema),
  scanDirs: z.array(z.string()),
})

export const Config: z<Config> = z.object({
  stateDir: z.string().default('expert-teams'),
  memberProvider: z.string().default('spawn'),
  memberModel: memberModelSchema,
  memberMaxDepth: z.natural().default(0),
  maxActiveMembers: z.natural().min(1).default(2),
  providerRequestConcurrency: z.dict(z.natural().min(1)),
  maxMembers: z.natural().min(1).default(8),
  knowledgeDir: z.string().default('knowledge'),
  packsDir: z.string().default('domain-packs'),
  manageToken: z.string().default(''),
  vendorPacksDir: z.string().default(''),
  packCenterOrigin: z.string().default(''),
  packCenterDir: z.string().default(''),
  packCenterUpdatePolicy: PackCenterUpdatePolicySchema,
  packSourceAllowlist: z.array(z.string()).default([]),
  promptSectionOrder: z.natural().default(117),
  announceToAgent: z.boolean().default(true),
  defaultModel: memberModelSchema,
  enabledPacks: z.array(z.string()),
  packPriority: z.array(z.string()),
  expertModelOverrides: z.dict(memberModelSchema),
  toolExecution: z.dict(toolExecutionEntrySchema),
  disabledTools: z.array(z.string()),
  providers: z.object({
    wind: providerWindSchema,
    zyt: providerZytSchema,
    beike: providerBeikeSchema,
    localdb: providerLocalDbSchema,
  }),
})

/** The model-facing usage policy: when and how to drive the Expert Library. */
function usageSectionText(toolNames: string, skillInventoryLine: string): string {
  const expertIds = [...BUILTIN_EXPERT_BY_ID.keys()].join(', ')
  const scenarioIds = [...BUILTIN_SCENARIO_BY_ID.keys()].join(', ')
  return `${captainGoalRules({ scenarioIds, expertIds })}

Zhijian (智见点评) review flow — when the user asks 请专家点评 / 让专家看看数据 (real-estate market data):
0. 先归型、再路由 (mandatory for free-form requests): for a free/ambiguous request (e.g. "贝壳政研通的 BP 优化"), call expert_review_clarify FIRST — it returns candidate topic/scenario options plus the domain pack's 待确认口径 questions (用途受众 / 数据来源 / 城市 / 时段 / 敏感脱敏 / 领域侧重; required items marked). Reuse confirmed answers; ask only unresolved material questions in one round, then 归型 (pick the intent). When expert_review_route returns clarify_needed, confirm those 口径 with the user before expert_review_apply — never enter a team with unresolved 口径.
1. Call expert_review_route with the question/topic: it returns the output framework (A 五维 / B 四段 / C 用户视角五层 / D 多分类融合 / E 顾问式), the primary field, and 3-5 candidate experts (anonymized BK·领域·首字母).
2. Use the experts already selected by the user; otherwise present the candidates for sign-off. Do not ask again for an unchanged selection. For 同题对比 prefer one 乐观/底部派 + one 风险揭示派 from the stance table.
3. If the data 口径 (source/city/period) is missing, ask the user first — never generate a review without it.
4. Dataset-first data fetch: when route returns required_data and user-supplied data is insufficient, call expert_provider_call with the \`dataset\` parameter (e.g. realestate.city.market) — it maps to the version-pinned capability and validates required 口径 automatically. NEVER guess raw capability keys, NEVER reinstall skills/providers to fix a data error: unknown dataset (DATASET_UNKNOWN), missing caliber (CALIBER_MISSING), missing credentials (CREDENTIAL_MISSING) and bad input (INPUT_INVALID) each demand a targeted fix, not a reinstall. Every successful fetch must carry provenance (source/caliber/unit) and a request signature pinning city/period — a DATA_QUALITY_INVALID result must not be cited in any review.
5. Call expert_review_apply with the user's selected experts, framework and data: it builds the team (Profile-baked personas) and the framework task DAG (parallel expert reviews → fusion under the keynote → anonymized render).
6. Framework E (free question/FAQ/购房决策) does NOT build a team: answer directly as a neutral market observer in one voice (结论先行 + 多维框架 + 破除误区 + 量化阈值 + 可操作落点 + 口径校准), numbers must be verified, ≤2000 字 default.
7. 匿名化对外只列「领域·首字母」; 已故专家（慢牛主席 bk-022）只可引用历史观点; 编数字比不回答更严重.

Collaboration modes — for 交叉辩论 / 圆桌研讨 / PPT 生成 / 研报生成:
1. expert_teams_debate: two opposing experts debate (立论→反驳→回应), a moderator judges; pass pro_expert/con_expert with opposing stances (立场对照表可参考), moderator defaults to team-lead.
2. expert_teams_roundtable: 2-5 experts speak in parallel, a note taker folds the minutes (共识/分歧/开放问题/观察指标).
3. expert_teams_ppt: architecture first (docs-coordinator), content experts supply data, then per-page copy + speaker notes as a markdown pack.
4. expert_teams_report: material review first, parallel expert analysis, then a full report (标题/摘要/正文/结论/风险/附录, markdown) written by docs-coordinator.
These tools assemble the team from the caller's expert selection and seed the mode DAG; the same patterns also exist as preset scenarios (cross-debate/roundtable/ppt-gen/research-report) for expert_teams_scenario_apply.

Knowledge packs: files under the workspace <knowledgeDir>/{experts,scenarios,shared}/ are read by members directly (pointed to by their personas); never edit team.json or inbox files directly — use the expert_teams_* tools.

${skillDiscoveryPromptSection(skillInventoryLine)}

Tools: ${toolNames}`
}

export function apply(ctx: Context, config: Config): void {
  // Runtime knobs consumed by the tools. The object is mutated in place when
  // the settings source changes, so tools registered once always read the
  // latest authoritative values (entry config or the settings scope).
  const runtimeConfig: ToolsConfig = {
    stateDir: config.stateDir ?? 'expert-teams',
    memberProvider: config.memberProvider ?? 'spawn',
    memberModel: effectiveMemberModel(config),
    memberMaxDepth: config.memberMaxDepth ?? 0,
    maxActiveMembers: config.maxActiveMembers ?? 2,
    maxMembers: config.maxMembers ?? 8,
    knowledgeDir: config.knowledgeDir ?? 'knowledge',
    packsDir: config.packsDir ?? 'domain-packs',
    manageToken: config.manageToken,
    vendorPacksDir: resolveVendorPacksDir(config.vendorPacksDir),
    packCenterOrigin: config.packCenterOrigin,
    packCenterDir: config.packCenterDir,
    packCenterUpdatePolicy: normalizeUpdatePolicy(config.packCenterUpdatePolicy),
    packSourceAllowlist: config.packSourceAllowlist ?? [],
    enabledPacks: config.enabledPacks,
    packPriority: config.packPriority,
    expertModelOverrides: config.expertModelOverrides,
    toolExecution: config.toolExecution,
  }

  // Provider registration is a sibling plugin's effect (`subagent-spawn` /
  // `subagent-fork` rows), which can land after this mount under the Loader's
  // concurrent activation — so capability validation happens at the first
  // member spawn (`spawnMember`), the earliest point the provider list is
  // settled, rather than here.

  const toolNames = [
    'expert_teams_create',
    'expert_teams_plan_preview',
    'expert_teams_plan_stage',
    'expert_teams_plan_edit',
    'expert_teams_plan_approve',
    'expert_teams_plan_discard',
    'expert_teams_scenario_apply',
    'expert_teams_add_member',
    'expert_teams_remove_member',
    'expert_teams_create_task',
    'expert_teams_publish_artifact',
    'expert_teams_read_artifact',
    'expert_teams_reassign_task',
    'expert_teams_claim_task',
    'expert_teams_update_task',
    'expert_teams_send_message',
    'expert_teams_halt',
    'expert_teams_resume',
    'expert_teams_quality_review',
    'expert_teams_quality_repair',
    'expert_teams_quality_reopen',
    'expert_teams_quality_integrate',
    'expert_teams_resume_task',
    'expert_teams_status',
    'expert_teams_wait',
    'expert_library_doctor',
    'expert_teams_delete',
    'expert_teams_chat',
    'expert_review_route',
    'expert_review_apply',
    'expert_review_clarify',
    'expert_review_feedback',
    'expert_teams_debate',
    'expert_teams_roundtable',
    'expert_teams_ppt',
    'expert_teams_report',
  ].join(', ')

  const core = registerExpertTeamsTools(ctx, runtimeConfig)
  registerTeamWaitTool(ctx, runtimeConfig, core)
  void recoverStagedPlanRoots(ctx, runtimeConfig)
  const recoveryWorkspaces = [...new Set([
    // `workspace` is a display title; scheduler recovery needs the actual
    // filesystem parent of the durable state root.
    ...discoverStateRoots(ctx, runtimeConfig).map(root => dirname(root.stateRoot)),
    process.cwd(),
  ])]
  void Promise.all(recoveryWorkspaces.map((workspace) => (
    core.scheduler.recoverWorkspace(workspace).catch((error: unknown) => {
      ctx.logger.warn(`expert-library: team recovery failed for ${workspace}: ${String(error)}`)
      return undefined
    })
  )))
  registerZhijianTools(ctx, runtimeConfig, core)
  registerCollabTools(ctx, runtimeConfig, core)
  // render_publish: 通用基础设施工具（HTML5 产物 → 公网链接，无鉴权直出），
  // 在 HOST 入口注册、不进任何领域工具组；也因此不进上方智见 usage prompt
  // 的 toolNames 列表（该列表只描述智见/协作工具）。
  registerRenderPublishTool(ctx)

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
    registerProviderCallTool(ctx, { stateDir: runtimeConfig.stateDir })
    providerToolRegistered = true
  }

  // The usage policy section is injected while the plugin is announced to
  // agents; turning the announcement off (settings or entry config) removes it
  // so non-expert sessions are not polluted.
  //
  // The Skill discovery inventory is DYNAMIC: `dsh-system-prompt` evaluates a
  // section's `text` as a provider on EVERY assembly (per model step, with the
  // assembly's scope), so the prompt lists the workspace's CURRENT skills from
  // the shared index instead of a stale mount-time snapshot. The provider
  // resolves the workspace through `ctx.agents.currentInitiator()` (the agent
  // driving this assembly — per-session, since dsh-agent's scope carrier IS
  // the agent); outside an agent boundary it falls back to the union of every
  // workspace + bundled skills, which includes the current session's cwd. The
  // service contract exposes no scope→session→cwd lookup (ScopeKey is opaque),
  // so the union fallback is the honest floor — and the two live surfaces (the
  // /skills route and the member knowledge guide) carry the same inventory.
  // All reads go through the mtime-fingerprinted index — one scan per root.
  const sectionText = (context: AssembleContext): string => {
    try {
      return usageSectionText(toolNames, liveSkillsInventoryLine(ctx, runtimeConfig.knowledgeDir))
    } catch (error: unknown) {
      // A prompt provider must never break assembly. Preserve the discovery
      // mechanism without claiming an unreadable file inventory is empty.
      ctx.logger.warn(`expert-library: dynamic skill inventory failed: ${String(error)}`)
      return usageSectionText(toolNames, 'Plugin material context unavailable: ' + String(error) + '. Report work requiring frozen craft materials must stop until full current materials can be delivered; consult the discovery route for file paths.')
    }
  }
  // Async catalog discovery is scoped to the actual driving session. No process-global
  // "last catalog" cache or cross-workspace fallback may choose another tenant's pack.
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const agent = ctx.agents.currentInitiator()
    const workspace = agent?.session.header.cwd
    const assembly = await next()
    if (workspace === undefined || !(current().announceToAgent ?? true)) return assembly
    let text: string
    try {
      const found = await scopedSkillCraftDiscovery(ctx, runtimeConfig, workspace)
      text = found.text
      if (found.catalog.length) {
        const ownedIds = new Set(found.catalog.map(row => row.skillId))
        const legacyInventory = liveSkillsInventoryLine(ctx, runtimeConfig.knowledgeDir)
          .split('\n').filter(line => ![...ownedIds].some(id => line.startsWith(`- ${id}:`))).join('\n')
        const usage = assembly.sections.find(section => section.name === 'expert-library:usage')
        if (usage !== undefined) usage.text = usageSectionText(toolNames, legacyInventory)
      }
    } catch (error: unknown) {
      text = 'DOMAIN_SKILL_DISCOVERY_UNAVAILABLE: ' + String(error).slice(0, 1500)
        + '. Resolve the scoped pack inventory before selecting a new craft; no fallback to a global same-name copy.'
    }
    const name = 'expert-library:domain-craft-catalog'
    assembly.sections = [...assembly.sections.filter(section => section.name !== name), { name, text }]
    return assembly
  })
  // Required materials survive compaction independently from optional inventory announcements.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'expert-library:report-craft-materials', order: 118,
    text: () => {
      const agent = ctx.agents.currentInitiator()
      return agent?.session.header.cwd === undefined ? ''
        : craftSessionContext(resolvePath(agent.session.header.cwd, runtimeConfig.stateDir), agent.id)
    },
  }))
  let disposeSection: (() => void) | undefined
  const syncAnnounce = (): void => {
    const value = current()
    const announce = value.announceToAgent ?? true
    if (announce && disposeSection === undefined) {
      disposeSection = ctx.systemPrompt.section({
        name: 'expert-library:usage',
        order: value.promptSectionOrder ?? 117,
        text: sectionText,
      })
    } else if (!announce && disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
  }

  let current: () => Config = () => config
  installProviderRequestQueue(ctx, () => current().providerRequestConcurrency)
  const applySource = (source: () => Config): void => {
    current = source
    const value = current()
    runtimeConfig.stateDir = value.stateDir ?? 'expert-teams'
    runtimeConfig.memberProvider = value.memberProvider ?? 'spawn'
    runtimeConfig.memberModel = effectiveMemberModel(value)
    runtimeConfig.memberMaxDepth = value.memberMaxDepth ?? 0
    runtimeConfig.maxActiveMembers = value.maxActiveMembers ?? 2
    runtimeConfig.maxMembers = value.maxMembers ?? 8
    runtimeConfig.knowledgeDir = value.knowledgeDir ?? 'knowledge'
    runtimeConfig.packsDir = value.packsDir ?? 'domain-packs'
    runtimeConfig.manageToken = value.manageToken
    runtimeConfig.vendorPacksDir = resolveVendorPacksDir(value.vendorPacksDir)
    runtimeConfig.packCenterOrigin = value.packCenterOrigin
    runtimeConfig.packCenterDir = value.packCenterDir
    runtimeConfig.packCenterUpdatePolicy = normalizeUpdatePolicy(value.packCenterUpdatePolicy)
    runtimeConfig.packSourceAllowlist = value.packSourceAllowlist ?? []
    runtimeConfig.enabledPacks = value.enabledPacks
    runtimeConfig.packPriority = value.packPriority
    runtimeConfig.expertModelOverrides = value.expertModelOverrides
    runtimeConfig.toolExecution = value.toolExecution
    // Pack edits via settings take effect without a restart: drop the builtin
    // pack cache AND the runtime overlay cache on every settings commit — the
    // next compile rebuilds them lazily (mtime staleness also catches external
    // pack regeneration; see src/v2/compat.ts builtinLegacyPack and
    // src/v2/runtime-pack.ts resolveRuntimePack).
    invalidateBuiltinLegacyPack()
    invalidateRuntimePack()
    syncAnnounce()
    syncProviders()
    // 更新策略热生效：调度器按新策略 arm/disarm（下一跳生效，不打断进行中的批次）。
    autoUpdate?.sync()
  }

  // Assigned once createPackCenterHost returns below; declared here because
  // applySource may run earlier (first invocation happens before host creation)
  // and must tolerate the scheduler not existing yet.
  let autoUpdate: ReturnType<typeof createPackCenterAutoUpdate> | undefined

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

  const packCenter = createPackCenterHost(ctx, runtimeConfig, () => {
    const registry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1])) as WorkspaceRegistry | undefined
    return registry?.list().map(workspace => workspace.path) ?? []
  })
  autoUpdate = packCenter.autoUpdate
  runtimeConfig.getPackCenterSnapshot = () => packCenter.activeSnapshot()
  const handlePackCenter = createPackCenterRouteHandler({ service: packCenter.service,
    getManageToken: () => resolveManageToken(runtimeConfig.manageToken), updatePolicy: packCenter.updatePolicy })
  // No network on startup: startup only resumes persisted jobs and verifies
  // local receipts. The update scheduler arms itself below purely on an
  // explicit deployment opt-in (non-manual policy + configured origin); with
  // the default `manual` policy this host makes no periodic network calls at
  // all. Fixed log text only: configuration/transport errors must not print
  // secrets.
  void packCenter.service.start().catch(() => ctx.logger.warn('expert-library: pack-center local startup needs administrator attention'))
  packCenter.autoUpdate.sync()
  ctx.effect(() => () => {
    void packCenter.autoUpdate.close()
    void packCenter.service.close().catch(() => {})
  }, 'expert-library: pack-center local manager')

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

    // The host connection service owns the signed browser cookie and the
    // trusted Host/Origin fence. Plugin routes must use that predicate rather
    // than treating a durable captain session id as browser identity.
    const nativeHostAuth = (req: IncomingMessage): number | undefined => {
      // The web route can bind before Connection finishes activating. Resolve
      // the service for every request instead of capturing an early `undefined`
      // and turning every authenticated browser call into a false 401.
      const connection = ctx.get('connection') as { requestRejection?: (request: IncomingMessage) => number | undefined } | undefined
      if (connection?.requestRejection === undefined) return 401
      return connection.requestRejection(req)
    }

    // Versioned team wire surface used by the activity panel. Reads are
    // projected from durable state and never kick the scheduler or consume
    // mail. Writes resolve the live captain agent before delegating to the
    // existing CAS/state cores, so the browser cannot become a second owner.
    const resolveTeamRouteTarget = async (captainSessionId: string, teamId?: string, planId?: string): Promise<TeamRouteTarget | undefined> => {
      const targets: TeamRouteTarget[] = []
      for (const root of discoverStateRoots(ctx, runtimeConfig)) {
        if (teamId !== undefined) {
          const live = await readTeam(root.stateRoot, teamId)
          // Native HostConnection auth has already established the browser
          // identity. Durable state remains readable after a DSH restart.
          if (live?.captainSessionId === captainSessionId && (planId === undefined || live.planRef?.planId === planId)) targets.push({ stateRoot: root.stateRoot, teamId: live.id, planId: live.planRef?.planId, captainSessionId, archived: false })
          for (const archivedId of await listArchivedTeamIds(root.stateRoot)) {
            if (archivedId !== teamId) continue
            const archived = await readArchivedTeam(root.stateRoot, archivedId)
            if (archived?.captainSessionId === captainSessionId && (planId === undefined || archived.planRef?.planId === planId)) targets.push({ stateRoot: root.stateRoot, teamId: archived.id, planId: archived.planRef?.planId, captainSessionId, archived: true })
          }
          continue
        }
        // A staged plan is a first-class review target before approval has
        // materialized a team. The plan's createdBy binds it to the captain
        // session; native HostConnection authentication protects the request.
        if (planId !== undefined) {
          const plan = await readStagedPlan(root.stateRoot, planId)
          if (plan?.createdBy === captainSessionId) targets.push({ stateRoot: root.stateRoot, planId, captainSessionId, archived: false })
          continue
        }
        const live = await findTeamByCaptain(root.stateRoot, captainSessionId)
        if (live !== undefined) targets.push({ stateRoot: root.stateRoot, teamId: live.id, planId: live.planRef?.planId, captainSessionId, archived: false })
        for (const archivedId of await listArchivedTeamIds(root.stateRoot)) {
          const archived = await readArchivedTeam(root.stateRoot, archivedId)
          if (archived?.captainSessionId === captainSessionId) targets.push({ stateRoot: root.stateRoot, teamId: archived.id, captainSessionId, archived: true })
        }
      }
      return targets.length === 1 ? targets[0] : undefined
    }
    const readTeamRouteResponse = async (target: TeamRouteTarget): Promise<TeamWireResponse> => {
      if (target.teamId === undefined) {
        if (target.planId === undefined) throw new Error('team or plan is required')
        const staged = await readStagedPlan(target.stateRoot, target.planId)
        if (staged === undefined || staged.createdBy !== target.captainSessionId) throw new Error('plan not found')
        return { version: 1, team: null, plan: planToWire(staged), archived: false }
      }
      const team = target.archived
        ? await readArchivedTeam(target.stateRoot, target.teamId)
        : await readTeam(target.stateRoot, target.teamId)
      if (team === undefined || team.captainSessionId !== target.captainSessionId) throw new Error('team not found')
      const plan = (target.planId ?? team.planRef?.planId) === undefined ? undefined : await readStagedPlan(target.stateRoot, target.planId ?? team.planRef?.planId as string)
      return { version: 1, team: teamToWire(team, target.archived), ...(plan === undefined ? { plan: null } : { plan: planToWire(plan) }), archived: target.archived }
    }
    const actionTeamRoute = async (target: TeamRouteTarget, request: TeamRouteRequest): Promise<TeamWireResponse> => {
      if (target.archived) throw new Error('archived team is read-only')
      const captain = ctx.agents.get(target.captainSessionId as SessionId)
      if (captain === undefined) throw new Error('captain session is not live')
      const current = target.teamId === undefined ? undefined : await readTeam(target.stateRoot, target.teamId)
      if (target.teamId !== undefined && (current === undefined || current.captainSessionId !== captain.id)) throw new Error('team not found')
      const planId = request.planId ?? target.planId ?? current?.planRef?.planId
      let approvedTeamId: string | undefined
      if (request.action === 'edit') {
        if (planId === undefined) throw new Error('team has no staged plan')
        await scenarioEditCore(ctx, runtimeConfig, captain, planId, (request.patch ?? {}) as never, request.expectedDigest, request.expectedRevision)
      } else if (request.action === 'approve') {
        if (planId === undefined) throw new Error('team has no staged plan')
        const approved = await scenarioApproveFromHost(ctx, runtimeConfig, captain, planId, new AbortController().signal, core, request.expectedDigest, request.expectedRevision)
        approvedTeamId = approved.appliedTeamId
      } else if (request.action === 'discard') {
        if (planId === undefined) throw new Error('team has no staged plan')
        await scenarioDiscardCore(runtimeConfig, captain, planId, request.expectedDigest, request.expectedRevision)
      } else if (request.action === 'halt') {
        if (current === undefined) throw new Error('team not found')
        await haltTeam(target.stateRoot, current.id, request.reason?.trim() || 'paused from activity panel')
      } else if (request.action === 'resume') {
        if (current === undefined) throw new Error('team not found')
        const resumed = await resumeTeam(target.stateRoot, current.id, request.reason?.trim() || 'resumed from activity panel')
        await core.scheduler.kickTeam(workspaceOf(captain), resumed.id, captain)
      } else if (request.action === 'archive') {
        if (current === undefined) throw new Error('team not found')
        if (!current.tasks.every(task => ['completed', 'failed', 'cancelled'].includes(task.status))) throw new Error('archive requires all tasks to be terminal')
        // Archive is a lifecycle mutation: retire every child under the team
        // lock, persist the deny-list before interruption, wait for quiescence,
        // then move the durable directory under the same lock. This prevents a
        // late member message from racing the archive and avoids silent live
        // children after the UI reports success.
        const roster = await withTeamLock(teamLockKey(target.stateRoot, current.id), async () => {
          const fresh = await readTeam(target.stateRoot, current.id)
          if (fresh === undefined || fresh.captainSessionId !== captain.id) throw new Error('team not found')
          const members = fresh.members.map(member => ({ ...member }))
          for (const member of fresh.members) member.status = 'removed'
          await writeTeam(target.stateRoot, fresh)
          return members
        })
        await recordRetiredMemberIds(target.stateRoot, roster.map(member => member.id))
        for (const member of roster) if (member.id !== '') interruptMember(ctx, captain, member.id)
        const stopController = new AbortController()
        const stopTimer = setTimeout(() => stopController.abort(new Error('archive quiescence timeout')), 10_000)
        try {
          await Promise.allSettled(roster.map(member => waitForMemberIdle(ctx, member, stopController.signal)))
        } finally {
          clearTimeout(stopTimer)
        }
        await withTeamLock(teamLockKey(target.stateRoot, current.id), async () => {
          const fresh = await readTeam(target.stateRoot, current.id)
          if (fresh === undefined || fresh.captainSessionId !== captain.id) throw new Error('team changed during archive')
          await archiveTeamDir(target.stateRoot, current.id)
        })
      }
      const next = planId !== undefined && request.action === 'approve'
        ? await resolveTeamRouteTarget(captain.id, undefined, planId)
        : await resolveTeamRouteTarget(captain.id, target.teamId, planId)
      // Approval normally creates a team and archives the staged plan. Re-
      // resolve the durable team by the returned applied id.
      const applied = approvedTeamId === undefined ? next : await resolveTeamRouteTarget(captain.id, approvedTeamId)
      if (applied === undefined) throw new Error('team or plan disappeared after action')
      return readTeamRouteResponse(applied)
    }
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-expert-library/teams',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        await handleTeamRoutes(req, res, url, {
          getToken: () => resolveManageToken(runtimeConfig.manageToken),
          hostAuth: nativeHostAuth,
          resolve: resolveTeamRouteTarget,
          read: readTeamRouteResponse,
          action: actionTeamRoute,
          authorization: async (sessionId, action, input) => {
            const captain = ctx.agents.get(sessionId as SessionId)
            if (captain === undefined || captain.session.header.origin === 'subagent') throw new Error('PLAN_AUTHORIZATION_CAPTAIN_NOT_FOUND')
            const stateRoot = stateRootOf(workspaceOf(captain), runtimeConfig)
            if (action === 'read') return readPlanExecutionAuthorization(stateRoot, sessionId)
            if (typeof input?.requestId !== 'string') throw new Error('PLAN_AUTHORIZATION_INVALID_INPUT')
            if (action === 'revoke') return revokePlanExecution(stateRoot, sessionId, input.requestId)
            if (input.scope !== PLAN_AUTHORIZATION_SCOPE || typeof input.expectedInputSha256 !== 'string' || typeof input.reason !== 'string') throw new Error('PLAN_AUTHORIZATION_INVALID_INPUT')
            if (input.requireReviewedReport !== undefined && input.requireReviewedReport !== true) throw new Error('PLAN_AUTHORIZATION_INVALID_INPUT')
            return authorizePlanExecution(stateRoot, sessionId, captureSharedTaskContext(captain), {
              requestId: input.requestId, expectedInputSha256: input.expectedInputSha256, reason: input.reason, scope: input.scope,
              ...(input.requireReviewedReport === true ? { requireReviewedReport: true as const } : {}),
            })
          },
        })
      },
    }), 'expert-teams: versioned team wire route')

    // Activity panel data route: the browser floater polls this for team
    // snapshots (disk truth + live subagent activity). Mirrors the Claude
    // Code desktop watcher's server-side snapshot pattern.
    ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-expert-library/state',
    handler: async (req, res) => {
      const rejection = nativeHostAuth(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'cache-control': 'no-store' })
        res.end(rejection === 403 ? 'forbidden' : 'unauthorized')
        return
      }
      const url = new URL(req.url ?? '/', 'http://x')
      const roots = discoverStateRoots(ctx, runtimeConfig)
      // ?archived=1 serves teams moved to archive/ (post-delete review).
      const snapshots = url.searchParams.get('archived') === '1'
        ? await collectArchivedTeamsActivity(ctx, roots)
        : await collectTeamsActivity(ctx, roots)
      const plans = url.searchParams.get('archived') === '1' ? [] : (await Promise.all(roots.flatMap(root =>
        listStagedPlanIds(root.stateRoot).then(async ids => {
          const rows: Array<{ captainSessionId: string; plan: ReturnType<typeof planToWire> }> = []
          for (const planId of ids) {
            try {
              const plan = await readStagedPlan(root.stateRoot, planId)
              if (plan !== undefined && !['discarded', 'expired'].includes(plan.status)) rows.push({ captainSessionId: plan.createdBy, plan: planToWire(plan) })
            } catch {
              // A malformed draft is surfaced by expert_library_doctor; the
              // activity route remains available for other teams/plans.
            }
          }
          return rows
        }),
      ))).flat()
      const body = JSON.stringify({ teams: snapshots, plans })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(body)
    },
  }), 'expert-teams: activity route')

  // Skill discovery route (read-only): enumerates every installed local skill
  // across candidate workspaces (workspace registry + session cwds, the same
  // union the /state route scans) plus the plugin's own bundled knowledge/
  // dir. Lets an agent list what skills actually exist on the filesystem
  // before concluding a named skill is absent (id/name/path/sizeBytes/
  // hasReferences per entry; safe-id filtered, first hit per id wins).
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-expert-library/skills',
    handler: async (_req, res) => {
      // The route reads the same mtime-fingerprinted index every consumer
      // shares (discoverSkillRoots gives the roots; collectSkillEntries reads
      // each through the cache) — no separate scan.
      const roots = discoverSkillRoots(ctx, runtimeConfig.knowledgeDir)
      const skills = collectSkillEntries(roots)
      const body = JSON.stringify({ skills })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(body)
    },
  }), 'expert-teams: skills discovery route')

  // Domain craft catalogs require a known session, so an unscoped HTTP request
  // cannot obtain a union of unrelated workspaces or choose an arbitrary path.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-expert-library/craft-skills',
    handler: async (req, res) => {
      const reply = (status: number, value: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(value))
      }
      const rejection = nativeHostAuth(req)
      if (rejection !== undefined) return reply(rejection, { error: 'unauthorized' })
      if (req.method !== 'GET') return reply(405, { error: 'method_not_allowed' })
      const url = new URL(req.url ?? '/', 'http://x')
      const sessionId = url.searchParams.get('session_id')
      if (!sessionId || sessionId.length > 256) return reply(400, { error: 'session_id_required' })
      const workspace = sessionCwdOf(ctx, sessionId)
      if (workspace === undefined) return reply(404, { error: 'session_not_found' })
      try {
        const found = await scopedSkillCraftDiscovery(ctx, runtimeConfig, workspace)
        reply(200, { sessionId, skills: found.catalog })
      } catch {
        reply(409, { error: 'scoped_craft_catalog_unavailable', message: 'Resolve installed pack integrity, enablement or conflicts before selecting a craft.' })
      }
    },
  }), 'expert-teams: scoped domain craft discovery route')

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

  // Expert route observability (设置页「专家路由」): read-only listing of
  // every expert with its preset route (pack-baked), the settings override
  // (if any) and the effective route + inheritance source. The wire carries
  // anonymization-safe identity (id/field/stance/initials), never persona
  // prose; routes are provider/model/effort only. The listing covers the
  // builtin/zhijian registries plus every expert of the resolved runtime
  // pack (workspace overlays), so an override can target exactly what the
  // compile path can roster.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-expert-library/experts',
    handler: async (_req, res) => {
      const value = current()
      const overrides = value.expertModelOverrides ?? {}
      const defaultModel = value.defaultModel ?? value.memberModel
      // Workspace overlay experts (merged over the builtin zhijian pack);
      // failures degrade to the builtin pack alone.
      let overlayPack: DomainPackV2 | undefined
      try {
        overlayPack = (await resolveManagedRuntimePack(ctx, runtimeConfig, buildZhijianDomainPack())).pack
      } catch (error) {
        // Managed failures must remain visible; a builtin-only listing would
        // misrepresent the active release. Preserve legacy-only fallback.
        if (runtimeConfig.getPackCenterSnapshot !== undefined) throw error
        overlayPack = undefined
      }
      const experts = [...BUILTIN_EXPERT_BY_ID.values(), ...ZHIJIAN_EXPERT_BY_ID.values()]
      const byId = new Map<string, { meta?: ReturnType<typeof zhijianMetaById>; expert: { id: string; name: string; role?: string; model?: { provider: string; model: string; reasoningEffort?: string } } }>()
      for (const expert of experts) {
        byId.set(expert.id, { expert })
      }
      for (const meta of ALL_EXPERT_METAS) {
        const existing = byId.get(meta.id)
        if (existing === undefined) byId.set(meta.id, { meta, expert: { id: meta.id, name: meta.name, role: meta.field } })
        else existing.meta = meta
      }
      // Workspace overlay experts: V2-shaped, id + internal name + preset
      // modelPolicy. Their meta is absent, so the wire carries name only.
      for (const expertV2 of overlayPack?.experts ?? []) {
        if (byId.has(expertV2.id)) continue
        const modelPolicy = expertV2.modelPolicy
        byId.set(expertV2.id, {
          expert: {
            id: expertV2.id,
            name: expertV2.display.internalName,
            ...(modelPolicy === undefined ? {} : { model: { ...modelPolicy } }),
          },
        })
      }
      const list = [...byId.values()].map(({ meta, expert }) => {
        const override = overrides[expert.id]
        const preset = expert.model
        const effective = override ?? preset ?? defaultModel
        return {
          id: expert.id,
          name: expert.name,
          ...(meta !== undefined ? {
            field: meta.field,
            stance: meta.stance,
            initials: meta.initials,
            ...(meta.deceased === true ? { deceased: true } : {}),
            ...(meta.namespace !== undefined ? { namespace: meta.namespace } : {}),
            ...(meta.version !== undefined ? { version: meta.version } : {}),
          } : {
            ...(expert.role !== undefined ? { role: expert.role } : {}),
          }),
          ...(preset !== undefined ? { preset: { ...preset } } : {}),
          ...(override !== undefined ? { override: { ...override } } : {}),
          ...(effective === undefined ? {} : { effective: { ...effective } }),
          source: override !== undefined ? 'override' : preset !== undefined ? 'expert' : defaultModel !== undefined ? 'default' : 'none',
        }
      })
      const body = JSON.stringify({ experts: list })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(body)
    },
  }), 'expert-teams: expert route listing')

  // Manual library management (设置页「专家库」写侧): 专家/场景运行时覆盖层
  // CRUD（写 <workspace>/<knowledgeDir>/{experts,scenarios}/<id>.json，惰性
  // 生效、零漂移——领域包本体是构建产物绝不直写）、技能 zip 安装
  // （<knowledgeDir>/skills/<id>/，安全 id + zip-slip 防护）与领域包重建
  // （白名单脚本 build-packs.mjs，仅允许 PACK_BUILD_ALLOWLIST 内 pack id）。
  // 写目标 workspace：优先首个注册 workspace 的 cwd，回退当前进程 cwd——
  // 设置页没有会话上下文，故不按 session cwd 解析。
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/plugins/dsh-expert-library/manage',
    handler: async (req, res) => {
      // Raw URL enters the stricter center router before normalization or legacy
      // handling. It independently enforces local auth and browser CSRF rules.
      if (await handlePackCenter(req, res)) return
      // The plugin's write surface is not covered by the Harness browser-auth
      // gate (measured: `/plugins/*` answers 200 unauthenticated on both the
      // loopback and the public authority), so every route below — reads
      // included, since `knowledge-roots` discloses filesystem paths — passes
      // the loopback/token fence first. Fail-closed: see host/auth.ts.
      const decision = authorizeManageRequest(
        { headers: req.headers, remoteAddress: req.socket?.remoteAddress },
        resolveManageToken(runtimeConfig.manageToken),
      )
      if (!decision.ok) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: `manage surface refused: ${decision.reason}` }))
        return
      }
      const url = new URL(req.url ?? '/', 'http://x')
      const registry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1])) as
        | { list(): Array<{ path: string }> }
        | undefined
      const firstWorkspace = registry?.list()?.[0]?.path
      const workspace = firstWorkspace !== undefined && firstWorkspace !== '' ? firstWorkspace : process.cwd()
      await handleManage(ctx, req, res, url, workspace, runtimeConfig.knowledgeDir, {
        vendorRoot: runtimeConfig.vendorPacksDir ?? '',
        allowlist: runtimeConfig.packSourceAllowlist ?? [],
        // Every id already visible to the runtime — built-in packs, workspace
        // packs, and the vendored ledger — so a new pack cannot shadow one by
        // reusing its id (mergePackLayers would resolve the duplicate by
        // precedence, silently overwriting).
        knownPackIds: async () => {
          const ids = new Set<string>()
          for (const dir of await discoverPackDirs(ctx, runtimeConfig.packsDir ?? 'domain-packs', runtimeConfig.vendorPacksDir ?? '')) {
            const loaded = await loadPackFromDir(dir.dir)
            if (loaded.pack !== undefined) ids.add(loaded.pack.pack.id)
          }
          const registry = await readRegistry(runtimeConfig.vendorPacksDir ?? '')
          for (const entry of registry.packs) ids.add(entry.id)
          return [...ids]
        },
      })
    },
  }), 'expert-teams: manual library management routes')

  // Provider failure observability: read-only audit tail route. Merges the
  // persisted JSONL tail (cross-restart memory) with the live in-memory
  // registry audit (first-class), deduped by record identity, bounded by
  // ?limit= (default 100, max 500). Entries carry only
  // kind/providerId/version/operation/outcome/at + detail — never credentials.
  // Also carries `eventsDropped`: expert-teams/* session events the harness's
  // closed session vocabulary forced the plugin to omit (see src/events.ts).
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-expert-library/audit',
    handler: createAuditHandler({
      auditLog,
      resolveMemory: () => providerService?.audit() ?? [],
      resolveDroppedEvents: droppedSessionEvents,
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
        for (const pack of await discoverPackDirs(ctx, packsDir, runtimeConfig.vendorPacksDir ?? '')) {
          if (seen.has(pack.dir)) continue
          seen.add(pack.dir)
          packDirs.push(pack)
        }
        return {
          providers: {
            wind: { cliPath: windCliPathCandidate(value as ProviderConfigInput) },
            ...(options.zyt !== undefined ? { zyt: { baseUrl: options.zyt.baseUrl } } : {}),
            ...(options.beike !== undefined ? { beike: { baseUrl: options.beike.baseUrl } } : {}),
            ...(options.localdb !== undefined
              ? {
                localdb: {
                  databases: options.localdb.databases.map(db => ({
                    id: db.id,
                    path: db.path,
                    ...(db.sensitivity !== undefined ? { sensitivity: db.sensitivity } : {}),
                  })),
                },
              }
              : {}),
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
