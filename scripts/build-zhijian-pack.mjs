/**
 * Deterministic generator + verifier for the `zhijian-realestate` domain pack
 * (Phase 1 §7.3 of NEXT-GENERATION-ARCHITECTURE.md).
 *
 * Emits the `domain-packs/zhijian-realestate/` layout accepted by
 * `loadPackFromDir`:
 *
 * ```text
 * domain-packs/zhijian-realestate/
 * ├── pack.json                        # metadata-only (id/version/schemaVersion/…)
 * ├── experts/bk-002.json … bk-033.json
 * ├── scenarios/zhijian-{monthly,policy,macro,finance,city,industry,services,institution}.json
 * ├── team-templates/zhijian.team.{A,B,C,D}.json
 * ├── output-templates/zhijian.output.{A,B,C,D,E}.json
 * ├── quality-policies/zhijian.quality.json
 * ├── knowledge-providers/{local-knowledge,zhijian-expert-memory}.json
 * ├── domain-knowledge/zhijian.expert-memory.json
 * ├── method-packs/zhijian.method.{review-protocol,framework-a..e}.json
 * ├── skill-packages/{finesse-ui,gsap-*,video-shotcraft}.json   # bundled local skills inventory
 * ├── routing/routing.json             # pack-adjacent overlay (topics/stance pairs/constraints)
 * ├── source/                          # lossless original source (raw Profile JSONs + docs + library)
 * │   ├── raw-profiles/*.json          #   original 32 Profile JSONs, byte-identical to the zip
 * │   ├── docs/*.md                    #   SKILL.md + 5 framework docs
 * │   ├── library/*.md                 #   专家库 flattened pages
 * │   └── SOURCE-MANIFEST.json         #   baseline facts + per-file sha256 + deferred upgrades
 * ├── generated/                       # derived, always regenerable
 * │   ├── v1/{experts,scenarios}.json  #   frozen V1 registry view (golden fixtures)
 * │   ├── roster.md                    #   roster table regenerated from the metas
 * │   ├── verify.json                  #   loadPackFromDir diagnostics of this emit
 * │   └── pack.sha256                  #   tree digest over the non-generated files
 * └── README.md
 * ```
 *
 * Determinism contract: the same source + same `lib/` build produce a
 * byte-identical tree (canonical key order via `canonicalJson`, sorted
 * entities, no timestamps; `verify.json` carries only path-free diagnostics).
 * `--check` re-emits into a temp dir and compares every file with the
 * committed pack — any drift (source edit, lib rebuild, manual tampering)
 * fails the check.
 *
 * Fidelity / anti-fabrication rules:
 * - the pack entities are the **derived projection** of the runtime metas
 *   (`buildZhijianDomainPack`), never hand-written JSON;
 * - `source/raw-profiles/` holds the original Profile JSON bytes with their
 *   sha-256 recorded in `SOURCE-MANIFEST.json` (lossless by hash);
 * - the embedded source is re-parsed by the hardened parser on every emit, so
 *   roster/profile mismatches are fatal here as well;
 * - BK-034 (added to the workspace copy on 2026-08-20) is NOT merged — it is
 *   recorded as a deferred 1.1.0 upgrade in `SOURCE-MANIFEST.json` and
 *   asserted absent by `test/v2-pack-migration.test.mjs`.
 *
 * Usage:
 *   node scripts/build-zhijian-pack.mjs                # re-emit pack from lib (requires pnpm build)
 *   node scripts/build-zhijian-pack.mjs --src <dir>    # parse source, regenerate experts.generated.ts, emit
 *   node scripts/build-zhijian-pack.mjs --check [--src <dir>] [--out <dir>]
 *
 * @module dsh-expert-library/scripts/build-zhijian-pack
 */

