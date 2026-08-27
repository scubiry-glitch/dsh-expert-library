/**
 * Phase 1 local Domain Pack / SkillPackage loader (`pack-loader`).
 *
 * Zero-network loading of {@link DomainPackV2} from a local JSON file or a
 * directory layout, deterministic overlay merging with the canonical
 * precedence `builtin < domain-pack < workspace < request`, and local
 * SkillPackage loading with SHA-256 digest re-verification.
 *
 * Hard constraints implemented here (NEXT-GENERATION-ARCHITECTURE.md §3.7,
 * §7.3, §11 Phase 1):
 *
 * - **no network**: every read is a local file read; `upstreamProvenance`
 *   stays an audit-only string and is never contacted.
 * - **path containment**: every path derived from data (section file names,
 *   skill roots, lazy media, exec scripts) is checked against safe-id /
 *   safe-relative rules, and every filesystem object resolved from a
 *   manifest is `realpath`-verified to stay under its base directory —
 *   a symlink escaping the base is rejected.
 * - **validated**: every assembled pack runs through `validateDomainPack`.
 *   Contribution cross-validation is that validator's job (already
 *   implemented in `validate.ts`) — this loader verifies *local integrity*
 *   (roots, digest, lazy media, script declarations).
 * - **scripts are declarations only**: `permissions.execScripts` are
 *   surfaced as metadata (path / existence / bytes / sha256) and **never
 *   executed**.
 *
 * Pure where possible: `packFromJson`, `mergePackLayers`, version and path
 * helpers have no I/O; only the directory / file / skill loaders touch the
 * filesystem.
 * @module dsh-expert-library/v2/pack-loader
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { isSafeKnowledgeId } from '../knowledge.ts'
import { validateDomainPack } from './validate.ts'
import type { DomainPackV2, PackDiagnostic, PackMeta, SkillPackageManifest } from './types.ts'

/** Diagnostic collector with the same shape rules as `validate.ts`. */
class Diagnostics {
  readonly items: PackDiagnostic[] = []

  add(code: string, path: string, message: string, severity: PackDiagnostic['severity'] = 'error'): void {
    this.items.push({ code, path, message, severity })
  }

  get hasErrors(): boolean {
    return this.items.some(item => item.severity === 'error')
  }
}

/** Whether a parsed JSON value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether an error is a missing-file error (ENOENT). */
function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

// --- Path safety -----------------------------------------------------------

/**
 * Whether a relative path is safe to join under a base directory: no
 * absolute prefix, no drive letter, no `..`, and every segment must be a
 * safe path segment (the same rule the validator applies to skill roots and
 * knowledge collection roots).
 */
export function isSafeRelativePath(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.startsWith('\\') || value.includes('..') || value.includes(':')) {
    return false
  }
  return value.split(/[/\\]/).every(segment => segment !== '' && isSafeKnowledgeId(segment))
}

/**
 * Resolve a data-derived relative path under a base directory and verify by
 * `realpath` that the target stays inside the base (symlink escapes are
 * rejected). Throws when the path is unsafe, does not exist, or escapes.
 */
export async function resolveInside(base: string, relative: string): Promise<string> {
  if (!isSafeRelativePath(relative)) {
    throw new Error(`unsafe relative path "${relative}"`)
  }
  const baseReal = await realpath(base)
  const candidate = resolve(baseReal, relative)
  const candidateReal = await realpath(candidate)
  if (candidateReal !== baseReal && !candidateReal.startsWith(baseReal + sep)) {
    throw new Error(`path "${relative}" escapes base "${baseReal}"`)
  }
  return candidateReal
}

/** Outcome of an optional contained resolution (used for section probing). */
export type ResolveOptionalResult =
  | { readonly kind: 'ok'; readonly path: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'rejected'; readonly message: string }

/**
 * Like {@link resolveInside}, but for optional paths: a missing target is
 * reported as `missing` — ENOENT is not an error here, sections are optional
 * and simply absent. An unsafe path, an unresolvable base, or a path whose
 * `realpath` lands outside the base (a symlinked file/directory escape) is
 * `rejected` with a message, so callers can emit a structured diagnostic
 * instead of reading from outside the base.
 */
export async function resolveInsideOptional(base: string, relative: string): Promise<ResolveOptionalResult> {
  if (!isSafeRelativePath(relative)) {
    return { kind: 'rejected', message: `unsafe relative path "${relative}"` }
  }
  let baseReal: string
  try {
    baseReal = await realpath(base)
  } catch (error: unknown) {
    return { kind: 'rejected', message: `base "${base}" cannot be resolved: ${String(error)}` }
  }
  const candidate = resolve(baseReal, relative)
  let candidateReal: string
  try {
    candidateReal = await realpath(candidate)
  } catch (error: unknown) {
    if (isEnoent(error)) return { kind: 'missing' }
    return { kind: 'rejected', message: `"${relative}" cannot be resolved under "${baseReal}": ${String(error)}` }
  }
  if (candidateReal !== baseReal && !candidateReal.startsWith(baseReal + sep)) {
    return { kind: 'rejected', message: `"${relative}" escapes base "${baseReal}" (resolves to "${candidateReal}")` }
  }
  return { kind: 'ok', path: candidateReal }
}

// --- Hashing ---------------------------------------------------------------

