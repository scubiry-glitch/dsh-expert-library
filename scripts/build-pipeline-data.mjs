/**
 * Build the native PIPELINE-namespace expert dataset (S 特级 / E<域> 行业 /
 * XHS) for the plugin — the same hardened parser and meta shape as BK/BANK,
 * so every namespace feeds the SAME registry, routing, persona baker and pack
 * projection（整合设计：单一生成数据层 + 单一注册表 + 单一路由表）.
 *
 * Source: scripts/sync-pipeline-experts.mjs 的输出目录
 *   domain-packs/pipeline-domains/source/
 *     docs/专家总表.md + raw-profiles/<姓名>_专家Profile_<ID>.json
 *
 * Output: src/pipeline/data/experts.generated.ts（PIPELINE_EXPERTS）。
 *
 * 命名空间按专家 id 前缀自动推导（namespaceOfExpertId）：S→s、E01→e01、
 * E08→e08、E13→e13、XHS→xhs。
 *
 * Usage: node scripts/build-pipeline-data.mjs [<source-dir>]
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseZhijianSource, stampExperts, namespaceOfExpertId } from './zhijian-source.mjs'

/** 默认源目录（sync 脚本输出）。 */
const DEFAULT_PIPELINE_SOURCE = 'domain-packs/pipeline-domains/source'

/** 数据版本（P1.5 provenance；内容变化 +0.1）。 */
const PIPELINE_DATA_VERSION = '1.0.0'

/** 来源记录（audit）。 */
const PIPELINE_ORIGIN = 'paper.morning.rocks/api/v1/expert-library（scripts/sync-pipeline-experts.mjs 归一化）'

/**
 * Emit the generated TypeScript module for `src/pipeline/data/experts.generated.ts`.
 * Deterministic: same metas ⇒ same bytes.
 */
export function emitPipelineExpertsTs(experts) {
  return `/**
 * GENERATED FILE — do not edit by hand.
 * Built by scripts/build-pipeline-data.mjs from the pipeline-domains source
 * (${experts.length} expert Profile JSONs + 专家总表.md). Regenerate after sync.
 */
import type { ZhijianExpertMeta } from '../../zhijian/types.ts'

export const PIPELINE_EXPERTS: readonly ZhijianExpertMeta[] = ${JSON.stringify(experts, null, 2)}
`
}

/** CLI entry. */
async function main() {
  const srcArg = process.argv[2]
  const src = resolve(srcArg ?? DEFAULT_PIPELINE_SOURCE)
  const parsed = await parseZhijianSource(src)
  if (!parsed.ok) {
    console.error(`pipeline source parse FAILED (${parsed.errors.length} error(s)):`)
    for (const error of parsed.errors) {
      console.error(`  [${error.code}] ${error.message}`)
    }
    console.error('no output written — fix the source (roster/profile mismatch) and retry')
    process.exit(1)
  }
  // 命名空间按 id 前缀逐人推导（E08→e08、S→s…）。
  const experts = stampExperts(parsed.experts, {
    namespace: (id) => namespaceOfExpertId(id),
    version: PIPELINE_DATA_VERSION,
    origin: PIPELINE_ORIGIN,
    material: { md: false, raw: true, knowledge: false },
  })
  const outFile = new URL('../src/pipeline/data/experts.generated.ts', import.meta.url)
  const outPath = outFile.pathname
  await mkdir(join(outPath, '..'), { recursive: true })
  await writeFile(outPath, emitPipelineExpertsTs(experts))
  console.log(`wrote ${outPath} (${experts.length} experts, layout ${parsed.layout})`)
  for (const e of experts) {
    console.log(`  ${e.bk} ${e.name} [${e.namespace}·${e.field}·${e.stance}] 首字母=${e.initials} tags=${e.tags.join('/')}`)
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) await main()
