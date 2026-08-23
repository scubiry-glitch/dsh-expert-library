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
  /** Member subagent provider name (`spawn` or `fork`). */
  memberProvider?: string
  /** Member delegation depth cap; `0` forbids delegation. */
  memberMaxDepth?: number
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

/**
 * Schema resolving the expert-library settings namespace. Mirrors the plugin
 * `Config` shape (the entry config is the composition `base` layer); fields are
 * optional here so a settings provider may serve a partial section.
 */
export const ExpertLibrarySettingsSchema: z<ExpertLibrarySettings> = z.object({
  stateDir: z.string(),
  knowledgeDir: z.string(),
  packsDir: z.string(),
  memberProvider: z.string(),
  memberMaxDepth: z.natural(),
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