/** SHA-256 hex digest of a string or raw bytes. */
export function sha256Of(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Deterministic whole-tree SHA-256 digest: every regular file under `root`
 * (sorted by relative path, symlinks never followed) contributes
 * `sha256(relPath + NUL + raw content)`, and the final digest is
 * `sha256(concat of per-file digests in sorted order)`. `exclude` removes
 * relative paths from the set (typically the manifest file that carries the
 * digest itself, so re-verification is not circular).
 */
export async function hashPackageTree(
  root: string,
  options: { readonly exclude?: readonly string[] } = {},
): Promise<string> {
  const excludes = new Set(options.exclude ?? [])
  const files = await listFiles(root)
  const digests: string[] = []
  for (const rel of files) {
    if (excludes.has(rel)) continue
    const content = await readFile(join(root, rel))
    digests.push(createHash('sha256').update(rel, 'utf8').update('\u0000').update(content).digest('hex'))
  }
  return sha256Of(digests.join(''))
}

/**
 * Deterministic canonical JSON serialization: object keys are recursively
 * sorted, so two manifest files with identical content but different key
 * orders hash identically; arrays keep their order (ordered by definition).
 * Only JSON-safe values are expected (parsed JSON); `undefined` is not
 * valid JSON and is serialized as `null` for determinism.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(',')}]`
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return value === undefined ? 'null' : JSON.stringify(value)
}

/**
 * SHA-256 over the canonical serialization of a skill manifest with
 * `source.digest` omitted — the digest field cannot be part of the very
 * digest it carries, so it is normalized away before hashing.
 */
export function canonicalManifestDigest(manifest: Record<string, unknown>): string {
  const copy: Record<string, unknown> = { ...manifest }
  if (isRecord(copy['source'])) {
    const source = { ...(copy['source'] as Record<string, unknown>) }
    delete source['digest']
    copy['source'] = source
  }
  return sha256Of(canonicalJson(copy))
}

/** Options for {@link canonicalSkillDigest}. */
export interface CanonicalSkillDigestOptions {
  /** Manifest file name excluded from the tree part; defaults to `skill.json`. */
  readonly manifestName?: string
}

/**
 * The canonical package digest {@link loadSkillPackageFromDir} verifies:
 * `sha256(treeDigest + NUL + manifestDigest)` where
 * - `treeDigest` = {@link hashPackageTree} over the package content with the
 *   manifest file itself excluded (so re-verification is not circular);
 * - `manifestDigest` = {@link canonicalManifestDigest} over the parsed
 *   manifest with `source.digest` omitted and all keys canonicalized.
 *
 * Because the manifest participates, editing `contributions`,
 * `permissions`, `source.root`/`kind`/`license` (or any other manifest
 * field) without updating `source.digest` is detected as a mismatch — a
 * tree-only digest could not catch that. Deterministic and network-free:
 * same files + same manifest content ⇒ same digest, regardless of JSON key
 * order.
 */
export async function canonicalSkillDigest(
  dir: string,
  manifest: Record<string, unknown>,
  options: CanonicalSkillDigestOptions = {},
): Promise<string> {
  const manifestName = options.manifestName ?? DEFAULT_SKILL_MANIFEST_NAMES[0] ?? 'skill.json'
  const tree = await hashPackageTree(dir, { exclude: [manifestName] })
  const manifestDigest = canonicalManifestDigest(manifest)
  return sha256Of(`${tree}\u0000${manifestDigest}`)
}

/** List regular files under a root as sorted, posix-separated relative paths. */
async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(root, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      out.push(...await listFiles(join(root, entry.name), rel))
    } else if (entry.isFile()) {
      out.push(rel)
    }
    // symlinks and other entry kinds are skipped — never followed
  }
  return out
}

// --- Version comparison ----------------------------------------------------

// semver core + optional prerelease (-) and build (+) parts. Build metadata
// participates in matching but not in precedence (ignored below).
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Whether a prerelease identifier is purely numeric (numeric < alphanumeric). */
function isNumericIdentifier(value: string): boolean {
  return /^[0-9]+$/.test(value)
}

/**
 * Compare two prerelease parts (already split at the `-`), or one vs
 * absence. Semver §11: a version with a prerelease has lower precedence
 * than the same version without; identifiers compare dot by dot, numeric
 * identifiers numerically and numeric < alphanumeric, alphanumeric
 * lexically in ASCII order; a longer prerelease list outranks a shorter
 * one when all preceding identifiers are equal.
 */
function comparePrerelease(a: string | undefined, b: string | undefined): -1 | 0 | 1 {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1 // stable > prerelease
  if (b === undefined) return -1
  const aIds = a.split('.')
  const bIds = b.split('.')
  const length = Math.max(aIds.length, bIds.length)
  for (let i = 0; i < length; i++) {
    const x = aIds[i]
    const y = bIds[i]
    if (x === undefined) return -1 // a ran out first ⇒ a < b
    if (y === undefined) return 1 // b ran out first ⇒ a > b
    const xNumeric = isNumericIdentifier(x)
    const yNumeric = isNumericIdentifier(y)
    if (xNumeric && yNumeric) {
      const xn = Number(x)
      const yn = Number(y)
      if (xn !== yn) return xn < yn ? -1 : 1
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1 // numeric < alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1 // ASCII lexical order
    }
  }
  return 0
}

/**
 * Compare two semver-shaped versions: core (major.minor.patch) numerically,
 * then prerelease per semver §11 (stable > prerelease; dot identifiers
 * numeric-vs-numeric numerically, numeric < alphanumeric, alphanumeric in
 * ASCII order; longer list > shorter when prefixes are equal). Build
 * metadata is ignored. Returns `undefined` when either string is not
 * semver-shaped (the caller then skips downgrade detection instead of
 * guessing). Only consumed by overlay downgrade diagnostics.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const ma = SEMVER.exec(a)
  const mb = SEMVER.exec(b)
  if (ma === null || mb === null) return undefined
  for (let i = 1; i <= 3; i++) {
    const x = Number(ma[i])
    const y = Number(mb[i])
    if (x !== y) return x < y ? -1 : 1
  }
  return comparePrerelease(ma[4], mb[4])
}

// --- Pack loading (pure + file) ---------------------------------------------

/** Precedence layer of a pack source (§2.1 overlay semantics). */
export type PackLayer = 'builtin' | 'domain-pack' | 'workspace' | 'request'

/** Canonical overlay precedence, lowest first. */
export const OVERLAY_LAYER_ORDER: readonly PackLayer[] = ['builtin', 'domain-pack', 'workspace', 'request']

/** Rank of a layer in the canonical order; unknown layers sort last. */
export function layerRank(layer: PackLayer): number {
  const index = OVERLAY_LAYER_ORDER.indexOf(layer)
  return index === -1 ? OVERLAY_LAYER_ORDER.length : index
}

