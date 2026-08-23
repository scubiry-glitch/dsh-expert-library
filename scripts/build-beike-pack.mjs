/**
 * Deterministic generator + verifier for the `beike` domain pack — built on
 * the SAME shared machinery as every other pack (pack-common:
 * emitPackEntities / finalizePack / compareTrees) and the SAME V2 builders
 * (buildBeikeDomainPack reuses zhijian/bank template/output/method/quality
 * constructors with a beike prefix). No parallel pack machinery.
 *
 * 与其它包不同，beike 没有独立 source/（专家为跨命名空间交叉投影，来自共享
 * 注册表 meta），故发射器只做实体写入 + 自验 + 树摘要。
 *
 * Usage:
 *   node scripts/build-beike-pack.mjs                # re-emit pack from lib
 *   node scripts/build-beike-pack.mjs --check [--out <dir>]
 *
 * @module dsh-expert-library/scripts/build-beike-pack
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildBeikeDomainPack, BEIKE_PACK_ID, BEIKE_PACK_VERSION } from '../lib/v2/beike-pack.js'
import { beikeExpertMetas } from '../lib/v2/beike-pack.js'
import { PackGenError, checkPackEmit, emitPackEntities, finalizePack } from './pack-common.mjs'

/** Default output pack directory (relative to the repo root). */
export const DEFAULT_BEIKE_PACK_DIR = 'domain-packs/beike'

/** README constant written into the pack root. */
function beikePackReadme(metas) {
  return `# beike（贝壳生态领域包）v${BEIKE_PACK_VERSION}

${metas.length} 位贝壳生态相关专家（交叉投影：BK 居住服务派 5 位 + 左晖 e08-08 +
一濛 e04-05），由 \`scripts/build-beike-pack.mjs\` 确定性生成（复用 zhijian/bank
发射器与模板/质量/方法构建器，专家实体按 id 引用共享注册表，不重复注册）。

- 场景：\`beike-ecosystem\`（贝壳生态与居住服务）、\`beike-rental-supply-chain\`
  （长租与租赁供应链）。
- 知识库：\`beike.99wiki\`（本地 99wiki 的 projects/贝壳x江苏银行、贝壳合作方案、
  VLC租房平台 + feishu 贝壳纪要）。
- 口径：贝壳成出口径（bk-031 陶琦）与克而瑞/中指/统计局均有差异，须标注；
  陶琦 bk-031 为内测对比项，对外交付不引用。
- 重建：\`pnpm build && node scripts/build-beike-pack.mjs\`；
  漂移检查：\`node scripts/build-beike-pack.mjs --check\`。
`
}

/**
 * Emit the complete beike domain pack into `outDir`.
 * Deterministic: the output tree is byte-identical for the same lib build.
 */
export async function emitBeikePack(outDir) {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const pack = buildBeikeDomainPack()
  const metas = beikeExpertMetas()
  const { written, entityCounts } = await emitPackEntities(pack, outDir)
  await writeFile(join(outDir, 'README.md'), beikePackReadme(metas))
  written.push('README.md')

  const finalized = await finalizePack(outDir, { written, generatedFiles: [], entityCounts })
  return {
    ok: true,
    hash: finalized.hash,
    expertCount: pack.experts.length,
    entityCounts,
    errorCount: finalized.errorCount,
    warningCount: finalized.warningCount,
    files: finalized.files,
  }
}

/** CLI entry. */
async function main() {
  const args = { out: resolve(DEFAULT_BEIKE_PACK_DIR), check: false }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') args.out = resolve(argv[++i])
    else if (arg === '--check') args.check = true
    else {
      console.error('usage: node scripts/build-beike-pack.mjs [--out <dir>] [--check]')
      process.exit(2)
    }
  }
  try {
    if (args.check) {
      const result = await checkPackEmit('beike', args.out, emitBeikePack)
      console.log(`CHECK CLEAN ✓ ${result.files} files identical, tree sha256 ${result.hash} (${result.expertCount} experts)`)
      return
    }
    const result = await emitBeikePack(args.out)
    console.log(`pack emitted → ${args.out}`)
    console.log(`  ${result.expertCount} experts, ${result.entityCounts.scenarios} scenarios, ${result.entityCounts.teamTemplates} team template, ${result.entityCounts.outputTemplates} output template`)
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
