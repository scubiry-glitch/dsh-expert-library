#!/usr/bin/env node
/** Rebuild the full zhijian-realestate pack while preserving its authoritative craft sources. */
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { emitPack, compareTrees } from './build-zhijian-pack.mjs'
import { buildReportDomainPack } from './build-zhijian-report-craft.mjs'
import { hashPackageTree, loadPackFromDir } from '../lib/v2/pack-loader.js'

const root = fileURLToPath(new URL('../domain-packs/zhijian-realestate/', import.meta.url))
const CRAFT_PATHS = ['craft', 'checks', 'references', 'skills', 'scripts', 'REPORT-CRAFT.md']

export async function buildZhijianWithCraft({ write = false, packRoot = root } = {}) {
  // Snapshot the complete authored extensions before the legacy generator can
  // clean output sections. Temporary output never becomes a second authority.
  const temp = await mkdtemp(join(tmpdir(), 'zhijian-realestate-craft-build-'))
  const staged = join(temp, 'pack')
  try {
    for (const path of CRAFT_PATHS) await cp(join(packRoot, path), join(temp, 'craft-source', path), { recursive: true })
    await emitPack(staged, { srcDir: join(packRoot, 'source'), writeSrc: false })
    for (const path of CRAFT_PATHS) await cp(join(temp, 'craft-source', path), join(staged, path), { recursive: true })
    const meta = JSON.parse(await readFile(join(staged, 'pack.json'), 'utf8'))
    meta.version = '1.3.1'
    meta.description += ' 1.3.0：领域包闭环多工艺由 AI 选择，计算单位与资金平衡、政策原文证据绑定及独立审核。 1.3.1：可选包内 MD 单源生成与锚点清单，独立审核门禁保持。'
    await writeFile(join(staged, 'pack.json'), JSON.stringify(meta, null, 2) + '\n')
    await writeFile(join(staged, 'README.md'), (await readFile(join(staged, 'README.md'), 'utf8'))
      + '\n## 报告工艺\n\n本包提供多个可选择的工艺 skill，参考源、组件、检查和审核要求一并分发；见 [REPORT-CRAFT.md](REPORT-CRAFT.md)。\n')
    await buildReportDomainPack(true, staged)
    const loaded = await loadPackFromDir(staged)
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics))
    const checkFile = join(staged, 'generated/verify.json')
    const verify = JSON.parse(await readFile(checkFile, 'utf8'))
    verify.entityCounts.skillPackages = loaded.pack.skillPackages.length
    verify.craftClosure = { packId: meta.id, skillIds: loaded.pack.skillPackages.filter(row => row.craft).map(row => row.id), globalMaterialFallback: false }
    await writeFile(checkFile, JSON.stringify(verify, null, 2) + '\n')
    const generated = ['generated/pack.sha256', 'generated/verify.json', 'generated/roster.md', 'generated/v1/experts.json', 'generated/v1/scenarios.json']
    const digest = await hashPackageTree(staged, { exclude: generated })
    await writeFile(join(staged, 'generated/pack.sha256'), digest + '\n')
    if (write) for (const entry of await readdir(staged)) await cp(join(staged, entry), join(packRoot, entry), { recursive: true, force: true })
    const differences = await compareTrees(packRoot, staged)
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