/** Where a loaded pack came from. */
export interface PackSourceInfo {
  readonly layer: PackLayer
  /** Human label, e.g. `domain-packs/zhijian-realestate`. */
  readonly label: string
  /** Absolute filesystem root when loaded from disk. */
  readonly root?: string
}

/** One loaded (and validated) pack plus its provenance. */
export interface LoadedPack {
  /** The validated pack; present only when `ok`. */
  readonly pack?: DomainPackV2
  readonly source: PackSourceInfo
  readonly diagnostics: readonly PackDiagnostic[]
  readonly ok: boolean
}

/**
 * Validate an already-parsed pack value (pure, no I/O). This is
 * `validateDomainPack` plus provenance bookkeeping — the single entry point
 * for in-memory pack objects.
 */
export function packFromJson(json: unknown, source: PackSourceInfo): LoadedPack {
  const result = validateDomainPack(json)
  return {
    pack: result.ok ? result.value : undefined,
    source,
    diagnostics: result.diagnostics,
    ok: result.ok,
  }
}

/** Options for {@link loadPackFromFile}. */
export interface PackFileLoadOptions {
  /**
   * When set, the pack file must resolve (by `realpath`) inside this
   * directory — a file outside it, or a symlink resolving outside it, is
   * rejected with a `file-escape` diagnostic. The root must exist.
   */
  readonly allowedRoot?: string
}

/**
 * Load and validate a complete pack from a single local JSON file.
 *
 * The file is `realpath`-resolved before reading, so a symlinked file is
 * verified rather than trusted; with `allowedRoot` set, the resolved path
 * must stay inside that directory (containment by realpath, symlink escapes
 * rejected). A missing file is reported as `file-missing`.
 */
export async function loadPackFromFile(
  file: string,
  source?: Omit<PackSourceInfo, 'root'>,
  options: PackFileLoadOptions = {},
): Promise<LoadedPack> {
  const root = resolve(file)
  let real: string
  try {
    real = await realpath(root)
  } catch (error: unknown) {
    return {
      pack: undefined,
      source: { layer: source?.layer ?? 'domain-pack', label: source?.label ?? root, root },
      diagnostics: [{ code: 'file-missing', path: 'pack', message: `pack file "${root}" does not exist: ${String(error)}`, severity: 'error' }],
      ok: false,
    }
  }
  if (options.allowedRoot !== undefined) {
    let baseReal: string
    try {
      baseReal = await realpath(options.allowedRoot)
    } catch (error: unknown) {
      return {
        pack: undefined,
        source: { layer: source?.layer ?? 'domain-pack', label: source?.label ?? root, root },
        diagnostics: [{ code: 'allowed-root-missing', path: 'pack', message: `allowed root "${options.allowedRoot}" does not exist: ${String(error)}`, severity: 'error' }],
        ok: false,
      }
    }
    if (real !== baseReal && !real.startsWith(baseReal + sep)) {
      return {
        pack: undefined,
        source: { layer: source?.layer ?? 'domain-pack', label: source?.label ?? root, root },
        diagnostics: [{ code: 'file-escape', path: 'pack', message: `pack file "${root}" escapes allowed root "${baseReal}" (resolves to "${real}")`, severity: 'error' }],
        ok: false,
      }
    }
  }
  let json: unknown
  try {
    json = JSON.parse(await readFile(real, 'utf8'))
  } catch (error: unknown) {
    return {
      pack: undefined,
      source: { layer: source?.layer ?? 'domain-pack', label: source?.label ?? root, root },
      diagnostics: [{ code: 'json-parse-error', path: 'pack', message: `pack file "${root}" is not valid JSON: ${String(error)}`, severity: 'error' }],
      ok: false,
    }
  }
  return packFromJson(json, { layer: source?.layer ?? 'domain-pack', label: source?.label ?? root, root })
}

// --- Directory layout loading ------------------------------------------------

/**
 * Section directory names accepted per DomainPackV2 collection key. Both the
 * camelCase key and its kebab-case form are accepted (the §7.3 layout uses
 * kebab names like `team-templates`).
 */
const PACK_SECTIONS: ReadonlyArray<readonly [key: string, dirs: readonly string[]]> = [
  ['experts', ['experts']],
  ['teamTemplates', ['teamTemplates', 'team-templates']],
  ['outputTemplates', ['outputTemplates', 'output-templates']],
  ['qualityPolicies', ['qualityPolicies', 'quality-policies']],
  ['scenarios', ['scenarios']],
  ['toolProviders', ['toolProviders', 'tool-providers']],
  ['knowledgeProviders', ['knowledgeProviders', 'knowledge-providers']],
  ['domainKnowledge', ['domainKnowledge', 'domain-knowledge']],
  ['methodPacks', ['methodPacks', 'method-packs']],
  ['skillPackages', ['skillPackages', 'skill-packages']],
] as const

/** Parse one JSON file, reporting a diagnostic instead of throwing. */
async function parseJsonFile(file: string, diags: Diagnostics, path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error: unknown) {
    diags.add('json-parse-error', path, `file "${file}" is not valid JSON: ${String(error)}`)
    return undefined
  }
}

/** Read one section: `<root>/<sectionDir>/` (index.json or one file per entity)
 * or `<root>/<sectionDir>.json` (a single array). The first form found wins.
 *
 * Every path touched is `realpath`-verified to stay inside the pack root: a
 * section directory, `index.json`, an entity file or the array file that
 * resolves (directly or through a symlink) outside the root is rejected with
 * a `symlink-escape` diagnostic instead of being read. Missing sections are
 * simply skipped — ENOENT is not an error, sections are optional. */
