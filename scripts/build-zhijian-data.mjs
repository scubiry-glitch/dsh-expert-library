/**
 * Build the native Zhijian expert dataset for the plugin.
 *
 * Sources (the 智见点评 skill zip, unpacked):
 * - 专家材料/<姓名>/<姓名>_专家Profile_BK-NNN.json — structured expert personas
 * - 专家总表.md — roster table: field / stance / tags / summary per BK id
 *
 * Output: src/zhijian/data/experts.generated.ts (compiled into the plugin),
 * so routing, personas and the expert registry are native plugin data —
 * the model never has to parse the raw JSON itself.
 *
 * Parsing is hardened (scripts/zhijian-source.mjs): any roster/profile
 * inconsistency — a Profile JSON without a roster row, a roster row without
 * a Profile, a material dir without a Profile, an unparseable Profile, a
 * name/persona mismatch, a duplicate BK id — is FATAL and aborts the build
 * with structured errors. Experts are never silently dropped.
 *
 * Usage: node scripts/build-zhijian-data.mjs <skill-dir>
 *   <skill-dir> may be the unpack root (containing 智见点评/), the 智见点评
 *   directory itself, or the domain pack's embedded source/
 *   (domain-packs/zhijian-realestate/source — docs/ + raw-profiles/).
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseZhijianSource, emitExpertsTs } from './zhijian-source.mjs'

const [, , skillDir] = process.argv
if (!skillDir) {
  console.error('usage: node scripts/build-zhijian-data.mjs <unpacked-skill-dir>')
  process.exit(1)
}

const parsed = await parseZhijianSource(skillDir)
if (!parsed.ok) {
  console.error(`source parse FAILED (${parsed.errors.length} error(s)):`)
  for (const error of parsed.errors) {
    console.error(`  [${error.code}] ${error.message}`)
  }
  console.error('no output written — fix the source (roster/profile mismatch) and retry')
  process.exit(1)
}

const outFile = new URL('../src/zhijian/data/experts.generated.ts', import.meta.url)
const outPath = outFile.pathname
await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, emitExpertsTs(parsed.experts))
console.log(`wrote ${outPath} (${parsed.experts.length} experts, layout ${parsed.layout})`)
for (const e of parsed.experts) {
  console.log(`  ${e.bk} ${e.name} [${e.field}·${e.stance}] 首字母=${e.initials} tags=${e.tags.join('/')}${e.deceased ? ' (已故)' : ''}`)
}
