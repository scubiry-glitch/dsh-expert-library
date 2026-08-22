/**
 * Deterministic generator + verifier for the `builtin-library` domain pack —
 * V1 retirement step 2: the generic builtin library's V2 pack home.
 *
 * Projects the builtin library (8 generic experts + all 10 builtin scenarios;
 * the 33 zhijian bk-* experts are NOT included — zhijian already has its own
 * pack, `domain-packs/zhijian-realestate/`) into the static
 * `domain-packs/builtin-library/` layout accepted by `loadPackFromDir` /
 * `loadPackFromDirSync`:
 *
 * ```text
 * domain-packs/builtin-library/
 * ├── pack.json                        # metadata-only (legacy projection meta)
 * ├── experts/<generic-expert>.json    # adaptV1Expert views
 * ├── scenarios/<builtin-scenario>.json
 * ├── team-templates/<scenario>.legacy-team.json   # adaptV1ScenarioTeamTemplate
 * ├── output-templates/<scenario>.legacy-output.json
 * ├── quality-policies/<scenario>.legacy-quality.json
 * ├── knowledge-providers/local-knowledge.json
 * ├── generated/
 * │   ├── verify.json                 # loadPackFromDir diagnostics of this emit
 * │   └── pack.sha256                 # tree digest over the non-generated files
 * └── README.md
 * ```
 *
 * Determinism contract: the pack is the **byte-exact projection** of
 * `buildLegacyDomainPack({experts: builtin, scenarios: builtin})` — the same
 * adaptation functions (`adaptV1Expert` / `adaptV1ScenarioTeamTemplate` /
 * `adaptV1Scenario` + legacy output/quality refs) the runtime `adaptV1`
 * fallback uses, imported from `lib/` at generation time (never forked), so
 * compiled plans are **digest-identical** whether the runtime loads the pack
 * or falls back to the projection (golden loop in
 * `test/v2-builtin-pack.test.mjs`).
 *
 * Fatal-on-mismatch: the emit self-verifies through the real
 * `loadPackFromDir` and fails with structured errors on any drift;
 * `--check` re-emits into a temp dir and compares every file with the
 * committed pack.
 *
 * Usage:
 *   node scripts/build-builtin-pack.mjs                # re-emit pack from lib (requires pnpm build)
 *   node scripts/build-builtin-pack.mjs --check [--out <dir>]
 *
 * @module dsh-expert-library/scripts/build-builtin-pack
 */

import { readFile, writeFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildLegacyDomainPack, loadPackFromDir, hashPackageTree } from '../lib/v2/index.js'
import { BUILTIN_EXPERT_BY_ID } from '../lib/expert-library/builtin-experts.js'
import { BUILTIN_SCENARIO_BY_ID } from '../lib/expert-library/builtin-scenarios.js'
import { PackGenError, compareTrees } from './build-zhijian-pack.mjs'

/** Default output pack directory (relative to the repo root). */
export const DEFAULT_PACK_DIR = 'domain-packs/builtin-library'

/** README constant written into the pack root. */
function packReadme(expertCount, scenarioCount) {
  return `# builtin-library（通用内置库 V1 投影包）

${expertCount} 位通用内置专家 + ${scenarioCount} 个内置场景，由
\`scripts/build-builtin-pack.mjs\` 确定性生成（V1 retirement step 2 —— 通用
内置库的 V2 pack 归宿）。智见 bk-* 专家**不在本包内**（其归宿是
\`domain-packs/zhijian-realestate/\`）；运行时在装载本包后从 V1 注册表追加
bk-* 专家，行为与直接投影逐字节一致。

- \`pack.json\` + 各实体目录：\`loadPackFromDir\` / \`loadPackFromDirSync\`
  可装载的 DomainPackV2 布局（metadata-only pack.json + 每实体一个 JSON，
  文件名 == 实体 id）。
- 实体是 \`adaptV1Expert\` / \`adaptV1ScenarioTeamTemplate\` /
  \`adaptV1Scenario\` 的**逐字节投影**（自 \`lib/\` 导入，未分叉），因此
  运行时无论走 pack 路径还是 adaptV1 回退路径，编译出的计划 digest 一致。
- 重建：\`pnpm build && node scripts/build-builtin-pack.mjs\`；漂移检查：
  \`node scripts/build-builtin-pack.mjs --check\`。
`
}

