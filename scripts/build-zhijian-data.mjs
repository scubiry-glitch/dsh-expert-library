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
 * Usage: node scripts/build-zhijian-data.mjs <unpacked-skill-dir>
 */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const [, , skillDir] = process.argv
if (!skillDir) {
  console.error('usage: node scripts/build-zhijian-data.mjs <unpacked-skill-dir>')
  process.exit(1)
}

const root = join(skillDir, '智见点评')

// ── 1. Parse the roster table (专家总表.md) ────────────────────────────────
const rosterRaw = await readFile(join(root, '专家总表.md'), 'utf8')
const roster = new Map() // bk -> { name, personaName, field, stance, secondaryField, tags, summary }
let currentField = ''
for (const line of rosterRaw.split('\n')) {
  const header = line.match(/^### \d+\. (.+?)（\d+ 位）$/) ?? line.match(/^### \d+\. (.+?)$/)
  if (header) {
    currentField = header[1].trim()
    continue
  }
  const m = line.match(/^\| (BK-\d+) \| ([^|]+) \| ([^|]+) \| ([^|]*) \| ([^|]*) \| ([^|]*) \| ([^|]*) \|$/)
  if (!m) continue
  const [, bk, name, personaName, stance, secondaryField, tags, summary] = m.map(s => s.trim())
  roster.set(bk, { name, personaName, field: currentField, stance, secondaryField, tags, summary })
}

// Deceased experts (固化规则: 只可引用历史观点)
const DECEASED = new Set(['BK-022'])

// ── 2. Parse every Profile JSON ─────────────────────────────────────────────
const materialDir = join(root, '专家材料')
const experts = []
for (const dir of await readdir(materialDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  const name = dir.name
  const files = await readdir(join(materialDir, name))
  const profileFile = files.find(f => f.endsWith('_专家Profile_BK-.json'.slice(0, -1)) || /_专家Profile_BK-\d+\.json$/.test(f))
  if (!profileFile) {
    console.warn(`skip ${name}: no Profile JSON`)
    continue
  }
  let p
  try {
    p = JSON.parse(await readFile(join(materialDir, name, profileFile), 'utf8'))
  } catch (e) {
    console.warn(`skip ${name}: ${e.message}`)
    continue
  }
  const bk = p.expert_id ?? profileFile.match(/BK-(\d+)/)?.[0]
  const row = roster.get(bk)
  if (!row) {
    console.warn(`skip ${name}: ${bk} not in roster`)
    continue
  }
  const style = Array.isArray(p.persona?.style)
    ? p.persona.style
    : typeof p.persona?.style === 'string' ? [p.persona.style] : []
  const mentalModels = Array.isArray(p.method?.frameworks)
    ? p.method.frameworks.map(f => String(f))
    : []
  const analysisSteps = Array.isArray(p.method?.analysis_steps)
    ? p.method.analysis_steps.map(s => String(s))
    : []
  experts.push({
    id: bk.toLowerCase(),
    bk,
    name: row.name,
    personaName: row.personaName,
    field: row.field,
    ...(row.secondaryField && row.secondaryField !== '—' ? { secondaryField: row.secondaryField } : {}),
    stance: row.stance || '',
    tags: row.tags ? row.tags.split('/').map(t => t.trim()).filter(Boolean) : [],
    summary: row.summary || '',
    initials: String(p.initials ?? p.classification?.initials ?? ''),
    style,
    mentalModels,
    signaturePhrases: Array.isArray(p.signature_phrases) ? p.signature_phrases.map(s => String(s)) : [],
    antiPatterns: Array.isArray(p.anti_patterns) ? p.anti_patterns.map(s => String(s)) : [],
    analysisSteps,
    ...(DECEASED.has(bk) ? { deceased: true } : {}),
  })
}

experts.sort((a, b) => a.bk.localeCompare(b.bk))

// ── 3. Emit the generated TS module ────────────────────────────────────────
const out = `/**
 * GENERATED FILE — do not edit by hand.
 * Built by scripts/build-zhijian-data.mjs from the 智见点评 skill package
 * (32 expert Profile JSONs + 专家总表.md). Regenerate after skill updates.
 */
import type { ZhijianExpertMeta } from '../types.ts'

export const ZHIJIAN_EXPERTS: readonly ZhijianExpertMeta[] = ${JSON.stringify(experts, null, 2)}
`

const outFile = new URL('../src/zhijian/data/experts.generated.ts', import.meta.url)
await mkdir(join(outFile.pathname.replace(/^\/+/, '') ? new URL('.', outFile).pathname : '.'), { recursive: true })
await writeFile(outFile, out)
console.log(`wrote ${outFile.pathname} (${experts.length} experts)`)
for (const e of experts) {
  console.log(`  ${e.bk} ${e.name} [${e.field}·${e.stance}] 首字母=${e.initials} tags=${e.tags.join('/')}${e.deceased ? ' (已故)' : ''}`)
}
