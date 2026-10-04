#!/usr/bin/env node
/** Build domain-owned checkers and skill manifests. Does not copy from global skill directories. */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { canonicalSkillDigest, loadPackFromDir, loadSkillPackageFromDir } from '../lib/v2/pack-loader.js'

const root = fileURLToPath(new URL('../domain-packs/zhijian-realestate/', import.meta.url))
export async function buildReportDomainPack(write = false, packRoot = root) {
  const root = packRoot
  for (const name of (await readdir(join(root, 'checks/source'))).filter(name => name.endsWith('.ts')).sort()) {
    const source = await readFile(join(root, 'checks/source', name), 'utf8')
    const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, removeComments: false } }).outputText
      .replace(/from '(\.\/[^']+)\.ts'/g, "from '$1.mjs'")
    const target = join(root, 'checks', name.replace(/\.ts$/, '.mjs'))
    if (write) await writeFile(target, emitted)
    else if (await readFile(target, 'utf8') !== emitted) throw new Error(`domain checker build drift: ${name}`)
  }
  for (const id of ['zhijian-report-craft', 'zhijian-designer-render']) {
    const manifest = {
      id, name: id, version: id === 'zhijian-designer-render' ? '1.1.1' : '1.1.0', schemaVersion: 2,
      source: { kind: 'workspace', root: `skills/${id}`, digest: '' },
      contributions: {}, permissions: { execScripts: ['scripts/check.mjs'], internalOnly: true },
      craft: { path: `craft/${id}.json` },
    }
    manifest.source.digest = await canonicalSkillDigest(join(root, 'skills', id), manifest)
    const raw = JSON.stringify(manifest, null, 2) + '\n'
    for (const target of [join(root, 'skills', id, 'skill.json'), join(root, 'skill-packages', `${id}.json`)]) {
      if (write) await writeFile(target, raw)
      else if (await readFile(target, 'utf8') !== raw) throw new Error(`domain skill manifest drift: ${id}`)
    }
    const loaded = await loadSkillPackageFromDir(join(root, 'skills', id), { rootBase: root })
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics))
  }
  const loaded = await loadPackFromDir(root)
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics))
  return { status: 'PASS', packId: loaded.pack.pack.id, craftSkills: loaded.pack.skillPackages.filter(row => row.craft).map(row => row.id), craftGlobalSkillDependencies: 0 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !['--write', '--check'].includes(process.argv[2])) throw new Error('Use --write or --check')
  console.log(JSON.stringify(await buildReportDomainPack(process.argv[2] === '--write')))
}
