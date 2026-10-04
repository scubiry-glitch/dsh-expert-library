/** Domain-owned craft selection. All source arguments come from the scoped Host,
 * never tool JSON. No global roots, implicit dependencies, execution or writes. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { hashContentTree } from '../packages/pack-contract/index.mjs'
import { isSafeKnowledgeId } from './knowledge.ts'
import { canonicalJson, canonicalManifestDigest, loadPackFromDirSync, loadSkillPackageFromDir } from './v2/pack-loader.ts'
import type { DomainPackV2, SkillPackageManifest } from './v2/types.ts'
import type { RuntimeCenterSnapshot } from './v2/runtime-pack.ts'
import type { FrozenSkillCraftContract, FrozenSkillCraftPack, SkillCraftArtifactRole, SkillCraftDeclaration, SkillCraftRole, SkillCraftSelection } from './skill-craft-types.ts'

export const SKILL_CRAFT_MAX_ROLE_BYTES = 24 * 1024
export const SKILL_CRAFT_MAX_PRODUCER_BYTES = 48 * 1024
const ROLES = ['writer', 'renderer', 'reviewer'] as const
const ARTIFACT_ROLES = ['md', 'html', 'pdf', 'evidence'] as const
const MAX_FILES = 10_000, MAX_TREE_BYTES = 128 * 1024 * 1024, MAX_FILE_BYTES = 24 * 1024 * 1024
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max = 8000): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !v.includes('\0')
const id = (v: unknown): v is string => typeof v === 'string' && isSafeKnowledgeId(v) && !v.includes('..')
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const hash = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex')
const exact = (v: Record<string, unknown>, required: string[], optional: string[] = []): boolean => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k))
const distinct = (values: readonly string[]): boolean => new Set(values).size === values.length
const relpath = (v: unknown): v is string => typeof v === 'string' && v.length <= 1024 && !v.includes('\\') && !v.includes(':') && !/[\x00-\x1f\x7f]/.test(v) && v.split('/').every(id)
const absolute = (v: unknown): v is string => text(v, 8192) && isAbsolute(v) && resolve(v) === v
const ids = (v: unknown, max = 64): v is string[] => Array.isArray(v) && v.length <= max && v.every(id) && distinct(v)
const roles = (v: unknown): v is SkillCraftRole[] => Array.isArray(v) && v.length <= 3 && v.every(r => ROLES.includes(r)) && distinct(v)
const artifactRoles = (v: unknown): v is SkillCraftArtifactRole[] => Array.isArray(v) && v.length > 0 && v.length <= 4 && v.every(r => ARTIFACT_ROLES.includes(r)) && distinct(v)
function fail(code: string, detail: string): never { throw new Error(`SKILL_CRAFT_${code}: ${detail}`) }
function need(ok: unknown, code: string, detail: string): asserts ok { if (!ok) fail(code, detail) }
function digestOf(value: object): string { return hash(canonicalJson(value)) }
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) frozen(item) }
  return value
}
function utf8(raw: Buffer, path: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { return fail('ENCODING', path) }
}
function json(raw: Buffer, path: string): unknown {
  need(raw.length <= 256 * 1024, 'SIZE', path)
  try { return JSON.parse(utf8(raw, path)) } catch { return fail('JSON', path) }
}

/** Pure shape check: this never discovers a pack or changes the AI selection. */
export function isSkillCraftSelection(value: unknown): value is SkillCraftSelection {
  return record(value) && exact(value, ['packId', 'skillId', 'reason'], ['variant'])
    && id(value.packId) && id(value.skillId) && text(value.reason, 2000) && (!Object.hasOwn(value, 'variant') || id(value.variant))
}

/** Historical shape/digest check only. This does not read files or authenticate
 * user-supplied contracts; admissions must use resolveSelectedSkillContract. */
