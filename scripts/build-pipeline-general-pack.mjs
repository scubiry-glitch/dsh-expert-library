/**
 * Deterministic generator + verifier for the `pipeline-general` domain pack —
 * built on the SAME shared machinery as zhijian/bank packs (pack-common:
 * emitPackEntities / finalizePack / compareTrees) and the SAME V2 builders
 * (buildPipelineGeneralDomainPack reuses zhijian/bank template/output/method/quality
 * constructors with a pipeline-general prefix). No parallel pack machinery.
 *
 * The pack's `source/` is written by scripts/sync-pipeline-experts.mjs
 * (线上专家库归一化，S 特级/XHS) —— 本发射器只在重建时把 source 逐字节保留并自验。
 *
 * Usage:
 *   node scripts/build-pipeline-general-pack.mjs                # re-emit pack from lib
 *   node scripts/build-pipeline-general-pack.mjs --check [--out <dir>]
 *
 * @module dsh-expert-library/scripts/build-pipeline-general-pack
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildPipelineGeneralDomainPack, GENERAL_PACK_ID, GENERAL_PACK_VERSION } from '../lib/v2/pipeline-general-pack.js'
import { GENERAL_EXPERTS } from '../lib/pipeline-general/data/experts.generated.js'
import {
  PackGenError,
  checkPackEmit,
  copyBytes,
  copyTree,
  emitPackEntities,
  fileExists,
  finalizePack,
  sha256Of,
} from './pack-common.mjs'

/** Default output pack directory (relative to the repo root). */
export const DEFAULT_GENERAL_PACK_DIR = 'domain-packs/pipeline-general'

/** Pack baseline facts recorded in SOURCE-MANIFEST.json. */
export const PIPELINE_BASELINES = [
  {
    version: '1.0.0',
    source: 'paper.morning.rocks/api/v1/expert-library（scripts/sync-pipeline-experts.mjs 归一化，2026-08-23）',
    date: '2026-08-23T00:00:00Z',
    snapshot: 'pipeline-v1-2026-08-23',
    expertCount: 22,
    note: '首发：E01 宏观经济 9 / E08 房地产 10 / E13 江苏银行 3。公众人物实名，classification/initials 由 sync 脚本确定性推导。',
  },
]

/**
 * Copy the source assets into `<out>/source/`: raw Profile JSONs
 * (byte-identical), authored docs, and SOURCE-MANIFEST.json with per-file
 * sha-256. Missing assets are fatal (losslessness is a hard contract).
 */