async function readSection(
  diags: Diagnostics,
  root: string,
  key: string,
  sectionDirs: readonly string[],
): Promise<unknown[]> {
  for (const sectionDir of sectionDirs) {
    // Directory form: `<root>/<sectionDir>/` — must be realpath-contained.
    const folderResult = await resolveInsideOptional(root, sectionDir)
    if (folderResult.kind === 'rejected') {
      diags.add('symlink-escape', `pack.${key}`, `section directory "${sectionDir}" does not stay inside the pack root: ${folderResult.message}`)
      continue
    }
    if (folderResult.kind === 'ok') {
      const folder = folderResult.path
      let folderStat
      try {
        folderStat = await stat(folder)
      } catch (error: unknown) {
        if (!isEnoent(error)) throw error
        folderStat = undefined
      }
      if (folderStat?.isDirectory() === true) {
        // index.json, when present — contained.
        const indexResult = await resolveInsideOptional(root, `${sectionDir}/index.json`)
        if (indexResult.kind === 'rejected') {
          diags.add('symlink-escape', `pack.${key}`, `section index "${sectionDir}/index.json" does not stay inside the pack root: ${indexResult.message}`)
          return []
        }
        let indexJson: unknown
        if (indexResult.kind === 'ok') {
          try {
            indexJson = JSON.parse(await readFile(indexResult.path, 'utf8'))
          } catch (error: unknown) {
            diags.add('json-parse-error', `pack.${key}`, `section index "${sectionDir}/index.json" is not valid JSON: ${String(error)}`)
            return []
          }
          if (Array.isArray(indexJson)) return indexJson
        }
        // one file per entity — every entity file resolves inside the root
        // (regular files and symlinks both pass through realpath containment).
        const entities: unknown[] = []
        const entries = await readdir(folder, { withFileTypes: true })
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        for (const entry of entries) {
          if (entry.isDirectory() || (!entry.isFile() && !entry.isSymbolicLink())) continue
          if (!entry.name.endsWith('.json') || entry.name === 'index.json') continue
          const stem = entry.name.slice(0, -'.json'.length)
          if (stem === '' || !isSafeKnowledgeId(stem)) {
            diags.add('unsafe-file-name', `pack.${key}`, `section file "${entry.name}" is not a safe id (letters/digits, ._- inside, ≤64 chars)`)
            continue
          }
          const rel = `${sectionDir}/${entry.name}`
          const fileResult = await resolveInsideOptional(root, rel)
          if (fileResult.kind === 'rejected') {
            diags.add('symlink-escape', `pack.${key}.${stem}`, `section file "${rel}" does not stay inside the pack root: ${fileResult.message}`)
            continue
          }
          if (fileResult.kind === 'missing') continue // removed between readdir and resolve
          const value = await parseJsonFile(fileResult.path, diags, `pack.${key}.${stem}`)
          if (value === undefined) continue
          if (isRecord(value) && typeof value['id'] === 'string' && value['id'] !== stem) {
            diags.add('filename-id-mismatch', `pack.${key}.${stem}.id`, `entity id "${value['id']}" does not match its file name "${stem}"`, 'warning')
          }
          entities.push(value)
        }
        return entities
      }
    }
    // Array-file form: `<root>/<sectionDir>.json` — contained.
    const arrayResult = await resolveInsideOptional(root, `${sectionDir}.json`)
    if (arrayResult.kind === 'rejected') {
      diags.add('symlink-escape', `pack.${key}`, `section file "${sectionDir}.json" does not stay inside the pack root: ${arrayResult.message}`)
      continue
    }
    if (arrayResult.kind === 'ok') {
      let arrayStat
      try {
        arrayStat = await stat(arrayResult.path)
      } catch (error: unknown) {
        if (!isEnoent(error)) throw error
        arrayStat = undefined
      }
      if (arrayStat?.isFile() === true) {
        const value = await parseJsonFile(arrayResult.path, diags, `pack.${key}`)
        if (Array.isArray(value)) return value
        if (value !== undefined) {
          diags.add('invalid-shape', `pack.${key}`, `section file "${sectionDir}.json" must contain a JSON array`)
        }
        return []
      }
    }
    // both forms absent for this candidate → try the next sectionDir
  }
  return []
}

/**
 * Assemble and validate a {@link DomainPackV2} from a directory layout.
 *
 * Two representations are accepted:
 * - `pack.json` is a complete pack object (`pack` + all section arrays) —
 *   used directly;
 * - `pack.json` is just the pack metadata (id/version/name/…) and each
 *   section is a subdirectory (`<id>.json` per entity, or `index.json` as
 *   an array) or a single `<section>.json` array file. Missing sections
 *   default to empty arrays.
 *
 * All section file names must be safe ids; entity ids that do not match
 * their file name produce a warning. Every file and directory read under
 * the root — `pack.json`, section directories, section JSON and entity
 * JSON — is `realpath`-verified to stay inside the pack root; a symlinked
 * file or directory escaping the root is rejected with a `symlink-escape`
 * diagnostic (never read). The assembled pack is validated with
 * `validateDomainPack`; diagnostics combine loader findings and validator
 * findings.
 */
export async function loadPackFromDir(
  dir: string,
  source?: Omit<PackSourceInfo, 'root'>,
): Promise<LoadedPack> {
  let root: string
  try {
    root = await realpath(dir)
  } catch (error: unknown) {
    return {
      pack: undefined,
      source: { layer: source?.layer ?? 'domain-pack', label: source?.label ?? dir },
      diagnostics: [{ code: 'pack-root-missing', path: 'pack', message: `pack directory "${dir}" does not exist: ${String(error)}`, severity: 'error' }],
      ok: false,
    }
  }
  const diags = new Diagnostics()

  // pack.json: either the full pack or the pack metadata — contained.
  const packFileResult = await resolveInsideOptional(root, 'pack.json')
  if (packFileResult.kind === 'rejected') {
    // A pack root whose metadata file escapes is compromised — reject the
    // whole load with the structured diagnostic and read nothing further.
    diags.add('symlink-escape', 'pack.pack', `pack.json does not stay inside the pack root: ${packFileResult.message}`)
    return {
      pack: undefined,
      source: { layer: source?.layer ?? 'domain-pack', label: source?.label ?? root, root },
      diagnostics: diags.items,
      ok: false,
    }
  }
  let packJson: unknown
  if (packFileResult.kind === 'missing') {
    diags.add('pack-meta-missing', 'pack.pack', `pack directory "${root}" has no pack.json`)
  } else {
    try {
      packJson = JSON.parse(await readFile(packFileResult.path, 'utf8'))
    } catch (error: unknown) {
      diags.add('json-parse-error', 'pack.pack', `pack.json is not valid JSON: ${String(error)}`)
    }
  }

  let assembled: Record<string, unknown>
  if (isRecord(packJson) && isRecord(packJson['pack'])) {
    // Full-pack form: pack.json carries pack meta + every section array.
    assembled = { ...packJson }
    // Section directories are ignored in this form (single-file representation).
  } else {
    assembled = { pack: packJson ?? undefined }
    for (const [key, sectionDirs] of PACK_SECTIONS) {
      assembled[key] = await readSection(diags, root, key, sectionDirs)
    }
  }

  const validation = validateDomainPack(assembled)
  diags.items.push(...validation.diagnostics)
  const ok = !diags.hasErrors
  return {
    pack: ok ? validation.value : undefined,
    source: { layer: source?.layer ?? 'domain-pack', label: source?.label ?? root, root },
    diagnostics: diags.items,
    ok,
  }
}

