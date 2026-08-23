/**
 * P3.1 pipeline 剩余专家同步脚本（整合设计：归一化为标准 Profile → 现有
 * parser/发射器/注册表直接消费，不复刻平行管线）。
 *
 * 来源：`http://paper.morning.rocks/api/v1/expert-library`
 *   - `GET /experts`（列表，184 位）
 *   - `GET /experts/{id}`（全量 Profile，schema 与本地 BK Profile 一致，
 *     缺 classification/initials —— 由本脚本确定性推导）
 *
 * 输出：`<out>/raw-profiles/<姓名>_专家Profile_<ID>.json`（标准 schema）
 *      + `<out>/docs/专家总表.md`（roster，parser 兼容）
 *      + `<out>/SYNC-MANIFEST.json`（同步审计：时间/命名空间/每文件 sha256）
 *
 * 确定性：同输入 ⇒ 同输出（专家按 id 排序、roster 按领域分组编号、无随机）；
 * 反捏造：field/stance/tags/summary/initials 全部由 domain/name 确定性推导，
 * persona/method/emm/… 逐字节保留线上内容。
 *
 * Usage:
 *   node scripts/sync-pipeline-experts.mjs                    # 默认 E01,E08,E13
 *   node scripts/sync-pipeline-experts.mjs --namespaces S     # 收 S 特级
 *   node scripts/sync-pipeline-experts.mjs --dry-run          # 只打印将写什么
 *   node scripts/sync-pipeline-experts.mjs --out <dir>        # 自定义输出目录
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

/** 线上专家库 API 基址。 */
export const PIPELINE_API = 'http://paper.morning.rocks/api/v1/expert-library'

/** 默认输出目录（pipeline-domains 包的 source/）。 */
export const DEFAULT_SYNC_OUT = 'domain-packs/pipeline-domains/source'

/** 默认收编命名空间（优先域：E08 房地产 / E01 宏观 / E13 江苏银行）。 */
export const DEFAULT_NAMESPACES = ['E01', 'E08', 'E13']

/** 能力标签关键词映射（确定性推导，顺序固定：数据/研判/解读/理论/实操）。 */
const TAG_RULES = [
  ['数据', ['数据', '指数', '量化', '算法', '监测', '评估模型']],
  ['研判', ['周期', '趋势', '判断', '评估', '战略', '出清', '增长', '预判']],
  ['解读', ['政策', '分析', '研究', '解读', '评审']],
  ['理论', ['模型', '方法论', '理论', '经济']],
  ['实操', ['管理', '执行', '运营', '落地', '实操', '平台', '渠道', '建设']],
] 

/** 由实名+领域确定性推导 roster 元数据（field/stance/辅域/tags/summary/initials）。 */
export function derivePipelineMeta(name, domain) {
  const list = Array.isArray(domain) ? domain : []
  const field = list[0] ?? '通用'
  const stance = list[1] ?? list[0] ?? '通用'
  const secondaryField = list[2]
  const text = list.join('')
  const tags = []
  for (const [tag, keywords] of TAG_RULES) {
    if (keywords.some(keyword => text.includes(keyword))) tags.push(tag)
  }
  if (tags.length === 0) tags.push('研判')
  const initials = [...String(name)][0] ?? 'X'
  return {
    field,
    stance,
    ...(secondaryField === undefined ? {} : { secondaryField }),
    tags,
    summary: `擅长 ${list.slice(0, 3).join('、') || field}`,
    initials,
  }
}

