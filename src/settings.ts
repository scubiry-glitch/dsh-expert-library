/**
 * Expert Library settings namespace.
 *
 * The web settings surface (and any settings provider) edits the same knobs
 * the host plugin exposes through its cordis entry config. Three policy groups
 * are stored here as JSON-safe settings and consumed by the tools at runtime:
 *
 * 1. **Runtime** — stateDir / knowledgeDir / memberProvider / memberMaxDepth /
 *    maxMembers / promptSectionOrder / announceToAgent.
 * 2. **Model policy** — `defaultModel` (provider/model/reasoningEffort) applied
 *    to every expert member that has no preset route of its own. Per-expert and
 *    per-scenario overrides stay in the expert/scenario definitions; this is
 *    the library-wide default.
 * 3. **Tool execution mode** — `toolExecution[<toolId>]` selects how an
 *    external capability (e.g. the zyt 政研通 CLI/API) is executed:
 *    `api` (structured HTTP tool), `cli` (controlled local command) or `auto`
 *    (probe API first, fall back to CLI). API keys never enter this document —
 *    they belong to the dedicated credentials/tool adapter layer.
 *
 * The canonical optional-settings consumer wiring rides
 * `installSettingsSection`: while a settings service exists the namespace is
 * registered with the composition entry as its `base` layer and the source
 * thunk points at the resolved scope; when the service goes away the consumer
 * falls back to the entry, so the plugin keeps working exactly as composed.
 *
 * @module dsh-expert-library/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { ExpertModelRoute } from './expert-library/types.ts'

/** Settings namespace of the expert-library capability. */
export const EXPERT_LIBRARY_SETTINGS_NAMESPACE = settingsNamespace('expert-library')

/** How an external capability executes: structured API, controlled CLI, or probe-then-fallback. */
export type ToolExecutionMode = 'api' | 'cli' | 'auto'

/** Structured-API binding options for one external tool. */
export interface ToolApiBinding {
  /** Base URL of the API (no secrets). */
  baseUrl?: string
  /** Per-call timeout in milliseconds. */
  timeoutMs?: number
  /** Max automatic retries. */
  maxRetries?: number
}

/** Controlled-CLI binding options for one external tool. */
export interface ToolCliBinding {
  /** Executable name/path (must be on an allowlist at the adapter layer). */
  command?: string
  /** Working directory for the command. */
  workingDirectory?: string
  /** Per-call timeout in milliseconds. */
  timeoutMs?: number
}

/** Execution policy for one external tool id (e.g. `zyt`). */
export interface ToolExecutionConfig {
  /**
   * Execution mode as stored. The storage schema is deliberately loose (any
   * string); the effective mode is normalized by {@link normalizeToolMode},
   * so unknown values fall back to `auto` at runtime.
   */
  mode?: string
  /** Structured-API binding, used when mode is `api` or `auto`. */
  api?: ToolApiBinding
  /** Controlled-CLI binding, used when mode is `cli` or `auto`. */
  cli?: ToolCliBinding
  /** Whether every call must be read-only (no writes, no destructive flags). */
  readOnly?: boolean
  /** Member roles allowed to invoke the tool; absent = default roles only. */
  preferredRoles?: string[]
}

/** The full user-editable settings section of the expert-library plugin. */
export interface ExpertLibrarySettings {
  /** State directory name under the captain's workspace. */
  stateDir?: string
  /** Knowledge pack directory name under the captain's workspace. */
  knowledgeDir?: string
  /** Domain pack directory name under each workspace root (read-only preview; default `domain-packs`). */
  packsDir?: string
  /**
   * Directory holding packs vendored from external sources. Empty falls back
   * to `<DSH_HOME>/vendor-packs`, and to disabled when there is no DSH home.
   */
  vendorPacksDir?: string
  /** HTTPS center origin; changing this or packCenterDir requires plugin restart. */
  packCenterOrigin?: string
  /** Private deployment-local storage; defaults under DSH_HOME, never the plugin tree. */
  packCenterDir?: string
  /** 宿主侧半自动更新策略；manual（默认）永不后台检查。见 {@link PackCenterUpdatePolicy}。 */
  packCenterUpdatePolicy?: PackCenterUpdatePolicy
  /** Locator hosts whose packs install on validation success, without review. */
  packSourceAllowlist?: string[]
  /** Member subagent provider name (`spawn` or `fork`). */
  memberProvider?: string
  /** Member delegation depth cap; `0` forbids delegation. */
  memberMaxDepth?: number
  /** Maximum concurrently active team members, including reviewers (default 2). */
  maxActiveMembers?: number
  /** Host-local concurrent model streams per provider; absent providers are unlimited. */
  providerRequestConcurrency?: Record<string, number>
  /** Team size cap in members. */
  maxMembers?: number
  /** Prompt-section order of the usage policy. */
  promptSectionOrder?: number
  /** Whether the usage policy section is announced to agents (default true). */
  announceToAgent?: boolean
  /** Library-wide default model route for members without a preset route. */
  defaultModel?: ExpertModelRoute
  /** Per-tool execution policy (API vs CLI vs auto). */
  toolExecution?: Record<string, ToolExecutionConfig>
  /** Workspace domain pack ids enabled for runtime compile; absent = every valid workspace pack. */
  enabledPacks?: string[]
  /** Workspace domain pack id order (first = highest precedence); absent = discovery order. */
  packPriority?: string[]
  /** Per-expert model route override (expert id → route); wins over the preset expert route. */
  expertModelOverrides?: Record<string, ExpertModelRoute>
  /** Provider path/endpoint configuration (wind/zyt/beike); env/probe defaults apply when absent. */
  providers?: {
    wind?: { cliPath?: string }
    zyt?: { baseUrl?: string; cliCommand?: string; preferCli?: boolean }
    beike?: { baseUrl?: string; cliCommand?: string; preferCli?: boolean }
  }
}

const modelRouteSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
})

const apiBindingSchema = z.object({
  baseUrl: z.string(),
  timeoutMs: z.natural(),
  maxRetries: z.natural(),
})

const cliBindingSchema = z.object({
  command: z.string(),
  workingDirectory: z.string(),
  timeoutMs: z.natural(),
})

const toolExecutionSchema = z.dict(z.object({
  mode: z.string(),
  api: apiBindingSchema,
  cli: cliBindingSchema,
  readOnly: z.boolean(),
  preferredRoles: z.array(z.string()),
}))

const providerWindSchema = z.object({ cliPath: z.string() })
const providerZytSchema = z.object({ baseUrl: z.string(), cliCommand: z.string(), preferCli: z.boolean() })
const providerBeikeSchema = z.object({ baseUrl: z.string(), cliCommand: z.string(), preferCli: z.boolean() })

/** Loose storage schema (same rationale as the interface); strictness lives in
 * {@link normalizeUpdatePolicy} at read time. */
export const PackCenterUpdatePolicySchema: z<PackCenterUpdatePolicy> = z.object({
  mode: z.string(),
  perPack: z.dict(z.string()),
})

/**
 * Schema resolving the expert-library settings namespace. Mirrors the plugin
 * `Config` shape (the entry config is the composition `base` layer); fields are
 * optional here so a settings provider may serve a partial section.
 */
export const ExpertLibrarySettingsSchema: z<ExpertLibrarySettings> = z.object({
  stateDir: z.string(),
  knowledgeDir: z.string(),
  packsDir: z.string(),
  vendorPacksDir: z.string(),
  packCenterOrigin: z.string(),
  packCenterDir: z.string(),
  packCenterUpdatePolicy: PackCenterUpdatePolicySchema,
  packSourceAllowlist: z.array(z.string()),
  memberProvider: z.string(),
  memberMaxDepth: z.natural(),
  maxActiveMembers: z.natural().min(1),
  providerRequestConcurrency: z.dict(z.natural().min(1)),
  maxMembers: z.natural(),
  promptSectionOrder: z.natural(),
  announceToAgent: z.boolean(),
  defaultModel: modelRouteSchema,
  toolExecution: toolExecutionSchema,
  enabledPacks: z.array(z.string()),
  packPriority: z.array(z.string()),
  expertModelOverrides: z.dict(modelRouteSchema),
  providers: z.object({
    wind: providerWindSchema,
    zyt: providerZytSchema,
    beike: providerBeikeSchema,
  }),
})

/**
 * Resolve the effective member model without rejecting legacy or partially
 * written settings. Empty provider/model routes are treated as absent so a
 * stale `defaultModel` object cannot mask the legacy `memberModel` route.
 */
export function effectiveMemberModel(
  value: { defaultModel?: ExpertModelRoute; memberModel?: ExpertModelRoute } | undefined,
): ExpertModelRoute | undefined {
  const isUsable = (route: ExpertModelRoute | undefined): route is ExpertModelRoute =>
    typeof route?.provider === 'string'
    && route.provider.trim() !== ''
    && typeof route.model === 'string'
    && route.model.trim() !== ''
  if (isUsable(value?.defaultModel)) return value.defaultModel
  if (isUsable(value?.memberModel)) return value.memberModel
  return undefined
}