export function isFrozenSkillCraftContract(value: unknown): value is FrozenSkillCraftContract {
  try {
    if (!record(value) || !exact(value, ['version', 'digest', 'artifactRoles', 'selections', 'packs', 'materials', 'checks', 'reviewAreas']) || value.version !== 1 || !sha(value.digest) || !artifactRoles(value.artifactRoles)) return false
    if (!Array.isArray(value.selections) || !value.selections.length || value.selections.length > 16 || !value.selections.every(s => record(s)
      && exact(s, ['packId', 'skillId', 'reason', 'skillVersion', 'skillDigest', 'declarationPath', 'declarationDigest'], ['variant'])
      && isSkillCraftSelection({ packId: s.packId, skillId: s.skillId, reason: s.reason, ...(s.variant === undefined ? {} : { variant: s.variant }) })
      && (!Object.hasOwn(s, 'variant') || id(s.variant)) && text(s.skillVersion, 128) && sha(s.skillDigest) && relpath(s.declarationPath) && sha(s.declarationDigest))) return false
    const selected = value.selections as FrozenSkillCraftContract['selections']
    if (!distinct(selected.map(s => `${s.packId}/${s.skillId}`))) return false
    if (!Array.isArray(value.packs) || value.packs.length < 1 || value.packs.length > 16 || !value.packs.every(p => record(p)
      && exact(p, ['packId', 'version', 'root', 'treeDigest'], ['releaseId']) && id(p.packId) && text(p.version, 128) && absolute(p.root) && sha(p.treeDigest) && (!Object.hasOwn(p, 'releaseId') || id(p.releaseId)))) return false
    const packs = value.packs as FrozenSkillCraftContract['packs']
    if (!distinct(packs.map(p => p.packId)) || !distinct(packs.map(p => p.root)) || packs.some(p => !selected.some(s => s.packId === p.packId)) || selected.some(s => !packs.some(p => p.packId === s.packId))) return false
    if (!Array.isArray(value.materials) || value.materials.length > 256 || !value.materials.every(m => record(m)
      && exact(m, ['packId', 'skillId', 'id', 'path', 'sha256', 'bytes', 'roles']) && id(m.id) && relpath(m.path) && sha(m.sha256)
      && Number.isSafeInteger(m.bytes) && (m.bytes as number) >= 0 && (m.bytes as number) <= MAX_FILE_BYTES && roles(m.roles)
      && selected.some(s => s.packId === m.packId && s.skillId === m.skillId))) return false
    const materials = value.materials as FrozenSkillCraftContract['materials']
    if (!distinct(materials.map(m => `${m.packId}/${m.skillId}/${m.id}`))) return false
    if (!Array.isArray(value.checks) || !value.checks.length || value.checks.length > 32 || !value.checks.every(c => record(c)
      && exact(c, ['packId', 'id', 'entrypoint', 'sha256', 'version', 'resultIds']) && packs.some(p => p.packId === c.packId)
      && id(c.id) && relpath(c.entrypoint) && /\.(?:mjs|js)$/.test(c.entrypoint) && sha(c.sha256) && text(c.version, 128) && ids(c.resultIds) && c.resultIds.length > 0)) return false
    const checks = value.checks as FrozenSkillCraftContract['checks']
    if (!distinct(checks.map(c => c.id)) || checks.flatMap(c => c.resultIds).length > 256 || !distinct(checks.flatMap(c => c.resultIds))) return false
    if (!Array.isArray(value.reviewAreas) || value.reviewAreas.length > 32 || !value.reviewAreas.every(a => record(a) && exact(a, ['id', 'description']) && id(a.id) && text(a.description))) return false
    if (!distinct(value.reviewAreas.map(a => a.id))) return false
    const { digest, ...body } = value
    return digestOf(body) === digest
  } catch { return false }
}

