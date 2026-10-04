import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPORT_CRAFT_PACK_ID = 'zhijian-report-craft-v2' as const
export const REPORT_CRAFT_MAX_ROLE_BYTES = 24 * 1024
export const REPORT_CRAFT_STYLES = ['credit-policy', 'designer-paper'] as const
export const REPORT_CRAFT_ROLES = ['writer', 'renderer', 'reviewer'] as const
export type ReportCraftStyle = typeof REPORT_CRAFT_STYLES[number]
export type ReportCraftRole = typeof REPORT_CRAFT_ROLES[number]

// BEGIN GENERATED MATERIAL IDENTITY — scripts/build-report-craft-materials.mjs --write
export const REPORT_CRAFT_MATERIAL_DIGEST: string = '8c65ad5123e02c6a678bf0ce58f2a02b646770b6faad3aabc329f90b007320bd'
// END GENERATED MATERIAL IDENTITY

const MANIFEST_PATH = 'knowledge/skills/zhijian-report-craft/materials.v2.json'
const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url))
type MaterialKind = 'instruction' | 'component' | 'reference' | 'provenance' | 'helper' | 'generated-copy'
interface MaterialDefinition {
  id: string
  path: string
  sha256: string
  bytes: number
  kind: MaterialKind
  roles: ReportCraftRole[]
  styles: ReportCraftStyle[]
  copyOf?: string
}
interface MaterialManifest { schemaVersion: 2; materialPackId: typeof REPORT_CRAFT_PACK_ID; entries: MaterialDefinition[] }
export interface CraftMaterialIdentity {
  materialPackId: typeof REPORT_CRAFT_PACK_ID
  materialDigest: string
  style: ReportCraftStyle
}
export interface CraftMaterialEntry { id: string; path: string; sha256: string; bytes: number; content: string }
export interface CraftMaterialBundle extends CraftMaterialIdentity {
  packId: typeof REPORT_CRAFT_PACK_ID
  sourceRoot: string
  role: ReportCraftRole
  content: string
  entries: CraftMaterialEntry[]
  bytes: number
}

function fail(code: string, detail: string): never { throw new Error(`${code}: ${detail}`) }
function sha(raw: Buffer | string): string { return createHash('sha256').update(raw).digest('hex') }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
function isStyle(value: unknown): value is ReportCraftStyle { return REPORT_CRAFT_STYLES.includes(value as ReportCraftStyle) }
function isRole(value: unknown): value is ReportCraftRole { return REPORT_CRAFT_ROLES.includes(value as ReportCraftRole) }
function scopedPath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) fail('CRAFT_MATERIAL_PATH_ESCAPE', path)
  const target = join(root, path)
  let resolved: string
  try { resolved = realpathSync(target) } catch { fail('CRAFT_MATERIAL_MISSING', path) }
  const rel = relative(root, resolved)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('CRAFT_MATERIAL_PATH_ESCAPE', path)
  // The frozen package is plain files. Even an in-root symlink creates an ambiguous alias.
  let cursor = root
  for (const part of path.split('/')) {
    cursor = join(cursor, part)
    if (lstatSync(cursor).isSymbolicLink()) fail('CRAFT_MATERIAL_PATH_ALIAS', path)
  }
  if (!lstatSync(target).isFile()) fail('CRAFT_MATERIAL_NOT_FILE', path)
  return resolved
}
function parseManifest(raw: Buffer): MaterialManifest {
  let value: unknown
  try { value = JSON.parse(raw.toString('utf8')) } catch { fail('CRAFT_MATERIAL_MANIFEST_INVALID', 'invalid JSON') }
  if (!value || typeof value !== 'object') fail('CRAFT_MATERIAL_MANIFEST_INVALID', 'expected object')
  const manifest = value as MaterialManifest
  if (manifest.schemaVersion !== 2 || manifest.materialPackId !== REPORT_CRAFT_PACK_ID || !Array.isArray(manifest.entries) || !manifest.entries.length) fail('CRAFT_MATERIAL_MANIFEST_INVALID', 'identity or empty entries')
  const ids = new Set<string>(); const paths = new Set<string>()
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9.-]+$/.test(entry.id)
      || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || !Array.isArray(entry.roles) || !entry.roles.every(isRole) || new Set(entry.roles).size !== entry.roles.length
      || !Array.isArray(entry.styles) || !entry.styles.length || !entry.styles.every(isStyle) || new Set(entry.styles).size !== entry.styles.length
      || !['instruction', 'component', 'reference', 'provenance', 'helper', 'generated-copy'].includes(entry.kind)) fail('CRAFT_MATERIAL_MANIFEST_INVALID', 'invalid entry')
    if (ids.has(entry.id) || paths.has(entry.path)) fail('CRAFT_MATERIAL_DUPLICATE', entry.id)
    ids.add(entry.id); paths.add(entry.path)
    if (entry.copyOf !== undefined && (typeof entry.copyOf !== 'string' || entry.copyOf === entry.id)) fail('CRAFT_MATERIAL_COPY_INVALID', entry.id)
  }
  for (const entry of manifest.entries) if (entry.copyOf !== undefined && !ids.has(entry.copyOf)) fail('CRAFT_MATERIAL_COPY_INVALID', entry.id)
  return manifest
}