import { readFile, writeFile, mkdir, mkdtemp, readdir, copyFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { parseZhijianSource, emitExpertsTs } from './zhijian-source.mjs'
import {
  buildZhijianDomainPack,
  ZHIJIAN_PACK_ID,
  ZHIJIAN_PACK_VERSION,
  ZHIJIAN_PACK_SNAPSHOT,
  ZHIJIAN_BASELINE_DATE,
  loadPackFromDir,
  canonicalJson,
  hashPackageTree,
} from '../lib/v2/index.js'
import { ZHIJIAN_EXPERTS } from '../lib/zhijian/data/experts.generated.js'
import { ZHIJIAN_EXPERT_BY_ID, ZHIJIAN_ROUTE } from '../lib/zhijian/registry.js'
import { ROUTE_TOPICS, STANCE_TABLE, SPECIAL_ROUTING, ROUTING_CONSTRAINTS } from '../lib/zhijian/routing.js'
import { BUILTIN_SCENARIOS } from '../lib/expert-library/builtin-scenarios.js'

/** Default output pack directory (relative to the repo root). */
export const DEFAULT_PACK_DIR = 'domain-packs/zhijian-realestate'

/** Framework docs copied into `source/docs/` (byte-identical to the source). */
export const SOURCE_DOCS = [
  'SKILL.md',
  '专家分类框架_v1.md',
  '专家总表.md',
  '专家输出框架规范_20260809.md',
  '资料更新规范.md',
  '路由规则.md',
]

/**
 * Both source baselines of the pack, oldest first. 1.0.0 shipped the original
 * 2026-08-19 zip (32 experts); 1.1.0 is regenerated from the newer unpacked
 * workspace copy (2026-08-20/21, adds 陈杰 BK-034). SOURCE-MANIFEST.json
 * records both, so the provenance chain stays complete.
 */
export const PACK_BASELINES = [
  {
    version: '1.0.0',
    source: '智见点评_skill_20260819.zip',
    date: '2026-08-19T00:00:00Z',
    snapshot: 'zhijian-v1-2026-08-19',
    zipTotalFiles: 156,
    expertCount: 32,
    note: 'Original 2026-08-19 zip baseline (BK-002..BK-033). Archive: /root/.openclaw/media/outbound/智见点评_skill_20260819.zip',
  },
  {
    version: '1.1.0',
    source: '/root/.openclaw/workspace/skills/智见点评 (unpacked workspace copy, updated 2026-08-20/21)',
    date: ZHIJIAN_BASELINE_DATE,
    snapshot: ZHIJIAN_PACK_SNAPSHOT,
    zipTotalFiles: 160,
    expertCount: 33,
    note: 'Unpacked revision: adds 陈杰 BK-034 (专家总表.md 33 rows, 路由规则.md candidates updated 2026-08-21). The original 32 Profile JSONs are byte-identical to the 1.0.0 zip.',
  },
]

/**
 * Upgrade history — the 1.0.0 pack explicitly deferred BK-034; 1.1.0 merges
 * it. Recorded in SOURCE-MANIFEST.json so the decision stays auditable.
 */
export const PACK_UPGRADE_HISTORY = [
  {
    from: '1.0.0',
    to: '1.1.0',
    adds: ['bk-034 陈杰'],
    reason: '1.0.0 deliberately kept the 32-expert runtime baseline and recorded BK-034 as a deferred upgrade (2026-08-20 addition to the unpacked source). 1.1.0 regenerates from that newer source: 33 experts, routing candidates updated (政策/制度/金融公积金视角), rich Profile detail projected into ExpertV2.',
  },
]

/** Structured generator error; `errors` are `{ code, message }`. */
export class PackGenError extends Error {
  constructor(errors) {
    super(errors.map(error => `[${error.code}] ${error.message}`).join('\n'))
    this.name = 'PackGenError'
    this.errors = errors
  }
}

/** SHA-256 hex of raw bytes. */
function sha256Of(content) {
  return createHash('sha256').update(content).digest('hex')
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

/** List regular files under a root as sorted, posix-separated relative paths. */
async function listFiles(root, prefix = '') {
  const out = []
  const entries = await readdir(root, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...await listFiles(join(root, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** Copy `source` bytes to `dest`, returning the sha-256 of the bytes. */
async function copyBytes(source, dest) {
  await mkdir(dirname(dest), { recursive: true })
  const content = await readFile(source)
  await writeFile(dest, content)
  return sha256Of(content)
}

/**
 * Copy the original source assets into `<out>/source/`: the 32 Profile JSONs
 * (raw-profiles/, byte-identical), the 6 framework docs (docs/), the 专家库
 * flattened pages (library/), and SOURCE-MANIFEST.json with per-file sha-256.
 * Missing or mismatched assets are fatal — losslessness is a hard contract.
 */
export async function copySourceAssets(parsed, srcDir, outDir) {
  const errors = []
  const sourceRoot = join(outDir, 'source')
  await rm(sourceRoot, { recursive: true, force: true })

  // raw profiles: byte-identical copies of the parsed Profile JSONs
  const rawFiles = {}
  const profileEntries = [...parsed.profiles.values()].sort((a, b) => (a.bk < b.bk ? -1 : a.bk > b.bk ? 1 : 0))
  for (const record of profileEntries) {
    const dest = join(sourceRoot, 'raw-profiles', record.fileName)
    rawFiles[record.fileName] = await copyBytes(record.sourcePath, dest)
  }

  // docs: the six framework documents (zip layout: at the source root;
  // pack layout: under <src>/docs)
  const docsDir = parsed.layout === 'zip' ? parsed.root : join(srcDir, 'docs')
  const docs = {}
  for (const name of SOURCE_DOCS) {
    const source = join(docsDir, name)
    if (!(await fileExists(source))) {
      errors.push({ code: 'doc-missing', message: `${source}: framework doc missing from the source` })
      continue
    }
    docs[name] = await copyBytes(source, join(sourceRoot, 'docs', name))
  }

  // library: flattened 专家库 pages — every page must belong to the roster;
  // a roster BK WITHOUT a page is a documented source gap (1.1.0: 陈杰 BK-034
  // has no 专家库 page), recorded in the manifest, never fatal and never
  // fabricated.
  const libDir = parsed.layout === 'zip' ? join(parsed.root, '专家库') : join(srcDir, 'library')
  const library = {}
  const libraryMissing = []
  let libEntries = []
  try {
    libEntries = await readdir(libDir)
  } catch (error) {
    errors.push({ code: 'library-missing', message: `cannot list 专家库 at ${libDir}: ${String(error)}` })
  }
  const libraryBks = new Set()
  for (const name of libEntries.filter(f => f.endsWith('.md')).sort()) {
    const m = name.match(/^BK-(\d+)_(.+)\.md$/)
    if (m === null) {
      errors.push({ code: 'library-unexpected', message: `${join(libDir, name)}: file name does not match BK-NNN_姓名.md` })
      continue
    }
    const bk = `BK-${m[1]}`
    if (libraryBks.has(bk)) {
      errors.push({ code: 'library-duplicate', message: `${join(libDir, name)}: BK id ${bk} appears more than once` })
      continue
    }
    libraryBks.add(bk)
    library[name] = await copyBytes(join(libDir, name), join(sourceRoot, 'library', name))
  }
  for (const bk of [...parsed.roster.keys()].sort()) {
    if (!libraryBks.has(bk)) {
      libraryMissing.push(`${bk} ${parsed.roster.get(bk)?.name}`)
    }
  }
  for (const bk of [...libraryBks].sort()) {
    if (!parsed.roster.has(bk)) {
      errors.push({ code: 'library-unlisted-bk', message: `专家库 page ${bk} has no roster row` })
    }
  }

  if (errors.length > 0) throw new PackGenError(errors)

  const manifest = {
    packId: ZHIJIAN_PACK_ID,
    packVersion: ZHIJIAN_PACK_VERSION,
    schemaVersion: 2,
    baselines: PACK_BASELINES,
    upgradeHistory: PACK_UPGRADE_HISTORY,
    rawProfiles: { count: profileEntries.length, files: rawFiles },
    docs: { count: Object.keys(docs).length, files: docs },
    library: {
      count: Object.keys(library).length,
      files: library,
      ...(libraryMissing.length > 0 ? { missing: libraryMissing } : {}),
    },
  }
  await writeFile(join(sourceRoot, 'SOURCE-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/**
 * Verify an existing `<out>/source/` (re-emit without --src): every recorded
 * file must match its sha-256 (lossless against the manifest) and the source
 * must still parse cleanly through the hardened parser. Fatal on drift.
 */
export async function verifySourceAssets(outDir) {
  const sourceRoot = join(outDir, 'source')
  const manifestPath = join(sourceRoot, 'SOURCE-MANIFEST.json')
  if (!(await fileExists(manifestPath))) {
    throw new PackGenError([{ code: 'source-manifest-missing', message: `${sourceRoot}/SOURCE-MANIFEST.json missing — emit once with --src first` }])
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const groups = [
    ['rawProfiles', 'raw-profiles'],
    ['docs', 'docs'],
    ['library', 'library'],
  ]
  for (const [groupKey, dirName] of groups) {
    for (const [name, expected] of Object.entries(manifest[groupKey]?.files ?? {}).sort()) {
      const file = join(sourceRoot, dirName, name)
      const actual = sha256Of(await readFile(file))
      if (actual !== expected) {
        throw new PackGenError([{ code: 'source-tampered', message: `${file}: sha256 ${actual} does not match manifest ${expected}` }])
      }
    }
  }
  const parsed = await parseZhijianSource(sourceRoot)
  if (!parsed.ok) throw new PackGenError(parsed.errors)
  return { manifest, parsed }
}

/** Regenerate the roster markdown table from the expert metas (derived view). */
export function emitRosterMd(experts) {
  const current = PACK_BASELINES[PACK_BASELINES.length - 1]
  const rows = experts.map(e => `| ${e.bk} | ${e.name} | ${e.personaName} | ${e.field}${e.secondaryField ? ` / ${e.secondaryField}` : ''} | ${e.stance} | ${e.tags.join('/')} | ${e.summary} |`)
  return `# 专家总表（生成视图 · ${experts.length} 位）

> 由 scripts/build-zhijian-pack.mjs 从专家 Meta 确定性生成，非手工维护；源：${current.source}（v${current.version}）。

| BK | 姓名 | 人设名 | 领域 | 立场 | 标签 | 摘要 |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`
}

/** README constant written into the pack root. */
function packReadme(experts) {
  const current = PACK_BASELINES[PACK_BASELINES.length - 1]
  const first = experts[0]?.bk ?? 'BK-002'
  const last = experts[experts.length - 1]?.bk ?? 'BK-033'
  return `# zhijian-realestate（智见点评·房地产领域包）v${ZHIJIAN_PACK_VERSION}

${experts.length} 位房地产领域专家基线（${first} ~ ${last}，五大领域），由
\`scripts/build-zhijian-pack.mjs\` 确定性生成。

- \`pack.json\` + 各实体目录：\`loadPackFromDir\` 可装载的 DomainPackV2 布局
  （metadata-only pack.json + 每实体一个 JSON，文件名 == 实体 id）。
- \`source/raw-profiles/\`：原始 Profile JSON，逐字节保留（sha-256 见
  \`source/SOURCE-MANIFEST.json\`）。
- \`source/SOURCE-MANIFEST.json\`：记录两个基线（1.0.0 原始 2026-08-19 zip
  32 位；1.1.0 工作区副本 2026-08-20/21，新增陈杰 BK-034）与升级历史。
- \`generated/\`：派生视图（V1 金样、总表、校验报告、树摘要），可随时重建。
- 重建：\`pnpm build && node scripts/build-zhijian-pack.mjs --src <源目录>\`；
  漂移检查：\`node scripts/build-zhijian-pack.mjs --check\`。
`
}

/**
 * Emit the complete domain pack into `outDir`.
 *
 * Options:
 * - `srcDir`: source to parse (zip layout or pack layout). When given, the
 *   hardened parser runs (fatal on roster/profile mismatch) and — unless
 *   `writeSrc` is false — `src/zhijian/data/experts.generated.ts` is
 *   regenerated; `lib/` metas must then match the parsed source (else the
 *   emit fails with `lib-stale`).
 * - `writeSrc`: whether --src mode may rewrite the generated TS (default
 *   true; tests and --check pass false).
 *
 * Deterministic: the output tree is byte-identical for the same source + lib.
 */
export async function emitPack(outDir, options = {}) {
  const { srcDir, writeSrc = true } = options
  let parsed = null

  if (srcDir !== undefined) {
    parsed = await parseZhijianSource(srcDir)
    if (!parsed.ok) throw new PackGenError(parsed.errors)
    const tsPath = new URL('../src/zhijian/data/experts.generated.ts', import.meta.url).pathname
    if (writeSrc) await writeFile(tsPath, emitExpertsTs(parsed.experts))
    if (canonicalJson(ZHIJIAN_EXPERTS) !== canonicalJson(parsed.experts)) {
      throw new PackGenError([{
        code: 'lib-stale',
        message: 'lib metas differ from the parsed source — run `pnpm build` and retry',
      }])
    }
  }

  // Clean emit: with --src the whole tree is rebuilt; without --src the
  // entity/generated parts are rebuilt while an existing source/ is kept and
  // verified (fresh dirs simply have no source/).
  if (srcDir !== undefined) {
    await rm(outDir, { recursive: true, force: true })
  } else {
    for (const part of ['pack.json', 'README.md', 'experts', 'scenarios', 'team-templates', 'output-templates', 'quality-policies', 'knowledge-providers', 'domain-knowledge', 'method-packs', 'skill-packages', 'routing', 'generated']) {
      await rm(join(outDir, part), { recursive: true, force: true })
    }
  }
  await mkdir(outDir, { recursive: true })

  const written = []
  const generatedFiles = []
  const writeJson = async (rel, value) => {
    const abs = join(outDir, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, `${JSON.stringify(value, null, 2)}\n`)
    written.push(rel)
  }

  // ── entities: derived projection of the runtime metas ─────────────────────
  const pack = buildZhijianDomainPack({ modelPolicy: ZHIJIAN_ROUTE })
  await writeJson('pack.json', pack.pack)
  for (const entity of pack.experts) await writeJson(`experts/${entity.id}.json`, entity)
  for (const entity of pack.teamTemplates) await writeJson(`team-templates/${entity.id}.json`, entity)
  for (const entity of pack.outputTemplates) await writeJson(`output-templates/${entity.id}.json`, entity)
  for (const entity of pack.qualityPolicies) await writeJson(`quality-policies/${entity.id}.json`, entity)
  for (const entity of pack.scenarios) await writeJson(`scenarios/${entity.id}.json`, entity)
  for (const entity of pack.knowledgeProviders) await writeJson(`knowledge-providers/${entity.id}.json`, entity)
  for (const entity of pack.domainKnowledge) await writeJson(`domain-knowledge/${entity.id}.json`, entity)
  for (const entity of pack.methodPacks) await writeJson(`method-packs/${entity.id}.json`, entity)
  for (const entity of pack.skillPackages) await writeJson(`skill-packages/${entity.id}.json`, entity)

  // ── routing overlay (pack-adjacent; not a DomainPackV2 section) ────────────
  // 包切片：运行时共享路由表含 bank 话题，但 zhijian 包只投影房地产切片。
  await writeJson('routing/routing.json', {
    topics: ROUTE_TOPICS.filter(topic => topic.primaryField !== '零售金融' && topic.primaryField !== '银行经营'),
    stancePairs: STANCE_TABLE,
    specialRouting: SPECIAL_ROUTING,
    constraints: ROUTING_CONSTRAINTS,
  })

  // ── source assets: lossless raw profiles + docs + library ─────────────────
  let manifest = null
  if (parsed !== null) {
    manifest = await copySourceAssets(parsed, srcDir, outDir)
  } else {
    const verified = await verifySourceAssets(outDir).catch(error => {
      if (error instanceof PackGenError && error.errors.some(e => e.code === 'source-manifest-missing')) return null
      throw error
    })
    if (verified !== null) manifest = verified.manifest
  }

  // ── generated views (derived, always regenerable) ─────────────────────────
  const metas = parsed !== null ? parsed.experts : ZHIJIAN_EXPERTS
  // 包切片：V1 注册表视图只含 bk-* 专家（BANK 专家归 bank-finance 包）。
  const v1Experts = [...ZHIJIAN_EXPERT_BY_ID.values()].filter(expert => expert.id.startsWith('bk-'))
  const v1Scenarios = BUILTIN_SCENARIOS.filter(scenario => scenario.experts.some(id => id.startsWith('bk-')))
  await writeJson('generated/v1/experts.json', v1Experts)
  generatedFiles.push('generated/v1/experts.json')
  await writeJson('generated/v1/scenarios.json', v1Scenarios)
  generatedFiles.push('generated/v1/scenarios.json')
  await writeFile(join(outDir, 'generated/roster.md'), emitRosterMd(metas))
  generatedFiles.push('generated/roster.md')
  await writeFile(join(outDir, 'README.md'), packReadme(metas))
  written.push('README.md')

  // ── self-verification through the real loader ──────────────────────────────
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
    domainKnowledge: pack.domainKnowledge.length,
    methodPacks: pack.methodPacks.length,
    skillPackages: pack.skillPackages.length,
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
    hasSource: manifest !== null,
  }
}

/** Compare two directory trees byte-for-byte; returns a list of differences. */
export async function compareTrees(a, b) {
  const [fa, fb] = await Promise.all([listFiles(a), listFiles(b)])
  const diffs = []
  const onlyA = fa.filter(rel => !fb.includes(rel))
  const onlyB = fb.filter(rel => !fa.includes(rel))
  for (const rel of onlyA) diffs.push(`only in ${a}: ${rel}`)
  for (const rel of onlyB) diffs.push(`only in ${b}: ${rel}`)
  for (const rel of fa.filter(rel => fb.includes(rel))) {
    const [ca, cb] = await Promise.all([readFile(join(a, rel)), readFile(join(b, rel))])
    if (!ca.equals(cb)) diffs.push(`content differs: ${rel}`)
  }
  return diffs
}

/** CLI entry. */
async function main() {
  const args = { srcDir: undefined, out: resolve(DEFAULT_PACK_DIR), check: false }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--src') args.srcDir = resolve(argv[++i])
    else if (arg === '--out') args.out = resolve(argv[++i])
    else if (arg === '--check') args.check = true
    else {
      console.error('usage: node scripts/build-zhijian-pack.mjs [--src <dir>] [--out <dir>] [--check]')
      process.exit(2)
    }
  }

  try {
    if (args.check) {
      // A complete check re-emits from the pack's own embedded source (when
      // present) so the comparison covers source/ assets, not just entities.
      const checkSrc = args.srcDir ?? (await fileExists(join(args.out, 'source', 'SOURCE-MANIFEST.json'))
        ? join(args.out, 'source')
        : undefined)
      const tmp = await mkdtemp(join(tmpdir(), 'zhijian-pack-check-'))
      const result = await emitPack(tmp, { srcDir: checkSrc, writeSrc: false })
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
    const result = await emitPack(args.out, { srcDir: args.srcDir })
    console.log(`pack emitted → ${args.out}`)
    console.log(`  ${result.expertCount} experts, ${result.entityCounts.scenarios} scenarios, ${result.entityCounts.teamTemplates} team templates, ${result.entityCounts.outputTemplates} output templates`)
    console.log(`  ${result.entityCounts.qualityPolicies} quality policy, ${result.entityCounts.knowledgeProviders} knowledge providers, ${result.entityCounts.domainKnowledge} domain knowledge, ${result.entityCounts.methodPacks} method packs, ${result.entityCounts.skillPackages} skill packages`)
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