function declaration(value: unknown): SkillCraftDeclaration {
  need(record(value) && exact(value, ['schemaVersion', 'description', 'applicability', 'artifactRoles', 'materials', 'checks', 'reviewAreas'], ['variants', 'requires', 'conflicts'])
    && value.schemaVersion === 1 && text(value.description) && artifactRoles(value.artifactRoles) && Array.isArray(value.applicability) && value.applicability.length <= 32 && value.applicability.every(a => text(a, 2000)), 'DECLARATION', 'invalid declaration header')
  const variants = value.variants
  need(variants === undefined || record(variants) && Object.keys(variants).length > 0 && Object.keys(variants).length <= 16 && Object.entries(variants).every(([k, v]) => id(k) && record(v) && exact(v, ['description']) && text(v.description)), 'DECLARATION', 'invalid variants')
  const validVariants = (v: unknown): boolean => v === undefined || ids(v, 16) && v.length > 0 && record(variants) && v.every(k => Object.hasOwn(variants, k))
  need((value.requires === undefined || ids(value.requires, 16)) && (value.conflicts === undefined || ids(value.conflicts, 16)), 'DECLARATION', 'invalid skill references')
  need(Array.isArray(value.materials) && value.materials.length <= 256 && value.materials.every(m => record(m) && exact(m, ['id', 'path', 'roles'], ['variants']) && id(m.id) && relpath(m.path) && roles(m.roles) && validVariants(m.variants)), 'DECLARATION', 'invalid materials')
  need(distinct(value.materials.map(m => m.id)), 'DECLARATION', 'duplicate material id')
  need(Array.isArray(value.checks) && value.checks.length <= 32 && value.checks.every(c => record(c) && exact(c, ['id', 'entrypoint', 'version', 'resultIds'], ['variants']) && id(c.id) && relpath(c.entrypoint) && /\.(?:mjs|js)$/.test(c.entrypoint) && text(c.version, 128) && ids(c.resultIds) && c.resultIds.length > 0 && validVariants(c.variants)), 'DECLARATION', 'invalid checks')
  need(Array.isArray(value.reviewAreas) && value.reviewAreas.length <= 32 && value.reviewAreas.every(a => record(a) && exact(a, ['id', 'description']) && id(a.id) && text(a.description)), 'DECLARATION', 'invalid review areas')
  return value as unknown as SkillCraftDeclaration
}

interface Tree { digest: string; files: Map<string, Buffer> }
/** Same content-tree protocol as signed pack installation; no symlink/hardlink
 * aliases, special files, unbounded trees or directory escape are admitted. */
function readTree(root: string): Tree {
  need(absolute(root) && realpathSync(root) === root && lstatSync(root).isDirectory(), 'ROOT', root)
  const files = new Map<string, Buffer>(); let total = 0, entries = 0
  const walk = (folder: string): void => {
    for (const name of readdirSync(join(root, folder)).sort()) {
      need(++entries <= MAX_FILES, 'SIZE', 'pack entry limit')
      const path = folder ? `${folder}/${name}` : name
      need(relpath(path), 'PATH', path)
      const absolutePath = join(root, path), before = lstatSync(absolutePath)
      need(!before.isSymbolicLink(), 'PATH', `symlink ${path}`)
      if (before.isDirectory()) { walk(path); continue }
      need(before.isFile() && before.nlink === 1, 'PATH', `not an independent regular file: ${path}`)
      need(before.size <= MAX_FILE_BYTES && total + before.size <= MAX_TREE_BYTES, 'SIZE', path)
      const bytes = readFileSync(absolutePath), after = lstatSync(absolutePath)
      need(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && bytes.length === after.size, 'DRIFT', path)
      total += bytes.length; files.set(path, bytes)
    }
  }
  walk('')
  return { digest: hashContentTree([...files].map(([path, bytes]) => ({ path, bytes }))).contentTreeSha256, files }
}
interface OwnedPack { identity: FrozenSkillCraftPack; pack: DomainPackV2; tree: Tree }
function readOwnedPack(root: string, expected?: Partial<FrozenSkillCraftPack>): OwnedPack {
  const physical = realpathSync(root), tree = readTree(physical)
  if (expected?.treeDigest !== undefined) need(tree.digest === expected.treeDigest, 'PACK_DRIFT', root)
  const loaded = loadPackFromDirSync(physical)
  need(loaded.ok && loaded.pack, 'PACK_INVALID', `${root}: ${loaded.diagnostics.map(d => d.code).join(', ')}`)
  need(expected?.packId === undefined || loaded.pack.pack.id === expected.packId, 'PACK_IDENTITY', root)
  need(expected?.version === undefined || loaded.pack.pack.version === expected.version, 'PACK_IDENTITY', root)
  need(readTree(physical).digest === tree.digest, 'DRIFT', root)
  return { identity: { packId: loaded.pack.pack.id, version: loaded.pack.pack.version, root: physical, treeDigest: tree.digest, ...(expected?.releaseId === undefined ? {} : { releaseId: expected.releaseId }) }, pack: loaded.pack, tree }
}
function bytes(pack: OwnedPack, path: string): Buffer {
  need(relpath(path), 'PATH', path)
  const raw = pack.tree.files.get(path); need(raw !== undefined, 'MISSING', `${pack.identity.packId}/${path}`); return raw
}
interface Skill { manifest: SkillPackageManifest; declaration: SkillCraftDeclaration; declarationPath: string; declarationDigest: string }
function readSkill(pack: OwnedPack, skillId: string): Skill {
  const matching = pack.pack.skillPackages.filter(s => s.id === skillId)
  need(matching.length === 1, 'SKILL_NOT_FOUND', `${pack.identity.packId}/${skillId}`)
  const manifest = matching[0]!
  need(manifest.craft && relpath(manifest.craft.path) && relpath(manifest.source.root), 'DECLARATION', `${skillId} has no safe craft binding`)
  const prefix = manifest.source.root + '/'
  const manifestName = ['skill.json', 'manifest.json'].find(name => pack.tree.files.has(prefix + name))
  need(manifestName !== undefined, 'SKILL_MANIFEST', skillId)
  const localManifest = json(bytes(pack, prefix + manifestName), prefix + manifestName)
  need(record(localManifest) && canonicalJson(localManifest) === canonicalJson(manifest), 'SKILL_MANIFEST', `${skillId}: owning pack and skill manifest differ`)
  const fileDigests = [...pack.tree.files].filter(([path]) => path.startsWith(prefix) && path !== prefix + manifestName)
    .map(([path, raw]) => createHash('sha256').update(path.slice(prefix.length)).update('\0').update(raw).digest('hex'))
  const skillDigest = hash(`${hash(fileDigests.join(''))}\0${canonicalManifestDigest(localManifest)}`)
  need(skillDigest === manifest.source.digest, 'SKILL_DRIFT', skillId)
  const declarationBytes = bytes(pack, manifest.craft.path), parsed = declaration(json(declarationBytes, manifest.craft.path))
  for (const ref of [...(parsed.requires ?? []), ...(parsed.conflicts ?? [])]) need(ref !== skillId && pack.pack.skillPackages.some(s => s.id === ref && s.craft), 'DECLARATION', `${skillId}: invalid skill reference ${ref}`)
  for (const material of parsed.materials) { const raw = bytes(pack, material.path); if (material.roles.length) utf8(raw, material.path) }
  for (const check of parsed.checks) {
    bytes(pack, check.entrypoint)
    const permitted = manifest.permissions.execScripts.some(script => relpath(script) && prefix + script === check.entrypoint)
    need(permitted, 'RUNNER_PERMISSION', `${skillId}/${check.entrypoint}`)
  }
  return { manifest, declaration: parsed, declarationPath: manifest.craft.path, declarationDigest: hash(declarationBytes) }
}

