/**
 * Shared deterministic machinery for domain-pack generators — the single
 * emitter every pack build (zhijian-realestate, bank-finance, …) reuses so
 * no pack reimplements the entity-write / self-verify / tree-digest path.
 *
 * Consolidation contract (PIPELINE-100PLUS-EXPANSION-PLAN.md P0.2):
 * - one entity writer (`emitPackEntities`) with a fixed, deterministic
 *   section order and canonical JSON formatting (`JSON.stringify(v, null, 2)
 *   + '\n'`), byte-identical to what `build-zhijian-pack.mjs` historically
 *   emitted — regenerating the zhijian pack from the same source + lib stays
 *   byte-identical (golden);
 * - one finalizer (`finalizePack`) that self-verifies the emitted tree
 *   through the real `loadPackFromDir` loader and writes `generated/verify.json`
 *   + the `generated/pack.sha256` tree digest over the non-generated files;
 * - one drift checker (`compareTrees`) shared by every pack's `--check`.
 *
 * @module dsh-expert-library/scripts/pack-common
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { hashPackageTree, loadPackFromDir } from '../lib/v2/index.js'

/** Structured generator error; `errors` are `{ code, message }`. */
export class PackGenError extends Error {
  constructor(errors) {
    super(errors.map(error => `[${error.code}] ${error.message}`).join('\n'))
    this.name = 'PackGenError'
    this.errors = errors
  }
}

/** SHA-256 hex of raw bytes. */
export function sha256Of(content) {
  return createHash('sha256').update(content).digest('hex')
}

