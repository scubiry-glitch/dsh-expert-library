#!/usr/bin/env node
/** Deterministic developer sync and install/export check. No fetch or model calls. */
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACK = 'zhijian-report-craft-v2'
const ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))
const CRAFT = 'knowledge/skills/zhijian-report-craft'
const RENDER = 'knowledge/skills/zhijian-designer-render'
const STYLES = ['credit-policy', 'designer-paper']
const ROLES = ['writer', 'renderer', 'reviewer']
const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const need = (value, message) => { if (!value) throw new Error(message) }

async function files(directory) {
  const out = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    need(!entry.isSymbolicLink(), `Symlink forbidden: ${path}`)
    if (entry.isDirectory()) out.push(...await files(path))
    else if (entry.isFile()) out.push(path)
  }
  return out.sort()
}
function classification(path) {
  const suffix = path.slice(CRAFT.length + 1)
  if (path === `${CRAFT}/SKILL.md`) return { roles: ['writer', 'reviewer'], styles: STYLES, kind: 'instruction' }
  if (path === `${RENDER}/SKILL.md`) return { roles: ['renderer'], styles: STYLES, kind: 'instruction' }
  if (['core-v2.md', 'data-v2.md', 'acceptance-v2.md', 'evidence-ledger-v2.md'].some(name => suffix === `references/${name}`)) return { roles: ROLES, styles: STYLES, kind: 'instruction' }
  if (suffix === 'references/writing-v2.md') return { roles: ROLES, styles: STYLES, kind: 'instruction' }
  if (suffix === 'references/review-v2.md') return { roles: ['reviewer'], styles: STYLES, kind: 'instruction' }
  if (suffix === 'references/render-v2.md') return { roles: ['renderer', 'reviewer'], styles: STYLES, kind: 'instruction' }
  for (const style of STYLES) {
    if (suffix === `references/style-${style}-v2.md`) return { roles: ROLES, styles: [style], kind: 'instruction' }
    if (suffix === `references/components/${style}-v2.css`) return { roles: ['renderer'], styles: [style], kind: 'component' }
  }
  if (suffix.startsWith('references/components/')) return { roles: ['renderer'], styles: STYLES, kind: 'component' }
  if (suffix === 'references/zhijian-credit-policy-v1.html' || suffix === 'references/zhijian-designer-v1.html') return { roles: [], styles: STYLES, kind: 'reference' }
  return { roles: [], styles: STYLES, kind: path.includes('provenance') || path.includes('source-archives/') ? 'provenance' : 'helper' }
}
const idFor = path => path.replace(/^knowledge\/skills\//, '').replace(/[^a-z0-9]+/g, '.').replace(/\.$/, '')

export async function buildCraftMaterials({ write = false, exportRender } = {}) {
  const required = ['core-v2.md', 'writing-v2.md', 'data-v2.md', 'acceptance-v2.md', 'evidence-ledger-v2.md', 'review-v2.md', 'render-v2.md',
    ...STYLES.map(style => `style-${style}-v2.md`), 'components/base-v2.css', 'components/components-v2.html', 'components/document-shell-v2.html',
    ...STYLES.map(style => `components/${style}-v2.css`), 'source-provenance-v2.json']
  for (const path of [`${CRAFT}/SKILL.md`, `${RENDER}/SKILL.md`, `${CRAFT}/scripts/preflight-report.mjs`, ...required.map(name => `${CRAFT}/references/${name}`)]) {
    need((await stat(join(ROOT, path))).isFile(), `Required material missing: ${path}`)
  }
  const historical = [
    ['zhijian-credit-policy-v1.html', 'd145f887cfd918dfa7e021029feb109211871fd8adfeddfd2715060b148f5f86'],
    ['zhijian-designer-v1.html', 'b25f9db892c52a78555f4016ad534714216ba2dd80c2966a40d0498106c3d408'],
  ]
  for (const [name, digest] of historical) need(hash(await readFile(join(ROOT, CRAFT, 'references', name))) === digest, `Historical reference changed: ${name}`)
  const copies = []
  for (const source of await files(join(ROOT, CRAFT, 'references'))) {
    const suffix = relative(join(ROOT, CRAFT), source).split('\\').join('/')
    copies.push({ source: `${CRAFT}/${suffix}`, target: `${RENDER}/${suffix}` })
  }
  for (const [source, target] of [
    ['zhijian-credit-policy-v1.html', 'credit-policy-v1.html'], ['zhijian-designer-v1.html', 'designer-v1.html'],
  ]) copies.push({ source: `${CRAFT}/references/${source}`, target: `${RENDER}/references/${target}` })
  for (const source of await files(join(ROOT, CRAFT, 'references/components'))) copies.push({ source: relative(ROOT, source), target: `${RENDER}/assets/${relative(join(ROOT, CRAFT, 'references/components'), source)}` })
  copies.push({ source: `${CRAFT}/references/components/components-v2.html`, target: `${RENDER}/chart-templates.html` })
  copies.push({ source: `${CRAFT}/scripts/preflight-report.mjs`, target: `${RENDER}/scripts/preflight-report.mjs` })
  for (const copy of copies) {
    const original = await readFile(join(ROOT, copy.source))
    if (write) { await mkdir(dirname(join(ROOT, copy.target)), { recursive: true }); await writeFile(join(ROOT, copy.target), original) }
    else need(original.equals(await readFile(join(ROOT, copy.target))), `Generated copy drift: ${copy.target}`)
  }
  const renderEntries = []
  for (const path of await files(join(ROOT, RENDER))) {
    if (path.endsWith('/materials.generated.json')) continue
    const raw = await readFile(path)
    renderEntries.push({ id: idFor(relative(ROOT, path)), path: relative(join(ROOT, RENDER), path).split('\\').join('/'), bytes: raw.length, sha256: hash(raw) })
  }
  const copyManifest = `${JSON.stringify({ schemaVersion: 1, materialPackId: PACK, entries: renderEntries }, null, 2)}\n`
  const copyManifestPath = join(ROOT, RENDER, 'materials.generated.json')
  if (write) await writeFile(copyManifestPath, copyManifest)
  else need((await readFile(copyManifestPath, 'utf8')) === copyManifest, 'Standalone render manifest drift')
  const entries = []
  for (const path of [...await files(join(ROOT, CRAFT)), ...await files(join(ROOT, RENDER))].sort()) {
    if (path === join(ROOT, CRAFT, 'materials.v2.json')) continue
    const local = relative(ROOT, path).split('\\').join('/'); const raw = await readFile(path)
    const copy = copies.find(item => item.target === local)
    entries.push({ id: idFor(local), path: local, bytes: raw.length, sha256: hash(raw),
      ...(copy ? { roles: [], styles: STYLES, kind: 'generated-copy', copyOf: idFor(copy.source) } : classification(local)) })
  }
  need(new Set(entries.map(item => item.id)).size === entries.length, 'Duplicate material id')
  need(new Set(entries.map(item => item.path)).size === entries.length, 'Duplicate material path')
  const manifest = { schemaVersion: 2, materialPackId: PACK, entries }
  const digest = hash(canonical(manifest)); const manifestPath = join(ROOT, CRAFT, 'materials.v2.json')
  const sourcePath = join(ROOT, 'src/report-craft-materials.ts')
  if (write) {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const source = await readFile(sourcePath, 'utf8')
    const updated = source.replace(/(\/\/ BEGIN GENERATED MATERIAL IDENTITY[^\n]*\n)[\s\S]*?(\/\/ END GENERATED MATERIAL IDENTITY)/,
      `$1export const REPORT_CRAFT_MATERIAL_DIGEST: string = '${digest}'\n$2`)
    need(source !== updated || source.includes(digest), 'Generated identity markers missing')
    await writeFile(sourcePath, updated)
  } else need(canonical(JSON.parse(await readFile(manifestPath, 'utf8'))) === canonical(manifest), 'Material manifest out of date')
  let runtime
  try { runtime = await import(pathToFileURL(sourcePath).href + `?digest=${digest}`) }
  catch (error) {
    if (write) throw error
    runtime = await import(pathToFileURL(join(ROOT, 'lib/report-craft-materials.js')).href)
  }
  need(runtime.REPORT_CRAFT_MATERIAL_DIGEST === digest, 'Compiled material identity differs')
  const bundles = []
  for (const style of STYLES) for (const role of ROLES) {
    const bundle = runtime.resolveCraftMaterials({ style, role })
    bundles.push({ style, role, bytes: bundle.bytes, entries: bundle.entries.length })
  }
  if (exportRender !== undefined) {
    need(isAbsolute(exportRender), 'Export target must be absolute')
    const destination = resolve(exportRender)
    const physicalRoot = await realpath(ROOT)
    const physicalDestination = join(await realpath(dirname(destination)), basename(destination))
    need(physicalDestination !== physicalRoot && !physicalDestination.startsWith(`${physicalRoot}${sep}`), 'Export outside source package only')
    try { await stat(destination); throw new Error('Export target already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
    await cp(join(ROOT, RENDER), destination, { recursive: true, errorOnExist: true, force: false })
  }
  return { status: 'PASS', materialPackId: PACK, materialDigest: digest, files: entries.length, generatedCopies: copies.length, roleBundles: bundles, ...(exportRender ? { exportedRender: exportRender } : {}) }
}

export async function main(args = process.argv.slice(2)) {
  need(args.length === 1 && ['--check', '--write'].includes(args[0]) || args.length === 2 && args[0] === '--export-render', 'Use --check, --write, or --export-render /absolute/new-directory')
  const result = await buildCraftMaterials({ write: args[0] === '--write', exportRender: args[0] === '--export-render' ? args[1] : undefined })
  console.log(JSON.stringify(result))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