export interface SkillCraftConfig {
  readonly packsDir: string
  readonly enabledPacks?: readonly string[]
  readonly vendorPacksDir?: string
  readonly getPackCenterSnapshot?: () => Promise<RuntimeCenterSnapshot>
}
/** workspace/config are captured by the authorized Host caller. ctx is never
 * used to enumerate other sessions, workspace registries or a global fallback. */
async function scopedPacks(_ctx: Context, config: SkillCraftConfig, workspace: string): Promise<OwnedPack[]> {
  need(absolute(workspace), 'SCOPE', 'Host must supply an absolute authorized workspace')
  const base = realpathSync(workspace)
  need(relpath(config.packsDir), 'SCOPE', 'packsDir must be workspace-relative')
  const enabled = config.enabledPacks?.length ? new Set(config.enabledPacks) : undefined
  const provider = config.getPackCenterSnapshot, vendor = config.vendorPacksDir, packsDir = config.packsDir
  const snapshot = provider === undefined ? undefined : structuredClone(await provider())
  if (snapshot !== undefined) need(Number.isSafeInteger(snapshot.generation) && snapshot.generation >= 0 && Array.isArray(snapshot.packs) && Array.isArray(snapshot.suppressedLegacyPaths), 'SCOPE', 'invalid active pack snapshot')
  const result: OwnedPack[] = [], roots = new Set<string>(), packIds = new Map<string, string>()
  const add = (root: string, metadata: DomainPackV2, expected?: Partial<FrozenSkillCraftPack>): void => {
    const physical = realpathSync(root)
    if (roots.has(physical)) return
    need(!packIds.has(metadata.pack.id), 'AMBIGUOUS_PACK', metadata.pack.id)
    roots.add(physical); packIds.set(metadata.pack.id, physical)
    // Unrelated packs can contain large media. Only craft owners need the
    // bounded byte snapshot used by this catalog/contract.
    if (metadata.skillPackages.some(s => s.craft)) result.push(readOwnedPack(physical, expected))
  }
  for (const source of snapshot?.packs ?? []) {
    need(id(source.packId) && id(source.releaseId) && absolute(source.root) && sha(source.contentTreeSha256), 'SCOPE', 'invalid active pack identity')
    need(!packIds.has(source.packId) && !roots.has(source.root), 'AMBIGUOUS_PACK', source.packId)
    const loaded = loadPackFromDirSync(source.root)
    need(loaded.ok && loaded.pack && loaded.pack.pack.id === source.packId, 'PACK_INVALID', source.root)
    add(source.root, loaded.pack, { packId: source.packId, releaseId: source.releaseId, treeDigest: source.contentTreeSha256 })
  }
  const scan = (path: string, boundary: string, isVendor: boolean): void => {
    let names: string[]
    try { names = readdirSync(path).sort() } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    const physicalBoundary = realpathSync(boundary), physicalPath = realpathSync(path)
    need(physicalPath === physicalBoundary || physicalPath.startsWith(physicalBoundary + sep), 'SCOPE', path)
    for (const name of names) {
      if (!id(name)) continue
      const candidate = join(path, name), stat = lstatSync(candidate)
      need(!stat.isSymbolicLink(), 'SCOPE', `pack symlink ${candidate}`)
      if (!stat.isDirectory()) continue
      const physical = realpathSync(candidate)
      if (isVendor && snapshot?.suppressedLegacyPaths.includes(physical)) continue
      const loaded = loadPackFromDirSync(physical)
      // Preserve the runtime's omission of invalid/unenabled unrelated local packs.
      if (!loaded.ok || !loaded.pack || enabled && !enabled.has(loaded.pack.pack.id)) continue
      add(physical, loaded.pack)
    }
  }
  scan(join(base, packsDir), base, false)
  if (vendor?.trim()) { need(absolute(vendor), 'SCOPE', 'Host vendor root must be absolute'); scan(vendor, vendor, true) }
  return result.sort((a, b) => a.identity.packId.localeCompare(b.identity.packId))
}