/**
 * Synchronous twin of {@link loadPackFromDir} for **trusted, static pack
 * roots** — e.g. the committed `domain-packs/builtin-library/` projection
 * loaded by the process-wide V1 cache (whose public API is synchronous).
 *
 * Same accepted layouts (pack.json meta or full-pack form, section
 * directories with kebab/camel names, `index.json` or one file per entity,
 * `<section>.json` array files), same per-entity filename/id validation and
 * the same `validateDomainPack` gate — but plain synchronous reads and NO
 * realpath containment (the root is resolved from the module itself, never
 * from data, so symlink-escape checks are not applicable). A missing root
 * reports `pack-root-missing`; a present-but-invalid pack reports the loader
 * + validator diagnostics with `ok: false` (callers decide loud vs fallback).
 */
export function loadPackFromDirSync(
  dir: string,
  source?: Omit<PackSourceInfo, 'root'>,
): LoadedPack {
  const root = resolve(dir)
  const diags = new Diagnostics()
  const missingRoot: LoadedPack = {
    pack: undefined,
    source: { layer: source?.layer ?? 'domain-pack', label: source?.label ?? root },
    diagnostics: [{ code: 'pack-root-missing', path: 'pack', message: `pack directory "${root}" does not exist`, severity: 'error' }],
    ok: false,
  }
  try {
    if (!statSync(root).isDirectory()) return missingRoot
  } catch (error: unknown) {
    if (isEnoent(error)) return missingRoot
    throw error
  }

  let packJson: unknown
  try {
    packJson = JSON.parse(readFileSync(join(root, 'pack.json'), 'utf8'))
  } catch (error: unknown) {
    if (isEnoent(error)) {
      diags.add('pack-meta-missing', 'pack.pack', `pack directory "${root}" has no pack.json`)
    } else {
      diags.add('json-parse-error', 'pack.pack', `pack.json is not valid JSON: ${String(error)}`)
    }
  }

  let assembled: Record<string, unknown>
  if (isRecord(packJson) && isRecord(packJson['pack'])) {
    assembled = { ...packJson }
  } else {
    assembled = { pack: packJson ?? undefined }
    for (const [key, sectionDirs] of PACK_SECTIONS) {
      assembled[key] = readSectionSync(diags, root, key, sectionDirs)
    }
  }

  const validation = validateDomainPack(assembled)
  diags.items.push(...validation.diagnostics)
  const ok = !diags.hasErrors
  return {
    pack: ok ? validation.value : undefined,
    source: { layer: source?.layer ?? 'domain-pack', label: source?.label ?? root, root },
    diagnostics: diags.items,
    ok,
  }
}

/** Sync twin of {@link readSection} (trusted roots; no realpath containment). */
function readSectionSync(
  diags: Diagnostics,
  root: string,
  key: string,
  sectionDirs: readonly string[],
): unknown[] {
  for (const sectionDir of sectionDirs) {
    const folder = join(root, sectionDir)
    let folderStat
    try {
      folderStat = statSync(folder)
    } catch (error: unknown) {
      if (!isEnoent(error)) throw error
      folderStat = undefined
    }
    if (folderStat?.isDirectory() === true) {
      // index.json, when present.
      let indexJson: unknown
      try {
        indexJson = JSON.parse(readFileSync(join(folder, 'index.json'), 'utf8'))
      } catch (error: unknown) {
        if (!isEnoent(error)) {
          diags.add('json-parse-error', `pack.${key}`, `section index "${sectionDir}/index.json" is not valid JSON: ${String(error)}`)
          return []
        }
      }
      if (Array.isArray(indexJson)) return indexJson
      // one file per entity (sorted; filename == entity id, validated).
      const entities: unknown[] = []
      let entries: Dirent<string>[] = []
      try {
        entries = readdirSync(folder, { withFileTypes: true })
      } catch (error: unknown) {
        if (!isEnoent(error)) throw error
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const entry of entries) {
        if (entry.isDirectory() || (!entry.isFile() && !entry.isSymbolicLink())) continue
        if (!entry.name.endsWith('.json') || entry.name === 'index.json') continue
        const stem = entry.name.slice(0, -'.json'.length)
        if (stem === '' || !isSafeKnowledgeId(stem)) {
          diags.add('unsafe-file-name', `pack.${key}`, `section file "${entry.name}" is not a safe id (letters/digits, ._- inside, ≤64 chars)`)
          continue
        }
        let value: unknown
        try {
          value = JSON.parse(readFileSync(join(folder, entry.name), 'utf8'))
        } catch (error: unknown) {
          diags.add('json-parse-error', `pack.${key}.${stem}`, `file "${entry.name}" is not valid JSON: ${String(error)}`)
          continue
        }
        if (isRecord(value) && typeof value['id'] === 'string' && value['id'] !== stem) {
          diags.add('filename-id-mismatch', `pack.${key}.${stem}.id`, `entity id "${value['id']}" does not match its file name "${stem}"`, 'warning')
        }
        entities.push(value)
      }
      return entities
    }
    // Array-file form: `<root>/<sectionDir>.json`.
    let arrayStat
    try {
      arrayStat = statSync(join(root, `${sectionDir}.json`))
    } catch (error: unknown) {
      if (!isEnoent(error)) throw error
      arrayStat = undefined
    }
    if (arrayStat?.isFile() === true) {
      let value: unknown
      try {
        value = JSON.parse(readFileSync(join(root, `${sectionDir}.json`), 'utf8'))
      } catch (error: unknown) {
        diags.add('json-parse-error', `pack.${key}`, `section file "${sectionDir}.json" is not valid JSON: ${String(error)}`)
        return []
      }
      if (Array.isArray(value)) return value
      if (value !== undefined) {
        diags.add('invalid-shape', `pack.${key}`, `section file "${sectionDir}.json" must contain a JSON array`)
      }
      return []
    }
  }
  return []
}