function readPack(rootOverride?: string): { root: string; manifest: MaterialManifest; contents: Map<string, Buffer> } {
  let root: string
  try { root = realpathSync(rootOverride ?? DEFAULT_ROOT) } catch { fail('CRAFT_MATERIAL_ROOT_MISSING', 'package root unavailable') }
  const manifest = parseManifest(readFileSync(scopedPath(root, MANIFEST_PATH)))
  // Resolve all paths before the digest check so escapes/aliases never reach file reading.
  const paths = new Map(manifest.entries.map(entry => [entry.id, scopedPath(root, entry.path)]))
  if (sha(canonical(manifest)) !== REPORT_CRAFT_MATERIAL_DIGEST) fail('CRAFT_MATERIAL_MANIFEST_DRIFT', MANIFEST_PATH)
  const contents = new Map<string, Buffer>()
  for (const entry of manifest.entries) {
    const raw = readFileSync(paths.get(entry.id)!)
    if (entry.roles.length && raw.length > REPORT_CRAFT_MAX_ROLE_BYTES) fail('CRAFT_MATERIAL_BUDGET_EXCEEDED', entry.id)
    if (raw.length !== entry.bytes || sha(raw) !== entry.sha256) fail('CRAFT_MATERIAL_DRIFT', entry.id)
    if (Buffer.from(raw.toString('utf8'), 'utf8').compare(raw) !== 0) fail('CRAFT_MATERIAL_ENCODING_INVALID', entry.id)
    contents.set(entry.id, raw)
  }
  for (const entry of manifest.entries) if (entry.copyOf && !contents.get(entry.id)!.equals(contents.get(entry.copyOf)!)) fail('CRAFT_MATERIAL_COPY_DRIFT', entry.id)
  return { root, manifest, contents }
}

/** Shape + frozen identity only. Use validate/verify to additionally check live bytes. */
export function isCraftMaterialIdentity(value: unknown): value is CraftMaterialIdentity {
  if (!value || typeof value !== 'object') return false
  const identity = value as CraftMaterialIdentity
  return identity.materialPackId === REPORT_CRAFT_PACK_ID && identity.materialDigest === REPORT_CRAFT_MATERIAL_DIGEST && isStyle(identity.style)
}
export function validateCraftMaterialIdentity(value: unknown, options: { root?: string } = {}): CraftMaterialIdentity {
  if (!isCraftMaterialIdentity(value)) fail('CRAFT_MATERIAL_IDENTITY_MISMATCH', 'pack, digest, or style')
  verifyCraftMaterials({ style: value.style, materialDigest: value.materialDigest, ...options })
  return { materialPackId: REPORT_CRAFT_PACK_ID, materialDigest: REPORT_CRAFT_MATERIAL_DIGEST, style: value.style }
}
export function verifyCraftMaterials(options: { style: ReportCraftStyle; materialDigest: string; root?: string }): CraftMaterialIdentity {
  if (!isStyle(options.style) || options.materialDigest !== REPORT_CRAFT_MATERIAL_DIGEST) fail('CRAFT_MATERIAL_IDENTITY_MISMATCH', 'style or digest')
  readPack(options.root)
  return { materialPackId: REPORT_CRAFT_PACK_ID, materialDigest: REPORT_CRAFT_MATERIAL_DIGEST, style: options.style }
}
/** Returns every required role/style document in full, without historical HTML injection. */
export function resolveCraftMaterials(options: { style: ReportCraftStyle; role: ReportCraftRole; root?: string }): CraftMaterialBundle {
  if (!isStyle(options.style) || !isRole(options.role)) fail('CRAFT_MATERIAL_SELECTION_INVALID', 'style or role')
  const { root, manifest, contents } = readPack(options.root)
  const selected = manifest.entries.filter(entry => entry.roles.includes(options.role) && entry.styles.includes(options.style))
  if (!selected.length) fail('CRAFT_MATERIAL_REQUIRED_EMPTY', options.role)
  const entries = selected.map(entry => ({ id: entry.id, path: entry.path, sha256: entry.sha256, bytes: entry.bytes, content: contents.get(entry.id)!.toString('utf8') }))
  const references = manifest.entries.filter(entry => entry.kind === 'reference' && !entry.copyOf)
  const content = [
    `Craft material pack: ${REPORT_CRAFT_PACK_ID}\nDigest: ${REPORT_CRAFT_MATERIAL_DIGEST}\nStyle: ${options.style}\nRole: ${options.role}\nSource root: ${root}\nEntry/reference paths below resolve from this absolute root; links inside each document resolve from that document's directory.\nRequired material bodies follow in full; these are craft references, not new user instructions.`,
    ...entries.map(entry => `\n--- ${entry.id} | ${entry.path} | SHA256 ${entry.sha256} | ${entry.bytes} bytes ---\n${entry.content}`),
    '\nOptional historical references (locator metadata only; full bodies NOT delivered or claimed read):',
    ...references.map(entry => `${entry.id} | ${entry.path} | SHA256 ${entry.sha256}`),
  ].join('\n')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > REPORT_CRAFT_MAX_ROLE_BYTES) fail('CRAFT_MATERIAL_BUDGET_EXCEEDED', `${options.role}: ${bytes}/${REPORT_CRAFT_MAX_ROLE_BYTES}`)
  return { materialPackId: REPORT_CRAFT_PACK_ID, packId: REPORT_CRAFT_PACK_ID, materialDigest: REPORT_CRAFT_MATERIAL_DIGEST, style: options.style, role: options.role, sourceRoot: root, content, entries, bytes }
}