export async function copyPipelineSourceAssets(srcDir, outDir) {
  const errors = []
  const sourceRoot = join(outDir, 'source')
  await rm(sourceRoot, { recursive: true, force: true })

  const rawRoot = join(srcDir, 'raw-profiles')
  let rawFiles = {}
  let entries = []
  try {
    entries = await readdir(rawRoot)
  } catch (error) {
    errors.push({ code: 'raw-profiles-missing', message: `cannot list ${rawRoot}: ${String(error)}` })
  }
  for (const name of entries.filter(f => f.endsWith('.json')).sort()) {
    rawFiles[name] = await copyBytes(join(rawRoot, name), join(sourceRoot, 'raw-profiles', name))
  }

  const docs = {}
  for (const name of ['专家总表.md']) {
    const source = join(srcDir, 'docs', name)
    if (!(await fileExists(source))) {
      errors.push({ code: 'doc-missing', message: `${source}: source doc missing` })
      continue
    }
    docs[name] = await copyBytes(source, join(sourceRoot, 'docs', name))
  }
  if (errors.length > 0) throw new PackGenError(errors)

  const manifest = {
    packId: GENERAL_PACK_ID,
    packVersion: GENERAL_PACK_VERSION,
    schemaVersion: 2,
    baselines: PIPELINE_BASELINES,
    rawProfiles: { count: Object.keys(rawFiles).length, files: rawFiles },
    docs: { count: Object.keys(docs).length, files: docs },
  }
  await writeFile(join(sourceRoot, 'SOURCE-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/** Verify an existing `<out>/source/`: every recorded file must match its sha-256. */
export async function verifyPipelineSourceAssets(outDir) {
  const sourceRoot = join(outDir, 'source')
  const manifestPath = join(sourceRoot, 'SOURCE-MANIFEST.json')
  if (!(await fileExists(manifestPath))) {
    throw new PackGenError([{ code: 'source-manifest-missing', message: `${sourceRoot}/SOURCE-MANIFEST.json missing — emit once with --src first` }])
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const groups = [
    ['rawProfiles', 'raw-profiles'],
    ['docs', 'docs'],
  ]
  for (const [groupKey, dirName] of groups) {
    for (const [name, expected] of Object.entries(manifest[groupKey]?.files ?? {}).sort()) {
      const actual = sha256Of(await readFile(join(sourceRoot, dirName, name)))
      if (actual !== expected) {
        throw new PackGenError([{ code: 'source-tampered', message: `${join(sourceRoot, dirName, name)}: sha256 ${actual} does not match manifest ${expected}` }])
      }
    }
  }
  return manifest
}

/** README constant written into the pack root. */
function pipelinePackReadme(experts) {
  return `# pipeline-general（pipeline 特级专家领域包）v${GENERAL_PACK_VERSION}

${experts.length} 位 pipeline 专家库归一化专家（E01 宏观 / E08 房地产 / E13 江苏银行，
公众人物实名），source 由 \`scripts/sync-pipeline-experts.mjs\` 从线上专家库同步，
包实体由 \`scripts/build-pipeline-general-pack.mjs\` 确定性生成（复用 zhijian/bank 发射器）。

- \`quality-policies/pipeline.quality.json\`：含 \`pii-redaction\` 硬门（银行敏感数据脱敏）。
- 重建：\`pnpm build && node scripts/build-pipeline-general-pack.mjs\`；
  漂移检查：\`node scripts/build-pipeline-general-pack.mjs --check\`；
  重新同步：\`node scripts/sync-pipeline-experts.mjs [--namespaces E01,E08,E13]\`。
`
}

/**
 * Emit the complete pipeline domain pack into `outDir`.
 * Deterministic: the output tree is byte-identical for the same lib build.
 * With `--src` the whole tree is rebuilt (source assets staged before the
 * reset — the srcDir may be the pack's own embedded source); without it the
 * entity/generated parts are rebuilt while an existing `source/` is kept and
 * verified.
 */
export async function emitGeneralPack(outDir, options = {}) {
  const { srcDir } = options
  let manifest = null
  let staging = null
  if (srcDir !== undefined) {
    staging = await mkdtemp(join(tmpdir(), 'pipeline-pack-src-'))
    manifest = await copyPipelineSourceAssets(srcDir, staging)
  }
  try {
    if (srcDir !== undefined) {
      await rm(outDir, { recursive: true, force: true })
    } else {
      for (const part of ['pack.json', 'README.md', 'experts', 'scenarios', 'team-templates', 'output-templates', 'quality-policies', 'knowledge-providers', 'domain-knowledge', 'method-packs', 'routing', 'generated']) {
        await rm(join(outDir, part), { recursive: true, force: true })
      }
    }
    await mkdir(outDir, { recursive: true })

    const pack = buildPipelineGeneralDomainPack()
    const { written, entityCounts } = await emitPackEntities(pack, outDir)
    await writeFile(join(outDir, 'README.md'), pipelinePackReadme(GENERAL_EXPERTS))
    written.push('README.md')

    // routing overlay（包切片：只含 pipeline 话题与场景）
    const routing = {
      topics: [
        { topic: '房地产企业经营（房企经营、平台经济、服务品质、不动产金融、物业）', framework: 'B', primaryField: '房地产', preferredTags: ['实操', '研判'] },
        { topic: '宏观经济与资本市场（宏观、利率、汇率、资本市场、资产配置）', framework: 'B', primaryField: '宏观经济', preferredTags: ['研判', '理论'] },
        { topic: '银行战略与经营（银行战略、量化目标、数智化转型、零售网络金融）', framework: 'B', primaryField: '江苏银行高层', preferredTags: ['实操', '数据'] },
      ],
      scenarios: ['pipeline-general'],
      qualityPolicyId: 'pipeline.quality',
    }
    await mkdir(join(outDir, 'routing'), { recursive: true })
    await writeFile(join(outDir, 'routing', 'routing.json'), `${JSON.stringify(routing, null, 2)}\n`)
    written.push('routing/routing.json')

    // source assets: lossless raw profiles + docs（staged before the reset）
    if (staging !== null) {
      await copyTree(join(staging, 'source'), join(outDir, 'source'))
    } else {
      try {
        manifest = await verifyPipelineSourceAssets(outDir)
      } catch (error) {
        if (!(error instanceof PackGenError && error.errors.some(e => e.code === 'source-manifest-missing'))) throw error
      }
    }

    const finalized = await finalizePack(outDir, { written, generatedFiles: [], entityCounts })
    return {
      ok: true,
      hash: finalized.hash,
      expertCount: pack.experts.length,
      entityCounts,
      errorCount: finalized.errorCount,
      warningCount: finalized.warningCount,
      files: finalized.files,
      hasSource: manifest !== null,
    }
  } finally {
    if (staging !== null) await rm(staging, { recursive: true, force: true })
  }
}

/** pipeline 场景 id（routing overlay 用，避免循环导入）。 */
const GENERAL_SCENARIO_IDS = ['pipeline-general']

/** CLI entry. */
async function main() {
  const args = { srcDir: undefined, out: resolve(DEFAULT_GENERAL_PACK_DIR), check: false }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--src') args.srcDir = resolve(argv[++i])
    else if (arg === '--out') args.out = resolve(argv[++i])
    else if (arg === '--check') args.check = true
    else {
      console.error('usage: node scripts/build-pipeline-general-pack.mjs [--src <dir>] [--out <dir>] [--check]')
      process.exit(2)
    }
  }
  try {
    if (args.check) {
      const checkSrc = args.srcDir ?? (await fileExists(join(args.out, 'source', 'SOURCE-MANIFEST.json'))
        ? join(args.out, 'source')
        : undefined)
      const result = await checkPackEmit('pipeline-general', args.out, emitGeneralPack, checkSrc === undefined ? {} : { srcDir: checkSrc })
      console.log(`CHECK CLEAN ✓ ${result.files} files identical, tree sha256 ${result.hash} (${result.expertCount} experts)`)
      return
    }
    const result = await emitGeneralPack(args.out, { srcDir: args.srcDir })
    console.log(`pack emitted → ${args.out}`)
    console.log(`  ${result.expertCount} experts, ${result.entityCounts.scenarios} scenarios, ${result.entityCounts.teamTemplates} team template, ${result.entityCounts.outputTemplates} output template`)
    console.log(`  loadPackFromDir: ok=${result.ok} errors=${result.errorCount} warnings=${result.warningCount}`)
    console.log(`  tree sha256 (non-generated): ${result.hash}`)
    console.log(`  source assets: ${result.hasSource ? 'copied + hashed' : 'verified (existing)'}`)
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
