/**
 * Build the native BANK-namespace expert dataset (banking/finance) for the
 * plugin — the same hardened parser and meta shape as the BK (智见点评)
 * dataset, so both namespaces feed the SAME registry, routing tables, persona
 * baker and pack projection (整合设计：单一生成数据层 + 单一注册表 + 单一路由表，
 * 见 PIPELINE-100PLUS-EXPANSION-PLAN.md P0.2/P0.4).
 *
 * Source: the bank-finance domain pack's embedded source
 *   domain-packs/bank-finance/source/
 *     docs/专家总表.md            — roster table (BANK ids)
 *     raw-profiles/<姓名>_专家Profile_BANK-NNN.json
 *
 * Output: src/bank/data/experts.generated.ts (compiled into the plugin).
 *
 * The BANK roster is authored (sourced from paper.morning.rocks 专家库
 * BANK-09 调用说明 + bank-99 skill profile, see source/docs/专家总表.md), so
 * every meta field still derives verbatim from the source — nothing is
 * fabricated at build time.
 *
 * Usage: node scripts/build-bank-data.mjs <bank-source-dir>
 *   <bank-source-dir> defaults to domain-packs/bank-finance/source.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

import { parseZhijianSource, stampExperts, namespaceOfExpertId } from './zhijian-source.mjs'

/** Default bank source dir (the bank-finance pack's embedded source). */
const DEFAULT_BANK_SOURCE = 'domain-packs/bank-finance/source'

/** Expert data version of this build (P1.5; 内容变化 +0.1). */
const BANK_DATA_VERSION = '1.0.0'

/** Where the profile came from (audit record, not a runtime fetch). */
const BANK_ORIGIN = 'paper.morning.rocks 专家库 BANK-09 调用说明 + bank-99 skill profile（作者整理，2026-08-23）'

/** SHA-256 hex of raw bytes. */
function sha256Of(content) {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Emit the generated TypeScript module for `src/bank/data/experts.generated.ts`.
 * Deterministic: same metas ⇒ same bytes. Every meta carries namespace/version/
 * source (P1.5 provenance) so routing and pack projection can distinguish and
 * version the two namespaces.
 */
export function emitBankExpertsTs(experts) {
  return `/**
 * GENERATED FILE — do not edit by hand.
 * Built by scripts/build-bank-data.mjs from the bank-finance source
 * (${experts.length} expert Profile JSONs + 专家总表.md). Regenerate after profile updates.
 */
import type { ZhijianExpertMeta } from '../../zhijian/types.ts'

export const BANK_EXPERTS: readonly ZhijianExpertMeta[] = ${JSON.stringify(experts, null, 2)}
`
}

/** CLI entry. */
async function main() {
  const srcArg = process.argv[2]
  const src = resolve(srcArg ?? DEFAULT_BANK_SOURCE)
  const parsed = await parseZhijianSource(src)
  if (!parsed.ok) {
    console.error(`bank source parse FAILED (${parsed.errors.length} error(s)):`)
    for (const error of parsed.errors) {
      console.error(`  [${error.code}] ${error.message}`)
    }
    console.error('no output written — fix the source (roster/profile mismatch) and retry')
    process.exit(1)
  }
  // Namespace/provenance stamps（按 id 前缀推导：BANK→bank、E13→e13——
  // E13 江苏银行高层并入本包但保留 e13 命名空间溯源）。
  const experts = stampExperts(parsed.experts, {
    namespace: (id) => namespaceOfExpertId(id),
    version: BANK_DATA_VERSION,
    origin: BANK_ORIGIN,
    material: { md: false, raw: true, knowledge: false },
  })
  const outFile = new URL('../src/bank/data/experts.generated.ts', import.meta.url)
  const outPath = outFile.pathname
  await mkdir(join(outPath, '..'), { recursive: true })
  await writeFile(outPath, emitBankExpertsTs(experts))
  console.log(`wrote ${outPath} (${experts.length} experts, layout ${parsed.layout})`)
  for (const e of experts) {
    console.log(`  ${e.bk} ${e.name} [${e.field}·${e.stance}] 首字母=${e.initials} tags=${e.tags.join('/')}`)
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href
if (isMain) await main()