/** 线上详情 → 标准 Profile JSON（与本地 BK Profile schema 对齐；derived 只进 roster）。 */
export function normalizePipelineProfile(detail) {
  const id = String(detail?.expert_id ?? '')
  const name = String(detail?.name ?? '')
  if (id === '' || name === '') throw new Error('线上详情缺少 expert_id/name')
  const domain = Array.isArray(detail.domain) ? detail.domain : []
  const derived = derivePipelineMeta(name, domain)
  return {
    profile: {
      expert_id: id,
      // S/E 专家为公众人物：personaName 与实名一致（无需匿名化别名）。
      name,
      domain,
      ...(detail.persona !== undefined ? { persona: detail.persona } : {}),
      ...(detail.method !== undefined ? { method: detail.method } : {}),
      ...(detail.emm !== undefined ? { emm: detail.emm } : {}),
      ...(detail.constraints !== undefined ? { constraints: detail.constraints } : {}),
      ...(detail.output_schema !== undefined ? { output_schema: detail.output_schema } : {}),
      ...(detail.anti_patterns !== undefined ? { anti_patterns: detail.anti_patterns } : {}),
      ...(detail.signature_phrases !== undefined ? { signature_phrases: detail.signature_phrases } : {}),
      classification: {
        category: derived.field,
        perspective: domain.join('、'),
        initials: derived.initials,
      },
      initials: derived.initials,
    },
    derived,
  }
}

/** 由全部归一化条目确定性生成 专家总表.md（按 field 分组编号，parser 兼容）。 */
export function emitPipelineRoster(entries) {
  const groups = new Map()
  for (const { profile, derived } of entries) {
    const key = derived.field
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ profile, derived })
  }
  const lines = [
    '# 专家总表（pipeline 命名空间）',
    '',
    '> 生成：scripts/sync-pipeline-experts.mjs（线上 expert-library 归一化，公众人物实名）',
    '',
  ]
  let index = 1
  for (const [field, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
    lines.push(`### ${index}. ${field}（${items.length} 位）`, '')
    lines.push('| 编号 | 实名 | 人设名 | 立场 | 辅领域 | 能力标签 | 标签摘要 |')
    lines.push('|---|---|---|---|---|---|---|')
    for (const { profile, derived } of items.sort((a, b) => a.profile.expert_id.localeCompare(b.profile.expert_id))) {
      lines.push(`| ${profile.expert_id} | ${profile.name} | ${profile.name} | ${derived.stance} | ${derived.secondaryField ?? '—'} | ${derived.tags.join('/')} | ${derived.summary} |`)
    }
    lines.push('')
    index += 1
  }
  return lines.join('\n')
}

/** SHA-256 hex of raw bytes. */
function sha256Of(content) {
  return createHash('sha256').update(content).digest('hex')
}

