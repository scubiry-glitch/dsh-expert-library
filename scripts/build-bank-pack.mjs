/**
 * Deterministic generator + verifier for the `bank-finance` domain pack —
 * built on the SAME shared machinery as the zhijian pack (pack-common:
 * emitPackEntities / finalizePack / compareTrees) and the SAME V2 builders
 * (buildBankDomainPack reuses zhijian-pack's template/output/method/quality
 * constructors with a bank prefix). No parallel pack machinery.
 *
 * Layout (loadPackFromDir-compatible, same conventions as zhijian-realestate):
 *   pack.json + experts/ + scenarios/ + team-templates/ + output-templates/ +
 *   quality-policies/ + knowledge-providers/ + domain-knowledge/ + method-packs/
 *   + generated/verify.json + generated/pack.sha256
 *   + source/ (raw profiles byte-identical + docs + SOURCE-MANIFEST.json)
 *
 * Usage:
 *   node scripts/build-bank-pack.mjs                # re-emit pack from lib
 *   node scripts/build-bank-pack.mjs --check [--out <dir>]
 *
 * @module dsh-expert-library/scripts/build-bank-pack
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildBankDomainPack, BANK_PACK_ID, BANK_PACK_VERSION } from '../lib/v2/bank-pack.js'
import { BANK_EXPERTS } from '../lib/bank/data/experts.generated.js'
import { BANK_QUALITY_POLICY_ID } from '../lib/v2/bank-pack.js'
import {
  PackGenError,
  checkPackEmit,
  compareTrees,
  copyBytes,
  copyTree,
  emitPackEntities,
  fileExists,
  finalizePack,
  listFiles,
  sha256Of,
} from './pack-common.mjs'

/** Default output pack directory (relative to the repo root). */
export const DEFAULT_BANK_PACK_DIR = 'domain-packs/bank-finance'

/** Source docs copied into `source/docs/` (authored, see MATERIAL-INVENTORY M-05). */
export const BANK_SOURCE_DOCS = [
  '专家总表.md',
]

/** Pack baseline facts recorded in SOURCE-MANIFEST.json. */
export const BANK_BASELINES = [
  {
    version: '1.0.0',
    source: 'BANK-09_调用说明.md（paper.morning.rocks 专家库）+ bank-99 skill profile（作者整理，2026-08-23）',
    date: '2026-08-23T00:00:00Z',
    snapshot: 'bank-v1-2026-08-23',
    expertCount: 1,
    note: '首发：王一帆 BANK-09（江苏银行零售信贷负责人·操盘手视角）。原始材料：99wiki/projects/专家体系/BANK-99_调用说明.md、王一帆_专家画像_BANK-09.pdf/html、skills/bank-99/references/profile.md。',
  },
]

/**
 * Copy the source assets into `<out>/source/`: raw Profile JSONs
 * (byte-identical), authored docs, and SOURCE-MANIFEST.json with per-file
 * sha-256. Missing assets are fatal (losslessness is a hard contract).
 */