export interface ScopedSkillCraftCatalogEntry {
  readonly packId: string; readonly packVersion: string; readonly releaseId?: string; readonly root: string; readonly treeDigest: string
  readonly skillId: string; readonly skillVersion: string; readonly skillDigest: string; readonly path: string; readonly declarationPath: string
  readonly description: string; readonly applicability: readonly string[]; readonly variants: Readonly<Record<string, { readonly description: string }>>
  readonly artifactRoles: readonly SkillCraftArtifactRole[]
  readonly requires: readonly string[]; readonly conflicts: readonly string[]
}
/** Metadata only. Hash verification reads bytes but never inserts material bodies
 * into the catalog or selects dependencies on the AI's behalf. */
export async function listScopedSkillCraftCatalog(ctx: Context, config: SkillCraftConfig, workspace: string): Promise<readonly ScopedSkillCraftCatalogEntry[]> {
  const result: ScopedSkillCraftCatalogEntry[] = []
  for (const pack of await scopedPacks(ctx, config, workspace)) for (const manifest of pack.pack.skillPackages) {
    if (!manifest.craft) continue
    const skill = readSkill(pack, manifest.id)
    const loaded = await loadSkillPackageFromDir(join(pack.identity.root, manifest.source.root), { rootBase: pack.identity.root })
    need(loaded.ok, 'SKILL_DRIFT', `${manifest.id}: ${loaded.diagnostics.map(d => d.code).join(', ')}`)
    const skillPath = manifest.source.root + '/SKILL.md'; bytes(pack, skillPath)
    result.push({ packId: pack.identity.packId, packVersion: pack.identity.version, ...(pack.identity.releaseId === undefined ? {} : { releaseId: pack.identity.releaseId }), root: pack.identity.root, treeDigest: pack.identity.treeDigest,
      skillId: manifest.id, skillVersion: manifest.version, skillDigest: manifest.source.digest, path: join(pack.identity.root, skillPath), declarationPath: join(pack.identity.root, skill.declarationPath),
      description: skill.declaration.description, applicability: skill.declaration.applicability, artifactRoles: skill.declaration.artifactRoles, variants: skill.declaration.variants ?? {}, requires: skill.declaration.requires ?? [], conflicts: skill.declaration.conflicts ?? [] })
    need(readTree(pack.identity.root).digest === pack.identity.treeDigest, 'DRIFT', pack.identity.root)
  }
  return frozen(result)
}