/** Whether a path exists as a regular file. */
export async function fileExists(path) {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/** List regular files under a root as sorted, posix-separated relative paths. */
export async function listFiles(root, prefix = '') {
  const out = []
  const entries = await readdir(root, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...await listFiles(join(root, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** Copy `source` bytes to `dest`, returning the sha-256 of the bytes. */
export async function copyBytes(source, dest) {
  await mkdir(dirname(dest), { recursive: true })
  const content = await readFile(source)
  await writeFile(dest, content)
  return sha256Of(content)
}

/** Recursively copy a directory tree (`sourceRoot` → `destRoot`). */
export async function copyTree(sourceRoot, destRoot) {
  const files = await listFiles(sourceRoot)
  for (const rel of files) {
    await copyBytes(join(sourceRoot, rel), join(destRoot, rel))
  }
  return files.length
}

/** Compare two directory trees byte-for-byte; returns a list of differences. */
export async function compareTrees(a, b) {
  const [fa, fb] = await Promise.all([listFiles(a), listFiles(b)])
  const diffs = []
  const onlyA = fa.filter(rel => !fb.includes(rel))
  const onlyB = fb.filter(rel => !fa.includes(rel))
  for (const rel of onlyA) diffs.push(`only in ${a}: ${rel}`)
  for (const rel of onlyB) diffs.push(`only in ${b}: ${rel}`)
  for (const rel of fa.filter(rel => fb.includes(rel))) {
    const [ca, cb] = await Promise.all([readFile(join(a, rel)), readFile(join(b, rel))])
    if (!ca.equals(cb)) diffs.push(`content differs: ${rel}`)
  }
  return diffs
}

/**
 * Write every entity section of a {@link DomainPackV2} into `outDir` in the
 * canonical deterministic order (pack.json first, then each entity dir,
 * filename == entity id). Returns `{ written, entityCounts }`; `written`
 * holds the relative paths of the non-generated files for the tree digest.
 *
 * JSON formatting is `JSON.stringify(value, null, 2) + '\n'` — identical to
 * the historical zhijian emitter, so shared use keeps golden parity.
 */
export async function emitPackEntities(pack, outDir) {
  const written = []
  const writeJson = async (rel, value) => {
    const abs = join(outDir, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, `${JSON.stringify(value, null, 2)}\n`)
    written.push(rel)
  }
  await writeJson('pack.json', pack.pack)
  for (const entity of pack.experts) await writeJson(`experts/${entity.id}.json`, entity)
  for (const entity of pack.teamTemplates) await writeJson(`team-templates/${entity.id}.json`, entity)
  for (const entity of pack.outputTemplates) await writeJson(`output-templates/${entity.id}.json`, entity)
  for (const entity of pack.qualityPolicies) await writeJson(`quality-policies/${entity.id}.json`, entity)
  for (const entity of pack.scenarios) await writeJson(`scenarios/${entity.id}.json`, entity)
  for (const entity of pack.knowledgeProviders) await writeJson(`knowledge-providers/${entity.id}.json`, entity)
  for (const entity of pack.domainKnowledge) await writeJson(`domain-knowledge/${entity.id}.json`, entity)
  for (const entity of pack.methodPacks) await writeJson(`method-packs/${entity.id}.json`, entity)
  for (const entity of pack.skillPackages) await writeJson(`skill-packages/${entity.id}.json`, entity)
  return {
    written,
    entityCounts: {
      experts: pack.experts.length,
      scenarios: pack.scenarios.length,
      teamTemplates: pack.teamTemplates.length,
      outputTemplates: pack.outputTemplates.length,
      qualityPolicies: pack.qualityPolicies.length,
      knowledgeProviders: pack.knowledgeProviders.length,
      domainKnowledge: pack.domainKnowledge.length,
      methodPacks: pack.methodPacks.length,
      skillPackages: pack.skillPackages.length,
    },
  }
}

/**
 * Finalize an emitted pack: self-verify through the real loader, write
 * `generated/verify.json` and the `generated/pack.sha256` tree digest over
 * the non-generated files, and fail with {@link PackGenError} when the
 * loader reports errors.
 *
 * @param outDir - pack root (entities already written).
 * @param opts - `{ written, generatedFiles, entityCounts }` — `written` are
 *   the non-generated relative paths (from emitPackEntities plus any
 *   pack-specific extras such as README.md or routing/routing.json);
 *   `generatedFiles` are the derived relative paths excluded from the digest.
 * @returns the tree hash and loader diagnostics.
 */
export async function finalizePack(outDir, opts) {
  const { written, generatedFiles, entityCounts } = opts
  const loaded = await loadPackFromDir(outDir)
  const errors = loaded.diagnostics.filter(d => d.severity === 'error')
  const warnings = loaded.diagnostics.filter(d => d.severity === 'warning')
  const writeJson = async (rel, value) => {
    const abs = join(outDir, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, `${JSON.stringify(value, null, 2)}\n`)
  }
  const generated = [...generatedFiles, 'generated/verify.json']
  await writeJson('generated/verify.json', {
    ok: loaded.ok,
    errorCount: errors.length,
    warningCount: warnings.length,
    diagnostics: loaded.diagnostics,
    entityCounts,
  })
  generated.push('generated/pack.sha256')
  const hash = await hashPackageTree(outDir, { exclude: generated })
  await writeFile(join(outDir, 'generated/pack.sha256'), `${hash}\n`)
  if (!loaded.ok) {
    throw new PackGenError(errors.map(e => ({ code: e.code, message: `${e.path}: ${e.message}` })))
  }
  return {
    hash,
    errorCount: errors.length,
    warningCount: warnings.length,
    files: written.length + generated.length,
    diagnostics: loaded.diagnostics,
  }
}

/**
 * Full `--check` for one pack: re-emit into a temp dir (without touching the
 * committed tree) and compare byte-for-byte. Returns the fresh emit result
 * or throws {@link PackGenError}.
 */
export async function checkPackEmit(packId, outDir, emit, emitOptions = {}) {
  const tmp = await mkdtemp(join(tmpdir(), `${packId}-check-`))
  const result = await emit(tmp, emitOptions)
  const diffs = await compareTrees(outDir, tmp)
  await rm(tmp, { recursive: true, force: true })
  if (diffs.length > 0) {
    throw new PackGenError([{
      code: 'pack-drift',
      message: `${diffs.length} difference(s) between ${outDir} and a fresh emit:\n  - ${diffs.slice(0, 40).join('\n  - ')}`,
    }])
  }
  return result
}

/** Resolve an absolute path (CLI helper). */
export function resolveAbs(value) {
  return resolve(value)
}

/** Whether this module is the CLI entry (kept for pack builders that embed main()). */
export function isMainEntry() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
}