export async function copyBankSourceAssets(srcDir, outDir) {
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
  for (const name of BANK_SOURCE_DOCS) {
    const source = join(srcDir, 'docs', name)
    if (!(await fileExists(source))) {
      errors.push({ code: 'doc-missing', message: `${source}: source doc missing` })
      continue
    }
    docs[name] = await copyBytes(source, join(sourceRoot, 'docs', name))
  }

  // 捆绑技能：`<srcDir>/skills/<id>/…`（SKILL.md 树）→ `<out>/source/skills/`
  // 逐字节保留（发射阶段再分发为包内 `skills/`，见 emitBankPack）。
  const skills = {}
  const skillsRoot = join(srcDir, 'skills')
  if (await fileExists(join(skillsRoot, 'SKILL.md')).catch(() => false) || (await stat(skillsRoot).catch(() => undefined))?.isDirectory()) {
    for (const rel of await listFiles(skillsRoot)) {
      skills[rel] = await copyBytes(join(skillsRoot, rel), join(sourceRoot, 'skills', rel))
    }
  }
  if (errors.length > 0) throw new PackGenError(errors)

  const manifest = {
    packId: BANK_PACK_ID,
    packVersion: BANK_PACK_VERSION,
    schemaVersion: 2,
    baselines: BANK_BASELINES,
    rawProfiles: { count: Object.keys(rawFiles).length, files: rawFiles },
    docs: { count: Object.keys(docs).length, files: docs },
    ...(Object.keys(skills).length > 0 ? { skills: { count: Object.keys(skills).length, files: skills } } : {}),
  }
  await writeFile(join(sourceRoot, 'SOURCE-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/** Verify an existing `<out>/source/`: every recorded file must match its sha-256. */
export async function verifyBankSourceAssets(outDir) {
  const sourceRoot = join(outDir, 'source')
  const manifestPath = join(sourceRoot, 'SOURCE-MANIFEST.json')
  if (!(await fileExists(manifestPath))) {
    throw new PackGenError([{ code: 'source-manifest-missing', message: `${sourceRoot}/SOURCE-MANIFEST.json missing — emit once with --src first` }])
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const groups = [
    ['rawProfiles', 'raw-profiles'],
    ['docs', 'docs'],
    ['skills', 'skills'],
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
function bankPackReadme(experts) {
  const first = experts[0]?.bk ?? 'BANK-09'
  return `# bank-finance（银行金融领域包）v${BANK_PACK_VERSION}

${experts.length} 位银行金融领域专家基线（${first}，零售金融/银行经营），由
\`scripts/build-bank-pack.mjs\` 确定性生成（复用 zhijian-realestate 的发射器与
模板/质量/方法构建器，仅数据不同）。

- \`pack.json\` + 各实体目录：\`loadPackFromDir\` 可装载的 DomainPackV2 布局。
- \`source/raw-profiles/\`：原始 Profile JSON，逐字节保留（sha-256 见
  \`source/SOURCE-MANIFEST.json\`）。
- \`quality-policies/bank.quality.json\`：含 \`pii-redaction\` 硬门（手机号/
  身份证/银行卡号/账号 脱敏），银行数据不得带真实值外发。
- 重建：\`pnpm build && node scripts/build-bank-pack.mjs\`；
  漂移检查：\`node scripts/build-bank-pack.mjs --check\`。
`
}

/**
 * Emit the complete bank domain pack into `outDir`.
 * Deterministic: the output tree is byte-identical for the same lib build.
 * With `--src` the whole tree is rebuilt (source assets copied); without it
 * the entity/generated parts are rebuilt while an existing `source/` is kept
 * and verified (mirrors build-zhijian-pack.mjs). The `srcDir` may point at
 * the pack's own embedded source — the assets are staged before the outDir
 * reset so a self-referential rebuild never deletes its own source.
 */
export async function emitBankPack(outDir, options = {}) {
  const { srcDir } = options
  let manifest = null
  let staging = null
  if (srcDir !== undefined) {
    staging = await mkdtemp(join(tmpdir(), 'bank-pack-src-'))
    manifest = await copyBankSourceAssets(srcDir, staging)
    // staged tree: <staging>/source/… — used after the outDir reset below
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

  const pack = buildBankDomainPack()
  const { written, entityCounts } = await emitPackEntities(pack, outDir)
  written.push('README.md')
  await writeFile(join(outDir, 'README.md'), bankPackReadme(BANK_EXPERTS))

  // routing overlay (pack-adjacent; not a DomainPackV2 section)
  const routing = {
    topics: [
      { topic: '零售金融（零售信贷、分行经营、考核推动、外部平台合作、样板复制）', framework: 'B', primaryField: '零售金融', preferredTags: ['实操', '解读'] },
      { topic: '银行经营（信用卡、息差、客群、负债、零售转型）', framework: 'B', primaryField: '银行经营', preferredTags: ['实操', '数据'] },
    ],
    stancePairs: [
      { topic: '零售项目全省推广', optimistic: ['bank-09'], risk: [], unique: ['bank-09'] },
    ],
    qualityPolicyId: BANK_QUALITY_POLICY_ID,
  }
  await mkdir(join(outDir, 'routing'), { recursive: true })
  await writeFile(join(outDir, 'routing', 'routing.json'), `${JSON.stringify(routing, null, 2)}\n`)
  written.push('routing/routing.json')

  // source assets: lossless raw profiles + docs (staged before the reset)
  if (staging !== null) {
    await copyTree(join(staging, 'source'), join(outDir, 'source'))
    // 捆绑技能分发：`source/skills/<id>/…` → 包内 `skills/<id>/…`（技能内容
    // 随包分发；声明在 skill-packages/ 实体，运行时亦可放入 knowledge/skills/ 使用）。
    const stagedSkills = join(staging, 'source', 'skills')
    const stagedSkillsInfo = await stat(stagedSkills).catch(() => undefined)
    if (stagedSkillsInfo?.isDirectory() === true) {
      const count = await copyTree(stagedSkills, join(outDir, 'skills'))
      if (count > 0) written.push(`skills/ (${count} files)`)
    }
  } else {
    try {
      manifest = await verifyBankSourceAssets(outDir)
    } catch (error) {
      if (!(error instanceof PackGenError && error.errors.some(e => e.code === 'source-manifest-missing'))) throw error
    }
  }

  // self-verification through the real loader + tree digest
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

/** CLI entry. */
async function main() {
  const args = { srcDir: undefined, out: resolve(DEFAULT_BANK_PACK_DIR), check: false }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--src') args.srcDir = resolve(argv[++i])
    else if (arg === '--out') args.out = resolve(argv[++i])
    else if (arg === '--check') args.check = true
    else {
      console.error('usage: node scripts/build-bank-pack.mjs [--src <dir>] [--out <dir>] [--check]')
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
      const result = await checkPackEmit('bank', args.out, emitBankPack, checkSrc === undefined ? {} : { srcDir: checkSrc })
      console.log(`CHECK CLEAN ✓ ${result.files} files identical, tree sha256 ${result.hash} (${result.expertCount} experts)`)
      return
    }
    const result = await emitBankPack(args.out, { srcDir: args.srcDir })
    console.log(`pack emitted → ${args.out}`)
    console.log(`  ${result.expertCount} experts, ${result.entityCounts.scenarios} scenarios, ${result.entityCounts.teamTemplates} team template, ${result.entityCounts.outputTemplates} output template`)
    console.log(`  ${result.entityCounts.qualityPolicies} quality policy (含 pii-redaction 硬门), ${result.entityCounts.knowledgeProviders} knowledge providers, ${result.entityCounts.domainKnowledge} domain knowledge, ${result.entityCounts.methodPacks} method packs`)
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