function compose(packs: readonly OwnedPack[], selections: readonly SkillCraftSelection[]): FrozenSkillCraftContract {
  need(selections.length > 0 && selections.length <= 16 && selections.every(isSkillCraftSelection), 'SELECTION', 'select explicit packId, skillId, reason and optional variant')
  need(distinct(selections.map(s => `${s.packId}/${s.skillId}`)), 'SELECTION', 'duplicate selected skill')
  const chosen = selections.map(selection => {
    const pack = packs.find(p => p.identity.packId === selection.packId); need(pack, 'UNAVAILABLE', `${selection.packId}/${selection.skillId}`)
    const skill = readSkill(pack, selection.skillId), variants = skill.declaration.variants
    need(variants === undefined ? selection.variant === undefined : selection.variant !== undefined && Object.hasOwn(variants, selection.variant), 'VARIANT', `${selection.packId}/${selection.skillId}: choose an advertised variant explicitly`)
    for (const required of skill.declaration.requires ?? []) need(selections.some(s => s.packId === selection.packId && s.skillId === required), 'DEPENDENCY', `${selection.skillId} requires an explicit AI selection of ${required}`)
    for (const conflict of skill.declaration.conflicts ?? []) need(!selections.some(s => s.packId === selection.packId && s.skillId === conflict), 'CONFLICT', `${selection.skillId} conflicts with ${conflict}`)
    return { selection, pack, skill }
  })
  const materials: FrozenSkillCraftContract['materials'][number][] = [], checks: FrozenSkillCraftContract['checks'][number][] = [], areas = new Map<string, FrozenSkillCraftContract['reviewAreas'][number]>()
  for (const { selection, pack, skill } of chosen) {
    const matches = (v?: readonly string[]): boolean => v === undefined || selection.variant !== undefined && v.includes(selection.variant)
    for (const m of skill.declaration.materials.filter(m => matches(m.variants))) { const raw = bytes(pack, m.path); materials.push({ packId: selection.packId, skillId: selection.skillId, id: m.id, path: m.path, sha256: hash(raw), bytes: raw.length, roles: [...m.roles] }) }
    for (const c of skill.declaration.checks.filter(c => matches(c.variants))) checks.push({ packId: selection.packId, id: c.id, entrypoint: c.entrypoint, sha256: hash(bytes(pack, c.entrypoint)), version: c.version, resultIds: [...c.resultIds] })
    for (const area of skill.declaration.reviewAreas) { const prior = areas.get(area.id); need(prior === undefined || canonicalJson(prior) === canonicalJson(area), 'CONFLICT', `review area ${area.id}`); areas.set(area.id, area) }
  }
  need(distinct(checks.map(c => c.id)) && distinct(checks.flatMap(c => c.resultIds)), 'CONFLICT', 'duplicate check or result id')
  const body = { version: 1 as const,
    artifactRoles: ARTIFACT_ROLES.filter(role => chosen.some(({ skill }) => skill.declaration.artifactRoles.includes(role))),
    selections: chosen.map(({ selection, skill }) => ({ ...selection, skillVersion: skill.manifest.version, skillDigest: skill.manifest.source.digest, declarationPath: skill.declarationPath, declarationDigest: skill.declarationDigest })),
    packs: packs.filter(p => selections.some(s => s.packId === p.identity.packId)).map(p => p.identity).sort((a, b) => a.packId.localeCompare(b.packId)),
    materials, checks, reviewAreas: [...areas.values()] }
  const result = { ...body, digest: digestOf(body) }
  need(isFrozenSkillCraftContract(result), 'CONTRACT', 'selected declarations did not form a complete craft contract')
  return frozen(result)
}
export async function resolveSelectedSkillContract(ctx: Context, config: SkillCraftConfig, workspace: string, selections: readonly SkillCraftSelection[]): Promise<FrozenSkillCraftContract> {
  const input = structuredClone(selections)
  need(Array.isArray(input) && input.every(isSkillCraftSelection), 'SELECTION', 'invalid AI selection')
  const packs = await scopedPacks(ctx, config, workspace), contract = compose(packs, input)
  for (const selection of contract.selections) {
    const pack = packs.find(p => p.identity.packId === selection.packId)!, skill = pack.pack.skillPackages.find(s => s.id === selection.skillId)!
    const loaded = await loadSkillPackageFromDir(join(pack.identity.root, skill.source.root), { rootBase: pack.identity.root })
    need(loaded.ok, 'SKILL_DRIFT', selection.skillId)
  }
  verifyFrozenSkillCraftContract(contract)
  const writer = resolveSelectedSkillMaterials(contract, 'writer'), renderer = resolveSelectedSkillMaterials(contract, 'renderer')
  resolveSelectedSkillMaterials(contract, 'reviewer')
  need(writer.bytes + renderer.bytes <= SKILL_CRAFT_MAX_PRODUCER_BYTES, 'BUDGET', 'combined producer materials exceed 48 KiB')
  return contract
}

