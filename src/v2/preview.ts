/**
 * Read-only Domain Pack preview surface — Phase 1 §11 exit criterion
 * 「设置页只读预览校验」.
 *
 * Pure host logic behind `GET /plugins/dsh-expert-library/packs`: discovers
 * pack sources (the builtin `zhijian-realestate` pack plus workspace
 * `domain-packs/` directories under every registered workspace/session cwd),
 * validates each through the V2 validator/loader, and projects the read-only
 * wire payloads (summaries and the per-pack preview with full diagnostics).
 *
 * Everything here is read-only: no writes, no caches, no secrets, and the
 * wire summaries never carry full persona/profile prose — only ids, versions,
 * provenance and collection counts, so the settings page can show health and
 * size without leaking expert details.
 * @module dsh-expert-library/v2/preview
 */

import type { Context } from '@deepseek-ai/cordis'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isSafeKnowledgeId } from '../knowledge.ts'
import {
  loadPackFromDir,
  packFromJson,
  type LoadedPack,
  type PackLayer,
  type PackSourceInfo,
} from './pack-loader.ts'
import { SCHEMA_VERSION, type PackDiagnostic } from './types.ts'
import {
  buildZhijianDomainPack,
  ZHIJIAN_PACK_ID,
  ZHIJIAN_PACK_SNAPSHOT,
} from './zhijian-pack.ts'

/** Default subdirectory under a workspace root where domain packs live. */
export const DEFAULT_PACKS_DIR = 'domain-packs'

/** Web-server service key candidates, newest first (mirrors src/index.ts). */
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'] as const
/** Session store service key candidates, newest first (mirrors src/index.ts). */
const SESSION_KEYS = ['sessions'] as const

/** Source provenance of the builtin generated pack. */
export const BUILTIN_PACK_SOURCE: PackSourceInfo = {
  layer: 'builtin',
  label: `builtin/${ZHIJIAN_PACK_ID}`,
}

/** Pack summary counts: one number per DomainPackV2 collection. */
export interface DomainPackCounts {
  readonly experts: number
  readonly scenarios: number
  readonly teamTemplates: number
  readonly outputTemplates: number
  readonly qualityPolicies: number
  readonly toolProviders: number
  readonly knowledgeProviders: number
  readonly domainKnowledge: number
  readonly methodPacks: number
  readonly skillPackages: number
}

/** One row of the pack list. Read-only; never carries secrets or full profile prose. */
export interface PackSummary {
  readonly id: string
  readonly version: string
  readonly schemaVersion: number
  readonly name: string
  readonly description?: string
  readonly layer: PackLayer
  readonly label: string
  readonly root?: string
  /** Build-time snapshot id (builtin packs only, e.g. `zhijian-v1-2026-08-19`). */
  readonly snapshot?: string
  /** Whether validation found no error-severity diagnostics. */
  readonly ok: boolean
  readonly errorCount: number
  readonly warningCount: number
  readonly counts: DomainPackCounts
}

/** Wire body of the pack list response. */
export interface DomainPacksResponse {
  readonly packs: readonly PackSummary[]
}

/** Wire body of the per-pack preview response (mirrors ValidationResult/LoadedPack). */
export interface DomainPackPreviewResponse {
  /** True only when no error-severity diagnostics exist. */
  readonly ok: boolean
  /** Present only when `ok` (mirrors `ValidationResult.value` / `LoadedPack.pack`). */
  readonly pack?: PackSummary
  /** Every loader/validator finding, verbatim (code/path/message/severity). */
  readonly diagnostics: readonly PackDiagnostic[]
  /** ISO timestamp of this validation run. */
  readonly evaluatedAt: string
}

/** One discovered pack: its wire summary plus the loaded (validated) record. */
export interface PackSourceResult {
  readonly summary: PackSummary
  readonly loaded: LoadedPack
}

/** Zero counts for a pack that failed validation (nothing to count). */
function zeroCounts(): DomainPackCounts {
  return {
    experts: 0,
    scenarios: 0,
    teamTemplates: 0,
    outputTemplates: 0,
    qualityPolicies: 0,
    toolProviders: 0,
    knowledgeProviders: 0,
    domainKnowledge: 0,
    methodPacks: 0,
    skillPackages: 0,
  }
}

/** Count the ten DomainPackV2 collections of a validated pack. */
function countsOf(pack: LoadedPack['pack']): DomainPackCounts {
  if (pack === undefined) return zeroCounts()
  return {
    experts: pack.experts.length,
    scenarios: pack.scenarios.length,
    teamTemplates: pack.teamTemplates.length,
    outputTemplates: pack.outputTemplates.length,
    qualityPolicies: pack.qualityPolicies.length,
    toolProviders: pack.toolProviders.length,
    knowledgeProviders: pack.knowledgeProviders.length,
    domainKnowledge: pack.domainKnowledge.length,
    methodPacks: pack.methodPacks.length,
    skillPackages: pack.skillPackages.length,
  }
}

/** Error/warning counts over a diagnostic list. */
function severityCounts(diagnostics: readonly PackDiagnostic[]): { errors: number; warnings: number } {
  let errors = 0
  let warnings = 0
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') errors += 1
    else if (diagnostic.severity === 'warning') warnings += 1
  }
  return { errors, warnings }
}

/**
 * Best-effort pack id for a loaded record that failed validation: the pack
 * meta is unavailable, so fall back to the source root basename (workspace
 * packs are one dir per id) or the label's last segment (e.g.
 * `domain-packs/zhijian-realestate` → `zhijian-realestate`).
 */
function fallbackIdOf(loaded: LoadedPack): string {
  const root = loaded.source.root
  if (root !== undefined && root !== '') return basename(root)
  return loaded.source.label.split('/').pop() ?? loaded.source.label
}