/** Hooks the consumer hands to {@link installExpertLibrarySettings}. */
export interface ExpertLibrarySettingsHooks {
  /** Receive the active configuration source (settings scope while attached, entry otherwise). */
  setSource(current: () => ExpertLibrarySettings): void
  /** Re-judge anything derived from the source after attach/detach/commit. */
  onChange(): void
}

/**
 * Install the canonical optional-settings consumer wiring for the Expert
 * Library. No-op when no settings service is mounted, so headless profiles
 * without a settings provider keep resolving entry config alone.
 */
export function installExpertLibrarySettings(
  ctx: Context,
  entry: ExpertLibrarySettings,
  hooks: ExpertLibrarySettingsHooks,
): void {
  installSettingsSection(
    ctx,
    EXPERT_LIBRARY_SETTINGS_NAMESPACE,
    ExpertLibrarySettingsSchema,
    entry,
    {
      setSource: (source) => hooks.setSource(source),
      onChange: () => hooks.onChange(),
    },
  )
}

/** Normalize a stored tool-execution mode; unknown/empty values become `auto`. */
export function normalizeToolMode(mode: string | undefined): ToolExecutionMode {
  return mode === 'api' || mode === 'cli' || mode === 'auto' ? mode : 'auto'
}

/** Read the effective execution policy for one tool id from a settings section. */
export function toolExecutionOf(
  settings: ExpertLibrarySettings | undefined,
  toolId: string,
): ToolExecutionConfig | undefined {
  return settings?.toolExecution?.[toolId]
}

/**
 * Deployment-local pack-center update policy tiers.
 *
 * - `manual`（默认）：现状语义，永不后台检查，更新完全由人工触发。
 * - `download`：定时检查到新版本时自动下载缓存（install 不激活），启用仍需人工。
 * - `patch_auto`：在 download 基础上，仅同 major.minor 的补丁升级自动启用。
 *
 * The center is never involved in the decision: it is pulled exactly like a
 * manual check, and no push channel exists.
 */
export type PackCenterUpdateMode = 'manual' | 'download' | 'patch_auto'
export const PACK_CENTER_UPDATE_MODES: readonly PackCenterUpdateMode[] = ['manual', 'download', 'patch_auto']

/**
 * Stored update policy: a global default plus per-pack overrides. Storage is
 * deliberately loose (same rationale as `toolExecution.mode` above) — a strict
 * enum here would let one stale value fail the whole `expert-library` settings
 * attachment; unknown values normalize to `manual`, the safe downgrade.
 */
export interface PackCenterUpdatePolicy {
  /** Stored global mode; absent/unknown normalizes to `manual`. */
  mode?: string
  /** Per-pack mode overrides keyed by pack id; invalid keys are dropped on read. */
  perPack?: Record<string, string>
}

/** Valid `perPack` key: the same shape as a pack id, minus prototype-chain and credential-shaped hazards. */
const packCenterPolicyKey = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isValidPolicyPackKey(value: unknown): value is string {
  return typeof value === 'string' && packCenterPolicyKey.test(value) && !value.includes('..')
    && !['__proto__', 'constructor', 'prototype'].includes(value)
    && !/^dpc_(?:token|bind)_/.test(value)
}

/** Normalize a stored update mode; unknown/empty values become `manual`. */
export function normalizeUpdateMode(value: unknown): PackCenterUpdateMode {
  return value === 'download' || value === 'patch_auto' ? value : 'manual'
}

/** Rebuild a policy from untrusted storage, dropping invalid keys and modes. */
export function normalizeUpdatePolicy(value: unknown): PackCenterUpdatePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const row = value as { mode?: unknown; perPack?: unknown }
  const perPack: Record<string, PackCenterUpdateMode> = {}
  if (row.perPack && typeof row.perPack === 'object' && !Array.isArray(row.perPack)) {
    for (const [key, mode] of Object.entries(row.perPack as Record<string, unknown>)) {
      if (isValidPolicyPackKey(key)) perPack[key] = normalizeUpdateMode(mode)
    }
  }
  return {
    ...(row.mode === undefined ? {} : { mode: normalizeUpdateMode(row.mode) }),
    ...(Object.keys(perPack).length ? { perPack } : {}),
  }
}

/** Effective mode for one pack: its override wins over the global default. */
export function resolveUpdateMode(policy: PackCenterUpdatePolicy | undefined, packId: string): PackCenterUpdateMode {
  const override = policy?.perPack && Object.hasOwn(policy.perPack, packId)
    ? normalizeUpdateMode(policy.perPack[packId])
    : undefined
  return override ?? normalizeUpdateMode(policy?.mode)
}