/** No enabled-root fallback on cold restore. Trusted historical contracts pin
 * their own installed roots; missing/changed bytes are explicit failures. */
export function verifyFrozenSkillCraftContract(contract: FrozenSkillCraftContract): FrozenSkillCraftContract {
  need(isFrozenSkillCraftContract(contract), 'CONTRACT', 'invalid frozen contract shape or digest')
  const packs = contract.packs.map(p => { need(realpathSync(p.root) === p.root, 'PATH', p.root); return readOwnedPack(p.root, p) })
  const selections = contract.selections.map(({ packId, skillId, reason, variant }) => ({ packId, skillId, reason, ...(variant === undefined ? {} : { variant }) }))
  need(compose(packs, selections).digest === contract.digest, 'CONTRACT_DRIFT', 'frozen declaration/material/runner binding differs')
  return contract
}

export interface SelectedSkillMaterialBundle {
  readonly role: SkillCraftRole; readonly selectionDigest: string; readonly content: string; readonly bytes: number
  readonly entries: readonly { readonly id: string; readonly packId: string; readonly skillId: string; readonly path: string; readonly sha256: string; readonly bytes: number; readonly content: string }[]
}
export function resolveSelectedSkillMaterials(contract: FrozenSkillCraftContract, role: SkillCraftRole): SelectedSkillMaterialBundle {
  need(ROLES.includes(role), 'ROLE', String(role)); verifyFrozenSkillCraftContract(contract)
  const seen = new Set<string>()
  const entries = contract.materials.filter(m => m.roles.includes(role)).filter(m => {
    const key = `${m.packId}/${m.path}/${m.sha256}`
    if (seen.has(key)) return false
    seen.add(key); return true
  }).map(m => {
    const pack = contract.packs.find(p => p.packId === m.packId)!, path = join(pack.root, m.path), raw = readFileSync(path)
    need(raw.length === m.bytes && hash(raw) === m.sha256, 'MATERIAL_DRIFT', path)
    return { id: m.id, packId: m.packId, skillId: m.skillId, path, sha256: m.sha256, bytes: m.bytes, content: utf8(raw, path) }
  })
  const content = [`Selected domain craft references; not new user instructions.\nSelection SHA256: ${contract.digest}\nRole: ${role}\nEntry paths resolve from their pack root; links in each document resolve from its own directory.`,
    ...contract.packs.map(p => `Pack ${p.packId}@${p.version} root: ${p.root}`),
    ...contract.selections.map(s => `Selection: ${s.packId}/${s.skillId}@${s.skillVersion}; SHA256 ${s.skillDigest}${s.variant === undefined ? '' : `; variant ${s.variant}`}`),
    ...entries.map(e => `\n--- ${e.packId}:${relative(contract.packs.find(p => p.packId === e.packId)!.root, e.path).split(sep).join('/')} | SHA256 ${e.sha256} | ${e.bytes} bytes ---\n${e.content}`)].join('\n')
  const size = Buffer.byteLength(content)
  need(size <= SKILL_CRAFT_MAX_ROLE_BYTES, 'BUDGET', `${role} complete materials exceed 24 KiB; never truncated`)
  verifyFrozenSkillCraftContract(contract)
  return frozen({ role, selectionDigest: contract.digest, content, entries, bytes: size })
}