/**
 * Project one loaded pack into its read-only wire summary. `extra.snapshot`
 * supplies the build-time snapshot id for the builtin pack (not part of the
 * PackMeta schema).
 */
export function summarizePack(loaded: LoadedPack, extra: { readonly snapshot?: string } = {}): PackSummary {
  const pack = loaded.pack
  const id = pack?.pack.id ?? fallbackIdOf(loaded)
  const { errors, warnings } = severityCounts(loaded.diagnostics)
  const description = pack?.pack.description
  return {
    id,
    version: pack?.pack.version ?? '',
    schemaVersion: pack?.pack.schemaVersion ?? SCHEMA_VERSION,
    name: pack?.pack.name ?? id,
    ...(description !== undefined ? { description } : {}),
    layer: loaded.source.layer,
    label: loaded.source.label,
    ...(loaded.source.root !== undefined ? { root: loaded.source.root } : {}),
    ...(extra.snapshot !== undefined ? { snapshot: extra.snapshot } : {}),
    ok: loaded.ok,
    errorCount: errors,
    warningCount: warnings,
    counts: countsOf(pack),
  }
}

/** Load the builtin generated pack (in-memory, deterministic, no I/O). */
export function builtinLoadedPack(): LoadedPack {
  return packFromJson(buildZhijianDomainPack(), BUILTIN_PACK_SOURCE)
}

/**
 * Structural slice of the host sessions service (duck-typed, same shape as
 * src/index.ts's `SessionsSlice`; kept local so this module stays
 * self-contained and does not import the plugin entry).
 */
interface SessionsSlice {
  list(): Array<{ header: { cwd?: string } }>
}

/**
 * Every candidate workspace root: registered workspace paths plus every live
 * session's cwd (a session may run outside any registered workspace).
 */
export function workspaceRootsOf(ctx: Context): string[] {
  const sessions = ctx.get(SESSION_KEYS[0]) as SessionsSlice | undefined
  const workspaceRegistry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1])) as
    | { list(): Array<{ path: string }> }
    | undefined
  const roots = new Set<string>()
  for (const workspace of workspaceRegistry?.list() ?? []) roots.add(workspace.path)
  for (const session of sessions?.list() ?? []) {
    const cwd = session.header.cwd
    if (cwd !== undefined) roots.add(cwd)
  }
  return [...roots]
}

/** One discovered pack directory under a workspace root. */
export interface PackDir {
  readonly dir: string
  /** Source label, e.g. `domain-packs/zhijian-realestate`. */
  readonly label: string
}

/**
 * List pack directories under one base root: `<base>/<packsDir>/<id>/`, where
 * `<id>` must be a SafeId (no separators, no traversal). A missing packs dir
 * is skipped silently; non-directory and unsafe entries are ignored.
 */
export async function discoverPackDirsIn(base: string, packsDir: string): Promise<readonly PackDir[]> {
  const root = join(base, packsDir)
  const out: PackDir[] = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!isSafeKnowledgeId(entry.name)) continue
    out.push({ dir: join(root, entry.name), label: `${packsDir}/${entry.name}` })
  }
  return out
}

/** List pack directories across every workspace root, first hit per dir wins. */
export async function discoverPackDirs(ctx: Context, packsDir: string = DEFAULT_PACKS_DIR): Promise<readonly PackDir[]> {
  const out: PackDir[] = []
  const seen = new Set<string>()
  for (const workspace of workspaceRootsOf(ctx)) {
    for (const item of await discoverPackDirsIn(workspace, packsDir)) {
      if (seen.has(item.dir)) continue
      seen.add(item.dir)
      out.push(item)
    }
  }
  return out
}

/**
 * Load and validate every discoverable pack: the builtin pack first, then each
 * workspace pack directory (loader + validator diagnostics combined).
 */
export async function listPackSources(ctx: Context, packsDir: string = DEFAULT_PACKS_DIR): Promise<PackSourceResult[]> {
  const results: PackSourceResult[] = []
  const builtin = builtinLoadedPack()
  results.push({ summary: summarizePack(builtin, { snapshot: ZHIJIAN_PACK_SNAPSHOT }), loaded: builtin })
  for (const { dir, label } of await discoverPackDirs(ctx, packsDir)) {
    // The loader realpaths the directory and records it as `source.root`.
    const loaded = await loadPackFromDir(dir, { layer: 'workspace', label })
    results.push({ summary: summarizePack(loaded), loaded })
  }
  return results
}

/** Read-only pack list for the settings page (health badge + counts per pack). */
export async function listDomainPacks(ctx: Context, packsDir: string = DEFAULT_PACKS_DIR): Promise<DomainPacksResponse> {
  const sources = await listPackSources(ctx, packsDir)
  return { packs: sources.map((source) => source.summary) }
}

/**
 * Read-only preview + validation detail for one pack id.
 *
 * @returns `undefined` when the id is not a SafeId or no pack resolves to it
 *   (the route maps that to 400 vs 404 itself); otherwise the preview payload.
 */
export async function previewDomainPack(
  ctx: Context,
  id: string,
  packsDir: string = DEFAULT_PACKS_DIR,
): Promise<DomainPackPreviewResponse | undefined> {
  if (!isSafeKnowledgeId(id)) return undefined
  const found = (await listPackSources(ctx, packsDir)).find(({ summary }) => summary.id === id)
  if (found === undefined) return undefined
  return {
    ok: found.loaded.ok,
    pack: found.loaded.ok ? found.summary : undefined,
    diagnostics: found.loaded.diagnostics,
    evaluatedAt: new Date().toISOString(),
  }
}