/** Whether a path exists as a regular file. */
async function fileExists(path) {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/**
 * Emit the complete `builtin-library` domain pack into `outDir`.
 *
 * Deterministic: the output tree is byte-identical for the same `lib/` build
 * (canonical entities, sorted writes, no timestamps; `verify.json` carries
 * only path-free diagnostics). Fatal-on-mismatch: the emit is re-loaded
 * through the real `loadPackFromDir` and any error-severity diagnostic aborts
 * the emit with structured errors.
 */
export async function emitPack(outDir, options = {}) {
  const { check = false } = options
  await mkdir(outDir, { recursive: true })
  for (const part of ['pack.json', 'README.md', 'experts', 'scenarios', 'team-templates', 'output-templates', 'quality-policies', 'knowledge-providers', 'generated']) {
    await rm(join(outDir, part), { recursive: true, force: true })
  }

  // ── entities: the byte-exact legacy projection of the generic builtin library ──
  // Only the 8 generic experts — zhijian bk-* experts have their own pack.
  const pack = buildLegacyDomainPack({
    experts: [...BUILTIN_EXPERT_BY_ID.values()],
    scenarios: [...BUILTIN_SCENARIO_BY_ID.values()],
  })

  const written = []
  const generatedFiles = []
  const writeJson = async (rel, value) => {
    const abs = join(outDir, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, `${JSON.stringify(value, null, 2)}\n`)
    written.push(rel)
  }

  await writeJson('pack.json', pack.pack)
  for (const entity of pack.experts) await writeJson(`experts/${entity.id}.json`, entity)
  for (const entity of pack.scenarios) await writeJson(`scenarios/${entity.id}.json`, entity)
  for (const entity of pack.teamTemplates) await writeJson(`team-templates/${entity.id}.json`, entity)
  for (const entity of pack.outputTemplates) await writeJson(`output-templates/${entity.id}.json`, entity)
  for (const entity of pack.qualityPolicies) await writeJson(`quality-policies/${entity.id}.json`, entity)
  for (const entity of pack.knowledgeProviders) await writeJson(`knowledge-providers/${entity.id}.json`, entity)
  await writeFile(join(outDir, 'README.md'), packReadme(pack.experts.length, pack.scenarios.length))
  written.push('README.md')

  // ── self-verification through the real loader (fatal on mismatch) ─────────
  const loaded = await loadPackFromDir(outDir)
  const errors = loaded.diagnostics.filter(d => d.severity === 'error')
  const warnings = loaded.diagnostics.filter(d => d.severity === 'warning')
  const entityCounts = {
    experts: pack.experts.length,
    scenarios: pack.scenarios.length,
    teamTemplates: pack.teamTemplates.length,
    outputTemplates: pack.outputTemplates.length,
    qualityPolicies: pack.qualityPolicies.length,
    knowledgeProviders: pack.knowledgeProviders.length,
  }
  await writeJson('generated/verify.json', {
    ok: loaded.ok,
    errorCount: errors.length,
    warningCount: warnings.length,
    diagnostics: loaded.diagnostics,
    entityCounts,
  })
  generatedFiles.push('generated/verify.json')

  // ── tree digest over the non-generated files ───────────────────────────────
  generatedFiles.push('generated/pack.sha256')
  const hash = await hashPackageTree(outDir, { exclude: generatedFiles })
  await writeFile(join(outDir, 'generated/pack.sha256'), `${hash}\n`)

  if (!loaded.ok) {
    throw new PackGenError(errors.map(e => ({ code: e.code, message: `${e.path}: ${e.message}` })))
  }

  return {
    ok: true,
    hash,
    expertCount: pack.experts.length,
    entityCounts,
    errorCount: errors.length,
    warningCount: warnings.length,
    files: written.length + generatedFiles.length,
  }
}

/** CLI entry. */
async function main() {
  const args = { out: resolve(DEFAULT_PACK_DIR), check: false }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') args.out = resolve(argv[++i])
    else if (arg === '--check') args.check = true
    else {
      console.error('usage: node scripts/build-builtin-pack.mjs [--out <dir>] [--check]')
      process.exit(2)
    }
  }

  try {
    if (args.check) {
      const tmp = await mkdtemp(join(tmpdir(), 'builtin-pack-check-'))
      const result = await emitPack(tmp, { check: true })
      const diffs = await compareTrees(args.out, tmp)
      await rm(tmp, { recursive: true, force: true })
      if (diffs.length > 0) {
        console.error(`CHECK FAILED — ${diffs.length} difference(s) between ${args.out} and a fresh emit:`)
        for (const diff of diffs.slice(0, 40)) console.error(`  - ${diff}`)
        process.exit(1)
      }
      console.log(`CHECK CLEAN ✓ ${result.files} files identical, tree sha256 ${result.hash} (${result.expertCount} experts)`)
      return
    }
    const result = await emitPack(args.out)
    console.log(`pack emitted → ${args.out}`)
    console.log(`  ${result.expertCount} experts, ${result.entityCounts.scenarios} scenarios, ${result.entityCounts.teamTemplates} team templates, ${result.entityCounts.outputTemplates} output templates`)
    console.log(`  ${result.entityCounts.qualityPolicies} quality policies, ${result.entityCounts.knowledgeProviders} knowledge providers`)
    console.log(`  loadPackFromDir: ok=${result.ok} errors=${result.errorCount} warnings=${result.warningCount}`)
    console.log(`  tree sha256 (non-generated): ${result.hash}`)
  } catch (error) {
    if (error instanceof PackGenError) {
      console.error(`pack generation FAILED (${error.errors.length} error(s)):`)
      for (const e of error.errors) console.error(`  [${e.code}] ${e.message}`)
    } else {
      console.error(`pack generation FAILED: ${error.stack ?? error}`)
    }
    process.exit(1)
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) await main()
