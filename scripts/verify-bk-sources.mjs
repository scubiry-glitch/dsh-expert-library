/**
 * BK 素材交叉核对（P0.3）——把散落的政研通 zip / feishu Profile 与包内
 * raw-profiles 做 sha-256 + 字段级 diff，产出 `domain-packs/MATERIAL-CROSSCHECK.md`。
 *
 * 规则：
 * - 包内 raw-profiles（M-01）为基线；
 * - 同一 BK id 的外部版本 sha-256 相同 → `identical`；不同 → 字段级 diff，
 *   只报告有差异的顶层字段（expert_id/name/persona/method/emm/…），绝不静默覆盖；
 * - 外部版本独有的 BK id → `external-only`（记录，不并入包）；
 * - 源目录缺失时跳过并注明（脚本仍可运行）。
 *
 * Usage: node scripts/verify-bk-sources.mjs
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)

/** 包内 raw-profiles 目录（基线）。 */
const PACK_RAW = 'domain-packs/zhijian-realestate/source/raw-profiles'
/** 政研通 zip。 */
const ZY_ZIP = '/root/.openclaw/workspace/98wiki/feishu/20260810_政研通专家Profile_BK1-31.zip'
/** feishu 散件目录。 */
const FEISHU_DIR = '/root/.openclaw/workspace/98wiki/feishu'
/** 输出报告。 */
const REPORT = 'domain-packs/MATERIAL-CROSSCHECK.md'

function sha256Of(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 顶层字段级 diff：返回有差异的字段名列表（含 双方缺失/类型不同）。 */
function topLevelDiff(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const diffs = []
  for (const key of [...keys].sort()) {
    const va = a[key]
    const vb = b[key]
    const sa = JSON.stringify(va)
    const sb = JSON.stringify(vb)
    if (sa !== sb) diffs.push(key)
  }
  return diffs
}

async function listZipJsons(zipPath) {
  // unzip -Z1 列出条目；只保留 *_专家Profile_BK-*.json 条目。
  const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath], { maxBuffer: 64 * 1024 * 1024 })
  return stdout.split('\n')
    .map(line => line.trim())
    .filter(line => /_专家Profile_BK-\d+\.json$/.test(line))
}

async function readZipEntry(zipPath, entry) {
  const { stdout } = await execFileAsync('unzip', ['-p', zipPath, entry], { maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

/** 从文件名提取 BK id：`<前缀>_专家Profile_BK-NNN[后缀].json`。 */
function bkOfFileName(name) {
  const m = name.match(/专家Profile_(BK-\d+)/)
  return m === null ? undefined : m[1]
}

async function main() {
  const packFiles = (await readdir(PACK_RAW)).filter(f => f.endsWith('.json')).sort()
  const baseline = new Map()
  for (const file of packFiles) {
    const bk = bkOfFileName(file)
    if (bk === undefined) continue
    const content = await readFile(join(PACK_RAW, file), 'utf8')
    baseline.set(bk, { file, sha256: sha256Of(content), data: JSON.parse(content) })
  }

  const sections = []
  const summary = []

  // ── M-02 政研通 zip ──────────────────────────────────────────────────────
  const zipRows = []
  if (await exists(ZY_ZIP)) {
    let entries
    try {
      entries = await listZipJsons(ZY_ZIP)
    } catch {
      entries = []
    }
    for (const entry of entries) {
      const bk = bkOfFileName(entry.split('/').pop() ?? '')
      if (bk === undefined) continue
      try {
        const text = await readZipEntry(ZY_ZIP, entry)
        const zipData = JSON.parse(text)
        const base = baseline.get(bk)
        if (base === undefined) {
          zipRows.push(`| ${bk} | external-only | — | 包内无此专家（${entry}） |`)
          continue
        }
        const sha = sha256Of(text)
        if (sha === base.sha256) {
          zipRows.push(`| ${bk} | identical | — | 与包内逐字节一致 |`)
        } else {
          const diffs = topLevelDiff(base.data, zipData)
          zipRows.push(`| ${bk} | field-diff | ${diffs.join(', ')} | ${entry} |`)
        }
      } catch {
        zipRows.push(`| ${bk} | unreadable | — | ${entry} 解析失败 |`)
      }
    }
    sections.push(`## M-02 政研通 zip（${ZY_ZIP}）\n\n| BK | 结果 | 差异字段 | 说明 |\n|---|---|---|---|\n${zipRows.join('\n')}\n`)
  } else {
    sections.push(`## M-02 政研通 zip\n\n> 源缺失（${ZY_ZIP}）——跳过。\n`)
  }

  // ── M-03 feishu 散件 ─────────────────────────────────────────────────────
  const feishuRows = []
  if (await exists(FEISHU_DIR)) {
    const files = (await readdir(FEISHU_DIR)).filter(f => /_专家Profile_BK-\d+.*\.json$/.test(f)).sort()
    for (const file of files) {
      const bk = bkOfFileName(file)
      if (bk === undefined) continue
      try {
        const text = await readFile(join(FEISHU_DIR, file), 'utf8')
        const data = JSON.parse(text)
        const base = baseline.get(bk)
        if (base === undefined) {
          feishuRows.push(`| ${bk} | external-only | — | 包内无此专家 |`)
          continue
        }
        const sha = sha256Of(text)
        if (sha === base.sha256) {
          feishuRows.push(`| ${bk} | identical | — | 与包内逐字节一致 |`)
        } else {
          const diffs = topLevelDiff(base.data, data)
          feishuRows.push(`| ${bk} | field-diff | ${diffs.join(', ')} | ${file} |`)
        }
      } catch {
        feishuRows.push(`| ${bk} | unreadable | — | ${file} 解析失败 |`)
      }
    }
    sections.push(`## M-03 feishu 散件（${FEISHU_DIR}）\n\n| BK | 结果 | 差异字段 | 说明 |\n|---|---|---|---|\n${feishuRows.join('\n')}\n`)
  } else {
    sections.push(`## M-03 feishu 散件\n\n> 源缺失（${FEISHU_DIR}）——跳过。\n`)
  }

  // ── 汇总 ─────────────────────────────────────────────────────────────────
  const total = packFiles.length
  summary.push(
    `- 基线：包内 raw-profiles ${total} 份（BK-002~034）`,
    `- 政研通 zip 对比：${zipRows.filter(r => r.includes('identical')).length} identical / ${zipRows.filter(r => r.includes('field-diff')).length} field-diff / ${zipRows.filter(r => r.includes('external-only')).length} external-only`,
    `- feishu 散件对比：${feishuRows.filter(r => r.includes('identical')).length} identical / ${feishuRows.filter(r => r.includes('field-diff')).length} field-diff / ${feishuRows.filter(r => r.includes('external-only')).length} external-only`,
    '',
    '> 结论：identical 无需处理；field-diff 的人工裁决（以包内 raw 为准，差异记录在案）；external-only 记录待 P3 线上同步。',
  )

  const report = [
    `# BK 素材交叉核对报告（P0.3）`,
    '',
    `> 生成：scripts/verify-bk-sources.mjs · ${new Date().toISOString().slice(0, 10)}`,
    '',
    ...summary,
    '',
    ...sections,
  ].join('\n')
  await writeFile(REPORT, report)
  console.log(`wrote ${REPORT}`)
  console.log(summary.filter(line => line.startsWith('-')).join('\n'))
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) await main()
