#!/usr/bin/env node
/** Rebuild the full zhijian-realestate pack while preserving its authoritative craft sources. */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { emitPack, compareTrees } from './build-zhijian-pack.mjs'
import { buildReportDomainPack } from './build-zhijian-report-craft.mjs'
import { hashPackageTree, loadPackFromDir } from '../lib/v2/pack-loader.js'

const root = fileURLToPath(new URL('../domain-packs/zhijian-realestate/', import.meta.url))
const CRAFT_PATHS = ['craft', 'checks', 'references', 'skills', 'scripts', 'REPORT-CRAFT.md']
// Scenario-specific authored entities extend the frozen V1 projection. They
// must survive a full rebuild just like authored craft materials.
const AUTHORED_ENTITIES = [
  'scenarios/zhijian-rent-pricing.json',
  'team-templates/zhijian.team.rent-pricing.json',
  'output-templates/zhijian.output.rent-pricing.json',
]

export async function buildZhijianWithCraft({ write = false, packRoot = root } = {}) {
  // Snapshot the complete authored extensions before the legacy generator can
  // clean output sections. Temporary output never becomes a second authority.
  const temp = await mkdtemp(join(tmpdir(), 'zhijian-realestate-craft-build-'))
  const staged = join(temp, 'pack')
  try {
    for (const path of CRAFT_PATHS) await cp(join(packRoot, path), join(temp, 'craft-source', path), { recursive: true })
    for (const path of AUTHORED_ENTITIES) {
      await mkdir(dirname(join(temp, 'craft-source', path)), { recursive: true })
      await cp(join(packRoot, path), join(temp, 'craft-source', path), { force: true }).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
    await emitPack(staged, { srcDir: join(packRoot, 'source'), writeSrc: false })
    for (const path of CRAFT_PATHS) await cp(join(temp, 'craft-source', path), join(staged, path), { recursive: true })
    for (const path of AUTHORED_ENTITIES) await cp(join(temp, 'craft-source', path), join(staged, path), { force: true }).catch(error => { if (error.code !== 'ENOENT') throw error })
    const meta = JSON.parse(await readFile(join(staged, 'pack.json'), 'utf8'))
    // The authored pack is the release source. Keeping its metadata avoids
    // silently rebuilding a 1.6.2 checkout as the previous hard-coded 1.6.0.
    const authoredMeta = JSON.parse(await readFile(join(packRoot, 'pack.json'), 'utf8'))
    if (authoredMeta.id !== meta.id || typeof authoredMeta.version !== 'string' || !authoredMeta.version.trim()
      || typeof authoredMeta.description !== 'string' || !authoredMeta.description.trim()) throw new Error('Authored pack metadata invalid')
    meta.version = authoredMeta.version
    meta.description = authoredMeta.description
    await writeFile(join(staged, 'pack.json'), JSON.stringify(meta, null, 2) + '\n')
    await writeFile(join(staged, 'README.md'), (await readFile(join(staged, 'README.md'), 'utf8'))
      + '\n## 报告工艺\n\n本包提供多个可选择的工艺 skill，参考源、组件、检查和审核要求一并分发；见 [REPORT-CRAFT.md](REPORT-CRAFT.md)。\n')
    await buildReportDomainPack(true, staged)
    const loaded = await loadPackFromDir(staged)
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics))
    const checkFile = join(staged, 'generated/verify.json')
    const verify = JSON.parse(await readFile(checkFile, 'utf8'))
    for (const kind of ['scenarios', 'teamTemplates', 'outputTemplates', 'skillPackages']) verify.entityCounts[kind] = loaded.pack[kind].length
    verify.craftClosure = { packId: meta.id, skillIds: loaded.pack.skillPackages.filter(row => row.craft).map(row => row.id), globalMaterialFallback: false }
    await writeFile(checkFile, JSON.stringify(verify, null, 2) + '\n')
    const generated = ['generated/pack.sha256', 'generated/verify.json', 'generated/roster.md', 'generated/v1/experts.json', 'generated/v1/scenarios.json']
    const digest = await hashPackageTree(staged, { exclude: generated })
    await writeFile(join(staged, 'generated/pack.sha256'), digest + '\n')
    if (write) for (const entry of await readdir(staged)) await cp(join(staged, entry), join(packRoot, entry), { recursive: true, force: true })
    const differences = await compareTrees(packRoot, staged, { exclude: ['.git'] })
    if (differences.length) throw new Error('Full domain-pack build drift: ' + differences.slice(0, 20).join('; '))
    return { status: 'PASS', packId: meta.id, version: meta.version, treeDigest: digest, craftSkillIds: verify.craftClosure.skillIds }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !['--write', '--check'].includes(process.argv[2])) throw new Error('Use --write or --check')
  console.log(JSON.stringify(await buildZhijianWithCraft({ write: process.argv[2] === '--write' })))
}
