/**
 * P2.3 人物转专家半自动管线（对齐 pipeline 会议纪要「人物转专家」）。
 *
 * 输入：一份逐字稿/会议纪要（markdown/纯文本），按「说话人 + 发言」启发式
 * 识别人物 → 聚合其发言要点 → 生成一张「专家画像草稿」JSON（字段按
 * ExpertRecord 形状预留，人工/Agent 确认补全后进库）。
 *
 * 确定性：同输入 ⇒ 同输出（说话人按名排序、发言按序保留、无随机）。
 * 反捏造：草稿只含从文本中提取的事实（发言计数/代表句/议题关键词）；
 * 立场/风格等推断字段一律以 `_needs_review` 标记，不编造。
 *
 * Usage:
 *   node scripts/import-persons.mjs <逐字稿或目录> [--out <输出目录>]
 *
 * 输出：<out>/persons-<slug>/<姓名>.json（草稿）+ summary.md（汇总）。
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 元信息行标签（飞书纪要头部，非说话人）。 */
const METADATA_LABELS = new Set(['录音主题', '录音时间', '智能纪要', '来源', '文档链接', '摘要', '参会人'])

/** 独立说话人行（飞书逐字稿格式）：`**说话人 1 00:00:01**`（无冒号，发言在下一行）。 */
const SPEAKER_HEADER = /^\*\*([^*]+?)\*\*\s*$/

/** 行内说话人行：`**名字**：发言` / `名字：发言`。 */
const SPEAKER_INLINE = /^(?:\*\*)?([^\s:：*\]【】]{1,20}?)(?:\*\*)?\s*[：:]\s*(.+)$/

/** 议题关键词（启发式，用于草稿 suitedFor 提示，不做语义判断）。 */
const TOPIC_KEYWORDS = ['信贷', '信用卡', '分行', '考核', '租赁', '租房', '家装', '物业', '经纪', '收储', '城市更新', '利率', '楼市', '房价', '政策', '平台', '获客', '零售']

/** 人名安全化（用于文件名）。 */
function slug(name) {
  return name.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'person'
}

/** 统计文本中的议题关键词出现次数。 */
function topicHits(text) {
  const hits = {}
  for (const keyword of TOPIC_KEYWORDS) {
    const count = text.split(keyword).length - 1
    if (count > 0) hits[keyword] = count
  }
  return hits
}

/** 提取一句代表句（首个非空、≤80 字）。 */
function representativeLine(line) {
  const trimmed = line.trim()
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed
}

/**
 * 解析一份文本为「说话人 → 发言行[]」（按出现顺序；说话人按首现序）。
 * 支持两种格式：
 * - 飞书逐字稿：`**说话人 1 00:00:01**` 为独立行，后续非空行归属该说话人；
 * - 行内：`**名字**：发言` 或 `名字：发言`。
 * 元信息标签（录音主题等）不当作说话人。
 */
export function parseTranscript(text) {
  const speakers = new Map() // name -> { order, lines: string[] }
  let current = undefined // 当前说话人名（header-only 模式）

  const ensure = (name) => {
    let entry = speakers.get(name)
    if (entry === undefined) {
      entry = { order: speakers.size, lines: [] }
      speakers.set(name, entry)
    }
    return entry
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const header = line.match(SPEAKER_HEADER)
    if (header !== null) {
      // 说话人头可能带时间戳（`说话人 3 00:00:14`）——归一化为说话人标签。
      const name = header[1].trim().replace(/\s+\d{1,2}:\d{2}:\d{2}$/, '').trim()
      current = METADATA_LABELS.has(name) ? undefined : name
      continue
    }
    const inline = line.match(SPEAKER_INLINE)
    if (inline !== null) {
      const name = inline[1].trim()
      if (METADATA_LABELS.has(name)) continue
      ensure(name).lines.push(inline[2].trim())
      current = undefined
      continue
    }
    // header-only 模式的后续发言行
    if (current !== undefined) {
      ensure(current).lines.push(line)
    }
  }
  return [...speakers.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([name, entry]) => ({ name, count: entry.lines.length, lines: entry.lines }))
}