// --- Overlay merging ---------------------------------------------------------

/** A pack contributed as a merge layer (precedence defaults to `request`). */
export interface PackLayerInput {
  readonly pack: DomainPackV2
  readonly layer?: PackLayer
  readonly label?: string
}

/** Anything `mergePackLayers` accepts: a loaded pack or a raw pack layer. */
export type MergeInput = LoadedPack | PackLayerInput

/** Options controlling merge diagnostics. */
export interface OverlayMergeOptions {
  /** Emit an `info` diagnostic for every cross-layer id replacement. Default true. */
  readonly reportReplaces?: boolean
  /** Emit a `warning` when a higher layer replaces with an older version. Default true. */
  readonly reportDowngrades?: boolean
}

/** Result of a deterministic overlay merge. */
export interface MergeResult {
  /** The merged, validated pack; present only when `ok`. */
  readonly pack?: DomainPackV2
  readonly diagnostics: readonly PackDiagnostic[]
  readonly ok: boolean
  /** `collection:id` pairs replaced by a higher-precedence layer, in first-replacement order. */
  readonly replacements: readonly string[]
}

/** Stable sort by canonical layer precedence (equal ranks keep input order). */
export function sortLayersByPrecedence<T extends { readonly layer: PackLayer }>(layers: readonly T[]): T[] {
  return layers
    .map((item, index) => ({ item, rank: layerRank(item.layer), index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.item)
}

/** Normalize a merge input into a uniform layer view. */
function toLayer(item: MergeInput): { pack?: DomainPackV2; layer: PackLayer; label: string; ok: boolean } {
  if ('source' in item) {
    return { pack: item.pack, layer: item.source.layer, label: item.source.label, ok: item.ok }
  }
  return { pack: item.pack, layer: item.layer ?? 'request', label: item.label ?? item.pack.pack.id, ok: true }
}

/**
 * Merge one higher-precedence expert over a lower-precedence projection while
 * retaining capability contributions from both packs. Normal fields keep the
 * standard overlay semantics (the higher layer wins). For a duplicated
 * capability id the higher layer's claim wins; lower-layer-only claims are
 * retained in their original order, then higher-layer-only claims append.
 *
 * Without this, an overlay that re-projects an expert by id (e.g. the
 * zhijian-realestate overlay replacing a beike cross-projection) silently
 * drops the pack-scoped capability claims (e.g. `beike.review`) contributed
 * by the lower layer, breaking roster gates that depend on them.
 */
function mergeExpertCapabilities(previous: unknown, next: unknown): unknown {
  if (!isRecord(previous) || !isRecord(next)) return next
  const previousClaims = previous['capabilities']
  const nextClaims = next['capabilities']
  if (!Array.isArray(previousClaims) || !Array.isArray(nextClaims)) return next

  const order: string[] = []
  const byCapability = new Map<string, unknown>()
  for (const claim of [...previousClaims, ...nextClaims]) {
    const capability = isRecord(claim) ? claim['capability'] : undefined
    if (typeof capability !== 'string' || capability === '') continue
    if (!byCapability.has(capability)) order.push(capability)
    byCapability.set(capability, claim)
  }
  return {
    ...previous,
    ...next,
    capabilities: order.map(capability => byCapability.get(capability)),
  }
}

/**
 * Deterministic overlay merge with the canonical precedence
 * `builtin < domain-pack < workspace < request` (inputs are sorted into
 * that order regardless of argument order; equal layers keep input order,
 * so the result is reproducible).
 *
 * Per entity id the highest-precedence definition wins; replaced ids are
 * reported in `replacements` and produce `overlay-replace` diagnostics
 * (with both versions), plus an `overlay-downgrade` warning when the
 * replacing layer carries an older version. The merged pack is validated as
 * a whole so cross-layer references (scenario → template → policy → gate)
 * are resolved against the union.
 */
export function mergePackLayers(inputs: readonly MergeInput[], options: OverlayMergeOptions = {}): MergeResult {
  const reportReplaces = options.reportReplaces ?? true
  const reportDowngrades = options.reportDowngrades ?? true
  const diags = new Diagnostics()
  const ordered = sortLayersByPrecedence(inputs.map(toLayer))
  const replacements: string[] = []

  let packMeta: PackMeta | undefined
  for (const layer of ordered) {
    if (!layer.ok || layer.pack === undefined) {
      diags.add('overlay-layer-skip', 'overlay', `layer "${layer.label}" skipped (failed to load or validate)`, 'warning')
      continue
    }
    packMeta = layer.pack.pack // topmost valid layer wins for pack metadata
  }
  if (packMeta === undefined) {
    diags.add('overlay-no-pack', 'overlay.pack', 'no layer provided pack metadata; nothing merged')
    return { pack: undefined, diagnostics: diags.items, ok: false, replacements }
  }

  const merged: Record<string, unknown> = { pack: packMeta }
  for (const [key] of PACK_SECTIONS) {
    const order: string[] = []
    const byId = new Map<string, { entity: unknown; label: string; version?: string }>()
    for (const layer of ordered) {
      if (!layer.ok || layer.pack === undefined) continue
      const list = (layer.pack as unknown as Record<string, readonly unknown[]>)[key] ?? []
      for (const entity of list) {
        const id = (entity as { id?: unknown }).id
        if (typeof id !== 'string' || id === '') {
          diags.add('overlay-missing-id', `overlay.${key}`, `entity without a string id in layer "${layer.label}"`, 'warning')
          continue
        }
        const version = typeof (entity as { version?: unknown }).version === 'string'
          ? (entity as { version?: string }).version
          : undefined
        const previous = byId.get(id)
        if (previous !== undefined) {
          if (!replacements.includes(`${key}:${id}`)) replacements.push(`${key}:${id}`)
          if (reportReplaces) {
            diags.add('overlay-replace', `overlay.${key}.${id}`, `"${id}" (${key}) replaced by layer "${layer.label}" (was "${previous.label}"; ${previous.version ?? '?'} → ${version ?? '?'})`, 'info')
          }
          if (reportDowngrades && previous.version !== undefined && version !== undefined && compareVersions(version, previous.version) === -1) {
            diags.add('overlay-downgrade', `overlay.${key}.${id}`, `"${id}" (${key}) replaced by older version ${version} < ${previous.version}`, 'warning')
          }
          byId.set(id, {
            entity: key === 'experts' ? mergeExpertCapabilities(previous.entity, entity) : entity,
            label: layer.label,
            version,
          })
        } else {
          byId.set(id, { entity, label: layer.label, version })
          order.push(id)
        }
      }
    }
    merged[key] = order.map(id => byId.get(id)?.entity)
  }

  const validation = validateDomainPack(merged)
  diags.items.push(...validation.diagnostics)
  const ok = !diags.hasErrors
  return { pack: ok ? validation.value : undefined, diagnostics: diags.items, ok, replacements }
}

// --- SkillPackage loading ----------------------------------------------------

/** Manifest file names probed in a skill package root, in order. */
export const DEFAULT_SKILL_MANIFEST_NAMES: readonly string[] = ['skill.json', 'manifest.json']

/** Options for {@link loadSkillPackageFromDir}. */
export interface SkillLoadOptions {
  /** Manifest file names to probe; defaults to {@link DEFAULT_SKILL_MANIFEST_NAMES}. */
  readonly manifestNames?: readonly string[]
  /**
   * Base directory the declared `source.root` must resolve into. When set,
   * `resolveInside(rootBase, source.root)` must equal the loaded directory
   * exactly — the manifest's declared root must be the directory being
   * loaded.
   */
  readonly rootBase?: string
}

/** One declared exec script, surfaced as metadata — never executed. */
export interface ResolvedScript {
  /** Safe relative path of the script inside the package root. */
  readonly path: string
  /** Whether the file exists on disk. */
  readonly exists: boolean
  readonly bytes?: number
  readonly sha256?: string
}

/** Result of loading one local skill package. */
export interface LoadedSkillPackage {
  /** The normalized manifest; present when a usable manifest was found. */
  readonly manifest?: SkillPackageManifest
  readonly resolvedScripts: readonly ResolvedScript[]
  readonly diagnostics: readonly PackDiagnostic[]
  readonly ok: boolean
}

/**
 * Load and verify one locally-installed SkillPackage.
 *
 * Verification (all local, zero network):
 * - manifest found under the package root (`skill.json` / `manifest.json`);
 * - `source.kind` must be `builtin` | `workspace` (remote kinds rejected);
 * - `source.root` must be a safe relative path, and — when `rootBase` is
 *   given — must resolve (by `realpath`) to exactly the loaded directory;
 * - canonical package digest re-verification: the content tree (excluding
 *   the manifest file) **plus** the canonicalized manifest (`source.digest`
 *   omitted, keys sorted) — tampering with `contributions` / `permissions` /
 *   `source.root` is detected;
 * - every `lazyMedia` entry must resolve inside the root with matching
 *   `bytes` and `sha256`;
 * - `permissions.execScripts` are surfaced as {@link ResolvedScript}
 *   declarations (path / existence / bytes / hash) and **never executed**;
 * - a missing `source.license` forces `permissions.internalOnly = true`
 *   (the §3.7 default) with a warning.
 *
 * Contribution cross-validation (methodPacks / knowledgeProviders / …)
 * is intentionally **not** re-implemented here: it is `validateDomainPack`'s
 * job once the manifest is embedded in a pack.
 */
export async function loadSkillPackageFromDir(
  dir: string,
  options: SkillLoadOptions = {},
): Promise<LoadedSkillPackage> {
  const diags = new Diagnostics()
  const names = options.manifestNames ?? DEFAULT_SKILL_MANIFEST_NAMES

  let dirReal: string
  try {
    dirReal = await realpath(dir)
  } catch (error: unknown) {
    return {
      manifest: undefined,
      resolvedScripts: [],
      diagnostics: [{ code: 'skill-root-missing', path: 'skill', message: `skill package root "${dir}" does not exist: ${String(error)}`, severity: 'error' }],
      ok: false,
    }
  }

  // 1. Manifest file.
  let manifestName: string | undefined
  let raw: unknown
  for (const name of names) {
    try {
      raw = JSON.parse(await readFile(join(dirReal, name), 'utf8'))
      manifestName = name
      break
    } catch (error: unknown) {
      if (isEnoent(error)) continue
      diags.add('json-parse-error', `skill.${name}`, `skill manifest "${name}" is not valid JSON: ${String(error)}`)
      return { manifest: undefined, resolvedScripts: [], diagnostics: diags.items, ok: false }
    }
  }
  if (manifestName === undefined || raw === undefined) {
    diags.add('manifest-missing', 'skill', `no skill manifest found under "${dirReal}" (tried ${names.join(', ')})`)
    return { manifest: undefined, resolvedScripts: [], diagnostics: diags.items, ok: false }
  }
  if (!isRecord(raw)) {
    diags.add('invalid-shape', 'skill', 'skill manifest must be a JSON object')
    return { manifest: undefined, resolvedScripts: [], diagnostics: diags.items, ok: false }
  }
  const manifest = raw as Record<string, unknown>

  // 2. Source: kind / root / digest.
  const source = manifest['source']
  if (!isRecord(source)) {
    diags.add('source-missing', 'skill.source', 'skill manifest source must declare kind/root/digest (local-only)')
    return { manifest: undefined, resolvedScripts: [], diagnostics: diags.items, ok: false }
  }
  const kind = source['kind']
  if (kind !== 'builtin' && kind !== 'workspace') {
    diags.add('remote-source', 'skill.source.kind', 'skill source.kind must be builtin|workspace — remote sources are forbidden at runtime')
  }
  const root = source['root']
  if (typeof root !== 'string' || !isSafeRelativePath(root)) {
    diags.add('unsafe-root', 'skill.source.root', 'skill source.root must be a safe relative path of the locally installed skill (no .., no absolute path, no drive letter)')
  }
  const digest = source['digest']
  if (typeof digest !== 'string' || digest === '') {
    diags.add('digest-missing', 'skill.source.digest', 'skill source.digest must be a whole-package digest (re-installs re-verify)')
  }

  // 3. Declared root consistency (when the owning base is known).
  if (options.rootBase !== undefined && typeof root === 'string' && isSafeRelativePath(root)) {
    try {
      const declared = await resolveInside(options.rootBase, root)
      if (declared !== dirReal) {
        diags.add('root-mismatch', 'skill.source.root', `declared root "${root}" resolves to "${declared}" but the package was loaded from "${dirReal}"`)
      }
    } catch (error: unknown) {
      diags.add('root-mismatch', 'skill.source.root', `declared root "${root}" cannot be resolved under base "${options.rootBase}": ${String(error)}`)
    }
  }

  // 4. Canonical package digest re-verification: content tree (excluding the
  // manifest file) + canonicalized manifest (source.digest omitted, keys
  // sorted). Runs on the raw parsed manifest, before any normalization, so
  // the digest recomputes identically to the fixture that wrote it.
  if (typeof digest === 'string' && digest !== '') {
    const computed = await canonicalSkillDigest(dirReal, manifest, { manifestName })
    if (computed !== digest) {
      diags.add('digest-mismatch', 'skill.source.digest', `package digest mismatch: declared ${digest}, computed ${computed}`)
    }
  }

  // 5. Lazy media: size + sha256, path-contained.
  const lazyMedia = manifest['lazyMedia']
  if (lazyMedia !== undefined) {
    if (!Array.isArray(lazyMedia)) {
      diags.add('invalid-shape', 'skill.lazyMedia', 'skill lazyMedia must be an array')
    } else {
      for (const [index, media] of lazyMedia.entries()) {
        const path = `skill.lazyMedia[${index}]`
        if (!isRecord(media) || typeof media['path'] !== 'string' || typeof media['bytes'] !== 'number' || typeof media['sha256'] !== 'string') {
          diags.add('invalid-field', path, 'lazy media entry must carry path/bytes/sha256')
          continue
        }
        const rel = media['path'] as string
        if (!isSafeRelativePath(rel)) {
          diags.add('lazy-media-unsafe', `${path}.path`, `lazy media path "${rel}" is not a safe relative path`)
          continue
        }
        try {
          const real = await resolveInside(dirReal, rel)
          const info = await stat(real)
          if (!info.isFile()) {
            diags.add('lazy-media-not-file', `${path}.path`, `lazy media "${rel}" is not a regular file`)
            continue
          }
          if (info.size !== media['bytes']) {
            diags.add('lazy-media-size-mismatch', `${path}.bytes`, `lazy media "${rel}" size mismatch: declared ${String(media['bytes'])}, actual ${info.size}`)
            continue
          }
          const actual = sha256Of(await readFile(real))
          if (actual !== media['sha256']) {
            diags.add('lazy-media-hash-mismatch', `${path}.sha256`, `lazy media "${rel}" sha256 mismatch: declared ${media['sha256']}, actual ${actual}`)
          }
        } catch (error: unknown) {
          if (isEnoent(error)) {
            diags.add('lazy-media-missing', `${path}.path`, `lazy media "${rel}" is missing under the package root`)
          } else {
            diags.add('lazy-media-unsafe', `${path}.path`, `lazy media "${rel}" cannot be resolved inside the package root: ${String(error)}`)
          }
        }
      }
    }
  }

  // 6. Exec scripts: declarations only — surfaced, never executed.
  const resolvedScripts: ResolvedScript[] = []
  const permissions = manifest['permissions']
  const execScripts = isRecord(permissions) && Array.isArray(permissions['execScripts']) ? permissions['execScripts'] : []
  for (const [index, script] of execScripts.entries()) {
    if (typeof script !== 'string' || !isSafeRelativePath(script)) {
      diags.add('exec-script-unsafe', `skill.permissions.execScripts[${index}]`, `declared exec script is not a safe relative path`, 'warning')
      continue
    }
    try {
      const real = await resolveInside(dirReal, script)
      const info = await stat(real)
      resolvedScripts.push({ path: script, exists: true, bytes: info.size, sha256: sha256Of(await readFile(real)) })
    } catch (error: unknown) {
      resolvedScripts.push({ path: script, exists: false })
      diags.add('exec-script-missing', `skill.permissions.execScripts[${index}]`, `declared exec script "${script}" is missing under the package root; it stays a declaration and is never executed (${String(error)})`, 'warning')
    }
  }

  // 7. No license ⇒ internalOnly (the §3.7 default), materialized on the manifest.
  let normalizedPermissions: Record<string, unknown> = isRecord(permissions) ? { ...permissions } : {}
  if (source['license'] === undefined && normalizedPermissions['internalOnly'] !== true) {
    normalizedPermissions = { ...normalizedPermissions, internalOnly: true }
    diags.add('unlicensed-internal-only-default', 'skill.permissions.internalOnly', 'no license declared — permissions.internalOnly forced to true (default per §3.7)', 'warning')
  }

  const normalized = {
    ...manifest,
    source: { ...source },
    permissions: normalizedPermissions,
  } as unknown as SkillPackageManifest

  const ok = !diags.hasErrors
  return { manifest: normalized, resolvedScripts, diagnostics: diags.items, ok }
}