/** 拉取一个 JSON 端点（404 → null；网络错误抛错）。 */
async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`)
  return response.json()
}

/** 按命名空间过滤专家 id（前缀匹配，如 E08、S）。 */
function matchesNamespace(expertId, namespaces) {
  return namespaces.some(ns => expertId.startsWith(`${ns}-`))
}

/**
 * 扫描输出目录中已有的标准 Profile（先前批次同步落盘），返回
 * `{ id, profile, derived }` 条目——供多批次追加时合并 roster，
 * 已有专家不丢、不重复（新批次拉取的同 id 条目优先）。
 */
export async function collectExistingProfiles(outDir) {
  const rawRoot = join(resolve(outDir), 'raw-profiles')
  const entries = []
  let files = []
  try {
    files = (await readdir(rawRoot)).filter(f => f.endsWith('.json')).sort()
  } catch {
    return entries
  }
  for (const file of files) {
    try {
      const profile = JSON.parse(await readFile(join(rawRoot, file), 'utf8'))
      if (typeof profile?.expert_id !== 'string' || typeof profile?.name !== 'string') continue
      const derived = derivePipelineMeta(profile.name, profile.domain ?? [])
      entries.push({ id: profile.expert_id, profile, derived })
    } catch {
      // 坏文件跳过（不阻断合并）
    }
  }
  return entries
}

/** 合并既有与新增条目（按 id 去重；新增优先），按 id 排序。 */
export function mergeEntries(existing, fresh) {
  const byId = new Map()
  for (const entry of existing) byId.set(entry.id, entry)
  for (const entry of fresh) byId.set(entry.id, entry)
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 同步入口：拉列表 → 过滤 → 拉详情 → 归一化 → 写 raw-profiles + roster + manifest。
 * 任何拉取失败都会在写盘前中止（原子语义：不产生半成品）。
 * 已存在的同 sha 文件跳过（幂等）；sha 不同则覆盖并计入 changed。
 */
export async function syncPipelineExperts(options = {}) {
  const { namespaces = DEFAULT_NAMESPACES, out = DEFAULT_SYNC_OUT, dryRun = false } = options
  const outDir = resolve(out)

  const list = await fetchJson(`${PIPELINE_API}/experts?limit=300`)
  if (list === null || !Array.isArray(list.experts)) throw new Error('无法读取专家列表')
  const targets = list.experts
    .map(e => String(e.expert_id ?? ''))
    .filter(id => id !== '' && matchesNamespace(id, namespaces))
    .sort()

  // 拉详情（小并发，顺序无关紧要——归一化按 id 排序保证确定性）。
  const fresh = []
  for (const id of targets) {
    const detail = await fetchJson(`${PIPELINE_API}/experts/${encodeURIComponent(id)}`)
    if (detail === null) throw new Error(`详情 404：${id}`)
    const { profile, derived } = normalizePipelineProfile(detail)
    fresh.push({ id, profile, derived })
  }
  fresh.sort((a, b) => a.id.localeCompare(b.id))

  // 多批次追加：合并输出目录中已有专家（roster 不丢历史批次）。
  const existing = await collectExistingProfiles(outDir)
  const entries = mergeEntries(existing, fresh)

  if (dryRun) {
    return { dryRun: true, outDir, namespaces, targets, entries, changed: fresh.map(e => e.id), skipped: [] }
  }

  const manifest = { syncedAt: new Date().toISOString(), namespaces, total: entries.length, files: {}, changed: [], skipped: [] }
  await mkdir(join(outDir, 'raw-profiles'), { recursive: true })
  await mkdir(join(outDir, 'docs'), { recursive: true })
  for (const { id, profile } of fresh) {
    const rel = `raw-profiles/${profile.name}_专家Profile_${id}.json`
    const abs = join(outDir, rel)
    const content = `${JSON.stringify(profile, null, 2)}\n`
    const sha = sha256Of(content)
    let existingSha
    try {
      existingSha = sha256Of(await readFile(abs))
    } catch {
      existingSha = undefined
    }
    manifest.files[rel] = sha
    if (existingSha === sha) {
      manifest.skipped.push(id)
      continue
    }
    await writeFile(abs, content)
    manifest.changed.push(id)
  }
  const rosterText = emitPipelineRoster(entries)
  const rosterPath = join(outDir, 'docs', '专家总表.md')
  const existingRoster = await readFile(rosterPath, 'utf8').catch(() => undefined)
  if (existingRoster !== rosterText) manifest.changed.push('docs/专家总表.md')
  await writeFile(rosterPath, rosterText)
  await writeFile(join(outDir, 'SYNC-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { dryRun: false, outDir, namespaces, targets, entries, changed: manifest.changed, skipped: manifest.skipped }
}

/** CLI entry。 */
async function main() {
  const argv = process.argv.slice(2)
  const namespaces = []
  let out = DEFAULT_SYNC_OUT
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--namespaces') namespaces.push(...String(argv[++i]).split(',').map(s => s.trim()).filter(Boolean))
    else if (arg === '--out') out = argv[++i]
    else if (arg === '--dry-run') dryRun = true
    else {
      console.error('usage: node scripts/sync-pipeline-experts.mjs [--namespaces E01,E08,E13] [--out <dir>] [--dry-run]')
      process.exit(2)
    }
  }
  try {
    const result = await syncPipelineExperts({
      namespaces: namespaces.length > 0 ? namespaces : DEFAULT_NAMESPACES,
      out,
      dryRun,
    })
    console.log(`${dryRun ? '[dry-run] 将同步' : '已同步'} ${result.targets.length} 位专家 → ${result.outDir}`)
    for (const e of result.entries) {
      console.log(`  ${e.id} | ${e.profile.name} | ${e.derived.field}·${e.derived.stance} | tags=${e.derived.tags.join('/')} | 首字母=${e.derived.initials}`)
    }
    if (!dryRun) {
      console.log(`changed: ${result.changed.length}（${result.changed.slice(0, 6).join(', ')}${result.changed.length > 6 ? '…' : ''}）；skipped(同 sha): ${result.skipped.length}`)
    }
  } catch (error) {
    console.error(`sync FAILED: ${error.stack ?? error}`)
    process.exit(1)
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) await main()