/** 一位说话人 → 专家画像草稿（只含文本事实，推断字段全部 _needs_review）。 */
export function personDraft(person, sourceName) {
  const fullText = person.lines.join('\n')
  const hits = topicHits(fullText)
  const topics = Object.entries(hits)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([keyword]) => keyword)
  return {
    expert_id: `PERSON-${slug(person.name)}`,
    name: person.name,
    _needs_review: true,
    _draft_source: {
      file: sourceName,
      utterances: person.count,
      note: '由 scripts/import-persons.mjs 从逐字稿启发式提取；立场/风格/心智模型/禁区需人工或 Agent 确认补全后进库。',
    },
    summary: `${person.name} 在「${sourceName}」中发言 ${person.count} 次（${
      person.count > 0 ? representativeLine(person.lines[0] ?? '') : '无有效发言'
    }）`,
    persona: {
      style: [],
      tone: undefined,
      bias: [],
      mentalModels: [],
      signaturePhrases: person.lines.slice(0, 3).map(representativeLine),
      antiPatterns: [],
      analysisSteps: [],
    },
    method: {
      frameworks: [],
      analysis_steps: [],
    },
    topics: topics,
    evidence: {
      representative_quotes: person.lines.slice(0, 5).map(representativeLine),
      first_seen_order: person.order,
    },
  }
}

/** 端到端：解析文件 → 草稿 → 写出目录 + summary.md。返回草稿清单。 */
export async function importPersons(sourcePath, outDir) {
  const info = await stat(sourcePath)
  const inputs = []
  if (info.isDirectory()) {
    for (const name of (await readdir(sourcePath)).sort()) {
      if (/\.(md|txt)$/.test(name)) inputs.push(join(sourcePath, name))
    }
  } else {
    inputs.push(sourcePath)
  }
  if (inputs.length === 0) throw new Error(`输入目录中没有 .md/.txt 文件：${sourcePath}`)

  const allDrafts = []
  for (const file of inputs) {
    const text = await readFile(file, 'utf8')
    const persons = parseTranscript(text)
    const base = basename(file, basename(file).includes('.') ? basename(file).slice(basename(file).lastIndexOf('.')) : '')
    for (const person of persons) {
      if (person.count === 0) continue
      allDrafts.push({ draft: personDraft(person, basename(file)), person })
    }
  }
  if (allDrafts.length === 0) throw new Error('未识别到任何说话人（检查说话人行格式：`**姓名**：发言`）')

  const runDir = join(outDir, `persons-${Date.now().toString(36)}`)
  await mkdir(runDir, { recursive: true })
  for (const { draft } of allDrafts) {
    await writeFile(join(runDir, `${slug(draft.name)}.json`), `${JSON.stringify(draft, null, 2)}\n`)
  }
  const summaryLines = [
    '# 人物转专家草稿汇总（P2.3）',
    '',
    `> 生成：scripts/import-persons.mjs · 输入 ${inputs.length} 份 · 识别 ${allDrafts.length} 位说话人`,
    '',
    '| 姓名 | 发言数 | 议题关键词 | 代表句 |',
    '|---|---|---|---|',
    ...allDrafts.map(({ draft, person }) =>
      `| ${draft.name} | ${person.count} | ${draft.topics.join('/') || '—'} | ${representativeLine(person.lines[0] ?? '')} |`),
    '',
    '> 下一步：逐份补全 `persona.style / mentalModels / antiPatterns / method.analysis_steps` 与立场，',
    '> 改 `expert_id` 为正式编号（BK-xxx / BANK-xxx），去掉 `_needs_review` 后放入 `domain-packs/<包>/source/raw-profiles/` 或知识包 `experts/<id>.json`。',
  ]
  await writeFile(join(runDir, 'summary.md'), `${summaryLines.join('\n')}\n`)
  return { runDir, drafts: allDrafts.map(({ draft, person }) => ({ draft, person })) }
}

/** CLI entry。 */
async function main() {
  const argv = process.argv.slice(2)
  const sourcePath = argv.find(arg => !arg.startsWith('--'))
  const outArg = argv[argv.indexOf('--out') + 1]
  const outDir = resolve(outArg ?? 'work/import-persons')
  if (sourcePath === undefined) {
    console.error('usage: node scripts/import-persons.mjs <逐字稿或目录> [--out <输出目录>]')
    process.exit(2)
  }
  try {
    const result = await importPersons(resolve(sourcePath), outDir)
    console.log(`wrote ${result.runDir}`)
    console.log(`识别 ${result.drafts.length} 位说话人：`)
    for (const { draft, person } of result.drafts) {
      console.log(`  - ${draft.name}（发言 ${person.count} 次，议题 ${draft.topics.join('/') || '—'}）`)
    }
  } catch (error) {
    console.error(`import-persons FAILED: ${error.stack ?? error}`)
    process.exit(1)
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) await main()
