/**
 * Multi-pack driver — the single entry for building/verifying every domain
 * pack in the repository (整合设计：一个发射器 + 一个驱动；每个包只声明
 * "builder + source + 目录"，不各自实现打包机制).
 *
 * Pack registry:
 *   zhijian-realestate  → scripts/build-zhijian-pack.mjs（emitPack）
 *   bank-finance        → scripts/build-bank-pack.mjs（emitBankPack）
 *   pipeline-domains    → scripts/build-pipeline-pack.mjs（emitPipelinePack）
 *   pipeline-general    → scripts/build-pipeline-general-pack.mjs（emitGeneralPack）
 *   beike               → scripts/build-beike-pack.mjs（emitBeikePack，交叉投影包）
 *
 * Usage:
 *   node scripts/build-packs.mjs                    # build every pack from lib
 *   node scripts/build-packs.mjs <pack-id>          # build one pack
 *   node scripts/build-packs.mjs --check [<pack-id>]  # drift-check one or all
 *
 * @module dsh-expert-library/scripts/build-packs
 */

import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stat } from 'node:fs/promises'

import { emitPack } from './build-zhijian-pack.mjs'
import { emitBankPack, DEFAULT_BANK_PACK_DIR } from './build-bank-pack.mjs'
import { emitPipelinePack, DEFAULT_PIPELINE_PACK_DIR } from './build-pipeline-pack.mjs'
import { emitGeneralPack, DEFAULT_GENERAL_PACK_DIR } from './build-pipeline-general-pack.mjs'
import { emitBeikePack, DEFAULT_BEIKE_PACK_DIR } from './build-beike-pack.mjs'
import { checkPackEmit, PackGenError } from './pack-common.mjs'

/** Default zhijian pack dir (mirrors build-zhijian-pack.mjs). */
const ZHIJIAN_PACK_DIR = 'domain-packs/zhijian-realestate'

/** Pack registry: id → { dir, emit }. Every pack shares the same driver path. */
const PACKS = {
  'zhijian-realestate': {
    dir: ZHIJIAN_PACK_DIR,
    emit: (outDir, opts) => emitPack(outDir, opts),
  },
  'bank-finance': {
    dir: DEFAULT_BANK_PACK_DIR,
    emit: (outDir, opts) => emitBankPack(outDir, opts),
  },
  'pipeline-domains': {
    dir: DEFAULT_PIPELINE_PACK_DIR,
    emit: (outDir, opts) => emitPipelinePack(outDir, opts),
  },
  'pipeline-general': {
    dir: DEFAULT_GENERAL_PACK_DIR,
    emit: (outDir, opts) => emitGeneralPack(outDir, opts),
  },
  'beike': {
    dir: DEFAULT_BEIKE_PACK_DIR,
    emit: (outDir) => emitBeikePack(outDir),
  },
}

/** Whether the pack's embedded source manifest exists (drift-check uses it). */
async function embeddedSourceDir(outDir) {
  try {
    const info = await stat(join(outDir, 'source', 'SOURCE-MANIFEST.json'))
    return info.isFile() ? join(outDir, 'source') : undefined
  } catch {
    return undefined
  }
}

/** CLI entry. */
async function main() {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const ids = argv.filter(arg => arg !== '--check')
  const targets = ids.length === 0 ? Object.keys(PACKS) : ids
  for (const id of targets) {
    if (PACKS[id] === undefined) {
      console.error(`unknown pack "${id}" — available: ${Object.keys(PACKS).join(', ')}`)
      process.exit(2)
    }
  }

  let failed = 0
  for (const id of targets) {
    const { dir, emit } = PACKS[id]
    const outDir = resolve(dir)
    try {
      if (check) {
        // Drift-check re-emits from the pack's own embedded source (when
        // present) so the comparison covers source/ assets, not just entities.
        const srcDir = await embeddedSourceDir(outDir)
        const result = await checkPackEmit(id, outDir, emit, srcDir === undefined ? {} : { srcDir })
        console.log(`[${id}] CHECK CLEAN ✓ ${result.files} files identical, tree sha256 ${result.hash} (${result.expertCount} experts)`)
      } else {
        const result = await emit(outDir, {})
        console.log(`[${id}] emitted → ${outDir} (${result.expertCount} experts, ${result.entityCounts?.scenarios ?? '?'} scenarios; loadPackFromDir ok=${result.ok} errors=${result.errorCount})`)
      }
    } catch (error) {
      failed++
      if (error instanceof PackGenError) {
        console.error(`[${id}] FAILED (${error.errors.length} error(s)):`)
        for (const e of error.errors) console.error(`  [${e.code}] ${e.message}`)
      } else {
        console.error(`[${id}] FAILED: ${error.stack ?? error}`)
      }
    }
  }
  if (failed > 0) process.exit(1)
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) await main()
