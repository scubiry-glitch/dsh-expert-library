/**
 * Build the native PIPELINE-GENERAL expert dataset (S 特级专家 / XHS 小红书)
 * for the plugin — same hardened parser and meta shape as all other
 * namespaces（整合设计：单一生成数据层 + 单一注册表 + 单一路由表）.
 *
 * Source: scripts/sync-pipeline-experts.mjs 的输出目录
 *   domain-packs/pipeline-general/source/
 *     docs/专家总表.md + raw-profiles/<姓名>_专家Profile_<ID>.json
 *
 * Output: src/pipeline-general/data/experts.generated.ts（GENERAL_EXPERTS）。
 * 命名空间按专家 id 前缀自动推导：S→s、XHS→xhs。
 *
 * Usage: node scripts/build-pipeline-general-data.mjs [<source-dir>]
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseZhijianSource, stampExperts, namespaceOfExpertId } from './zhijian-source.mjs'

/** 默认源目录（sync 脚本输出）。 */
const DEFAULT_PIPELINE_GENERAL_SOURCE = 'domain-packs/pipeline-general/source'

/** 数据版本（P1.5 provenance）。 */
const GENERAL_DATA_VERSION = '1.0.0'

/** 来源记录（audit）。 */
const GENERAL_ORIGIN = 'paper.morning.rocks/api/v1/expert-library（scripts/sync-pipeline-experts.mjs 归一化，S 特级/XHS）'

/**
 * Emit the generated TypeScript module for
 * `src/pipeline-general/data/experts.generated.ts`. Deterministic.
 */
export function emitGeneralExpertsTs(experts) {
  return `/**
 * GENERATED FILE — do not edit by hand.
 * Built by scripts/build-pipeline-general-data.mjs from the pipeline-general source
 * (${experts.length} expert Profile JSONs + 专家总表.md). Regenerate after sync.
 */
import type { ZhijianExpertMeta } from '../../zhijian/types.ts'

export const GENERAL_EXPERTS: readonly ZhijianExpertMeta[] = ${JSON.stringify(experts, null, 2)}
`
}

/** CLI entry. */
async function main() {
  const srcArg = process.argv[2]
  const src = resolve(srcArg ?? DEFAULT_PIPELINE_GENERAL_SOURCE)
  const parsed = await parseZhijianSource(src)
  if (!parsed.ok) {
    console.error(`pipeline-general source parse FAILED (${parsed.errors.length} error(s)):`)
    for (const error of parsed.errors) {
      console.error(`  [${error.code}] ${error.message}`)
    }
    console.error('no output written — fix the source (roster/profile mismatch) and retry')
    process.exit(1)
  }
  const experts = stampExperts(parsed.experts, {
    namespace: (id) => namespaceOfExpertId(id),
    version: GENERAL_DATA_VERSION,
    origin: GENERAL_ORIGIN,
    material: { md: false, raw: true, knowledge: false },
  })
  const outFile = new URL('../src/pipeline-general/data/experts.generated.ts', import.meta.url)
  const outPath = outFile.pathname
  await mkdir(join(outPath, '..'), { recursive: true })
  await writeFile(outPath, emitGeneralExpertsTs(experts))
  console.log(`wrote ${outPath} (${experts.length} experts, layout ${parsed.layout})`)
  for (const e of experts) {
    console.log(`  ${e.bk} ${e.name} [${e.namespace}·${e.field}] 首字母=${e.initials} tags=${e.tags.join('/')}`)
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) await main()
