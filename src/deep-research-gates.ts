import { inspectV5Ledger, checkV5FigurePlan, checkV5FigureImplementation } from './viewpoint-research-checks.ts'
import { viewpointOptions } from './human-choice.ts'
import { isResearchV5, isCompactResearch } from './research-release.ts'
import { requiresDesignCritic } from './research-reviewer.ts'
/** Narrow Host checks for the 98wiki deep-research DAG's published bytes. */
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { promisify } from 'node:util'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { ArtifactEvidence, TaskEvidence } from './quality-run.ts'
import type { TeamState, TeamTask } from './types.ts'
import { readAllowedTaskArtifact } from './state.ts'

const run = promisify(execFile)
const OUTLINE_GATE = '/root/.openclaw/workspace/98wiki/projects/craft_gate.sh'
const MATERIALS = [
  { id: 'PROMPT-深度研究.md', path: '/root/.openclaw/workspace/98wiki/projects/PROMPT-深度研究.md' },
  { id: '98wiki-five-articles-gated-research/SKILL.md', path: '/root/.agents/skills/98wiki-five-articles-gated-research/SKILL.md' },
  { id: 'strategy-consulting/SKILL.md', path: '/root/zhijian/dsh-expert-library/knowledge/skills/strategy-consulting/SKILL.md' },
] as const
const REFERENCES = [
  { id: 'designer-v1.html', path: '/root/zhijian/dsh-expert-library/domain-packs/zhijian-realestate/references/zhijian-designer-v1.html', selectors: ['.fig', '.figcap'] },
  { id: 'credit-policy-v1.html', path: '/root/zhijian/dsh-expert-library/domain-packs/zhijian-realestate/references/zhijian-credit-policy-v1.html', selectors: ['.num.tnum', '.chart-card'] },
] as const

const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
function fail(code: string, detail: string): never { throw new Error(`${code}: ${detail}`) }
const SHA256 = /^[a-f0-9]{64}$/u
const PDF_PAGES = String.raw`
import sys,sysconfig,json,hashlib
for key in ('purelib','platlib'):
 p=sysconfig.get_path(key)
 if p and p not in sys.path:sys.path.append(p)
import fitz
raw=sys.stdin.buffer.read(20*1024*1024+1)
if not raw or len(raw)>20*1024*1024:raise ValueError('PDF size invalid')
doc=fitz.open(stream=raw,filetype='pdf')
if len(doc)<int(sys.argv[1]) or len(doc)>300:raise ValueError('PDF page count invalid')
indices={'first':0,'middle':len(doc)//2,'last':len(doc)-1}
print(json.dumps({'pageCount':len(doc),'pages':{name:{'index':index+1,'sha256':hashlib.sha256(doc[index].get_pixmap(matrix=fitz.Matrix(1,1),alpha=False).tobytes('png')).hexdigest()} for name,index in indices.items()}}))
`
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
/** Host renders these current PDF pages itself; reviewer screenshots must match these bytes. */
export async function inspectPdfPages(bytes: Buffer, minPages: 1 | 3 = 3): Promise<{ pageCount: number; pages: Record<string, { index: number; sha256: string }> }> {
  if (bytes.length < 1 || bytes.length > 20 * 1024 * 1024) fail('DEEP_RESEARCH_PDF', 'PDF size invalid')
  return new Promise((resolveResult, reject) => {
    const child = spawn('python3', ['-I', '-c', PDF_PAGES, String(minPages)], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''; let size = 0; let settled = false
    const finish = (error?: Error, value?: { pageCount: number; pages: Record<string, { index: number; sha256: string }> }) => {
      if (settled) return
      settled = true; clearTimeout(timer); child.kill()
      if (error) reject(error); else resolveResult(value!)
    }
    const timer = setTimeout(() => finish(new Error('DEEP_RESEARCH_PDF: page render timed out')), 20_000)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 4096) finish(new Error('DEEP_RESEARCH_PDF: page receipt too large'))
      else output += chunk.toString('utf8')
    })
    child.stderr.on('data', () => {})
    child.on('error', error => finish(error))
    child.on('close', code => {
      if (settled) return
      if (code !== 0) return finish(new Error('DEEP_RESEARCH_PDF: current PDF could not be rendered'))
      try {
        const parsed = JSON.parse(output) as { pageCount: number; pages: Record<string, { index: number; sha256: string }> }
        if (!Number.isSafeInteger(parsed.pageCount) || parsed.pageCount < minPages || parsed.pageCount > 300
          || !object(parsed.pages) || ['first', 'middle', 'last'].some(name => !object(parsed.pages[name]) || !SHA256.test(parsed.pages[name]!.sha256)))
          throw new Error('invalid PDF page receipt')
        finish(undefined, parsed)
      } catch { finish(new Error('DEEP_RESEARCH_PDF: invalid page render receipt')) }
    })
    child.stdin.on('error', error => finish(error))
    child.stdin.end(bytes)
  })
}
function jsonFence(markdown: string, name: string): Record<string, unknown> {
  const found = markdown.match(new RegExp('```json ' + name + '\\s*\\n([\\s\\S]*?)\\n```', 'u'))
  if (found === null) fail('DEEP_RESEARCH_CONTRACT', `missing json ${name} block`)
  let parsed: unknown
  try { parsed = JSON.parse(found[1]!) } catch { fail('DEEP_RESEARCH_CONTRACT', `invalid json ${name} block`) }
  if (!object(parsed)) fail('DEEP_RESEARCH_CONTRACT', `json ${name} must be an object`)
  return parsed
}
function textArtifact(evidence: TaskEvidence, name: string): ArtifactEvidence {
  const matches = evidence.artifacts.filter(item => item.id === `published:${name}`)
  if (matches.length !== 1 || matches[0]!.encoding === 'base64') fail('DEEP_RESEARCH_ARTIFACT', `${name} must be one current UTF-8 publication`)
  return matches[0]!
}
function chapters(markdown: string): string[] {
  return [...markdown.matchAll(/^##\s+(.+?)\s*$/gmu)].map(match => match[1]!.trim())
}
function classes(html: string, selector: string): boolean {
  if (!/^\.[a-z][\w-]*(?:\.[a-z][\w-]*)*$/iu.test(selector)) return false
  const required = selector.slice(1).split('.')
  return [...html.matchAll(/\bclass\s*=\s*["']([^"']+)["']/giu)]
    .some(match => required.every(name => match[1]!.split(/\s+/u).includes(name)))
}
function numbers(value: string): string[] {
  return [...value.matchAll(/(?<![\w])\d+(?:[.,]\d+)?%?(?![\w])/gu)].map(match => match[0])
}

/** One current probe per requested city and channel. Never treat errors or empty series as values. */
export function checkDataChannelStatus(markdown: string, outline: string): void {
  const data = jsonFence(markdown, 'channel-status')
  const cities = data.cities
  const probes = data.probes
  if (!Array.isArray(cities) || cities.length < 1 || cities.length > 5 || !cities.every(nonempty)
    || new Set(cities).size !== cities.length || !Array.isArray(probes) || probes.length !== cities.length * 3)
    fail('DEEP_RESEARCH_DATA_PREFLIGHT', 'declare 1–5 distinct cities and three probe rows per city')
  for (const city of ['北京', '上海']) if (outline.includes(city) && !cities.includes(city))
    fail('DEEP_RESEARCH_DATA_PREFLIGHT', `selected outline city ${city} is absent from probe status`)
  const seen = new Set<string>()
  let available = 0
  for (const raw of probes) {
    if (!object(raw) || !cities.includes(String(raw.city)) || !['wind', 'beike', 'zyt'].includes(String(raw.channel))
      || !['available', 'failed', 'empty', 'unconfigured', 'not_run'].includes(String(raw.status))
      || !nonempty(raw.tool) || !nonempty(raw.request) || !nonempty(raw.reason)) fail('DEEP_RESEARCH_DATA_PREFLIGHT', 'invalid probe row')
    const key = `${raw.city}/${raw.channel}`
    if (seen.has(key)) fail('DEEP_RESEARCH_DATA_PREFLIGHT', `duplicate probe ${key}`)
    seen.add(key)
    if (['available', 'failed', 'empty'].includes(String(raw.status))) {
      if (!nonempty(raw.attemptedAt) || Number.isNaN(Date.parse(raw.attemptedAt)) || !nonempty(raw.receiptSha256) || !SHA256.test(raw.receiptSha256))
        fail('DEEP_RESEARCH_DATA_PREFLIGHT', `${key} needs a timed, hashed actual-call receipt`)
    } else if (raw.attemptedAt !== undefined || raw.receiptSha256 !== undefined) fail('DEEP_RESEARCH_DATA_PREFLIGHT', `${key} was not called`)
    if (raw.status === 'failed' && (!nonempty(raw.errorCode) || !nonempty(raw.fallback)))
      fail('DEEP_RESEARCH_DATA_PREFLIGHT', `${key} needs failure code and bounded fallback`)
    if (raw.status === 'available') available += 1
  }
  if (!['FULL', 'CONDITIONAL', 'BLOCKED'].includes(String(data.researchMode))
    || (available === 0 && data.researchMode === 'FULL')) fail('DEEP_RESEARCH_DATA_PREFLIGHT', 'FULL requires at least one current usable channel')
}

/** Evidence merge pins every reviewed parallel research artifact and exposes source identity. */
export function checkEvidenceMerge(markdown: string, inputs: readonly { task: string; content: string }[]): void {
  const data = jsonFence(markdown, 'evidence-merge')
  const issues: string[] = []
  const expected = inputs.map(input => input.task)
  const declared = Array.isArray(data.inputs) ? data.inputs.filter(object).map(row => row.task) : []
  if (declared.length !== expected.length || new Set(declared).size !== declared.length || declared.some(id => !expected.includes(String(id))))
    issues.push(`inputs must be exactly [${expected.join(', ')}]; received [${declared.join(', ')}]. Outline and channel status are not parallel research inputs`)
  for (const input of inputs) if (!Array.isArray(data.inputs) || !data.inputs.some(row => object(row) && row.task === input.task && row.sha256 === sha(input.content)))
    issues.push(`input ${input.task} SHA256 mismatch`)
  if (!Array.isArray(data.externalIncrements) || data.externalIncrements.length < 10) issues.push('externalIncrements requires at least ten entries')
  if (!['FULL', 'CONDITIONAL'].includes(String(data.status))) issues.push('status must be FULL or CONDITIONAL')
  const ids = new Set<string>()
  if (!Array.isArray(data.sources)) issues.push('sources must be an array')
  for (const row of Array.isArray(data.sources) ? data.sources : []) {
    if (!object(row) || !nonempty(row.id) || !nonempty(row.title) || !nonempty(row.accessedAt) || Number.isNaN(Date.parse(row.accessedAt)) || ids.has(row.id)) {
      issues.push('source identity, access date and unique id required'); continue
    }
    const receipt = row.receipt
    if (row.kind === 'provider_receipt') {
      if (!nonempty(row.provider) || !object(receipt) || !nonempty(receipt.path) || !SHA256.test(String(receipt.sha256))
        || !nonempty(receipt.callPath) || !SHA256.test(String(receipt.callSha256)))
        issues.push(`source ${row.id}: provider_receipt requires provider and receipt path/sha256/callPath/callSha256`)
    } else if (!nonempty(row.url) || !/^https?:\/\//u.test(row.url)) {
      issues.push(`source ${row.id}: HTTP(S) URL required; local data must declare kind=provider_receipt with hashed response and call record`)
    }
    ids.add(row.id)
  }
  if (issues.length) fail('DEEP_RESEARCH_EVIDENCE_MERGE', issues.join('; '))
  const increments = new Set<string>()
  for (const row of data.externalIncrements as unknown[]) {
    if (!object(row) || !nonempty(row.id) || increments.has(row.id) || !nonempty(row.claim)
      || !nonempty(row.novelty) || !ids.has(String(row.sourceId))) fail('DEEP_RESEARCH_EVIDENCE_MERGE', 'external increment must have unique id, source and novelty')
    increments.add(row.id)
  }
}


/** Local receipts are evidence archives, not web citations or proof of provider authenticity.
 * Bind response AND invocation bytes. The independent reviewer still verifies provenance/caliber. */
export async function checkEvidenceReceipts(markdown: string, teamRoot: string): Promise<void> {
  const data = jsonFence(markdown, 'evidence-merge')
  const base = await realpath(teamRoot)
  const errors: string[] = []
  async function bytes(path: string, digest: string): Promise<Buffer> {
    if (isAbsolute(path) || path.split(/[\\/]/u).some(p => !p || p === '.' || p === '..')) throw new Error('receipt path must be team-relative')
    const file = await realpath(resolve(base, path)), rel = relative(base, file)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('receipt path escapes team')
    const info = await stat(file)
    if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error('receipt file invalid or too large')
    const raw = await readFile(file)
    if (sha(raw) !== digest) throw new Error('receipt SHA256 mismatch')
    return raw
  }
  for (const row of (data.sources as unknown[]).filter(object)) {
    if (row.kind !== 'provider_receipt') continue
    try {
      const receipt = row.receipt as Record<string, string>
      const response = await bytes(receipt.path!, receipt.sha256!)
      const call = JSON.parse((await bytes(receipt.callPath!, receipt.callSha256!)).toString('utf8')) as unknown
      if (!object(call) || !nonempty(call.cmd) || !nonempty(call.attemptedAt) || Number.isNaN(Date.parse(call.attemptedAt))
        || call.exitCode !== 0 || (call.stdoutBytes !== undefined && call.stdoutBytes !== response.length)) throw new Error('successful invocation cmd/attemptedAt/exitCode and matching response bytes required')
    } catch (error) { errors.push(`${row.id}: ${String(error)}`) }
  }
  if (errors.length) fail('DEEP_RESEARCH_RECEIPT', errors.join('; '))
}

/** Read-only V5 writer preflight. Acceptance calls this same collector before publication. */
export async function collectV5WriterPreflight(teamRoot: string, files: ReadonlyMap<string, string>): Promise<string[]> {
  const errors: string[] = []
  const report = files.get('report.md') ?? ''
  const inspection = inspectV5Ledger(report, files.get('report-source-ledger.json') ?? '')
  const ledger = inspection.ledger
  errors.push(...inspection.errors.map(error => `V5_SOURCE_LEDGER: ${error}; retryable=true; repairBudgetCharged=false`))
  if (ledger !== undefined) {
    try { await checkEvidenceReceipts('```json evidence-merge\n' + JSON.stringify(ledger) + '\n```', teamRoot) }
    catch (error) { errors.push(String(error)) }
    try { checkV5FigurePlan(report, files.get('figure-plan.json') ?? '', ledger) }
    catch (error) { errors.push(String(error)) }
  }
  if (!files.get('OUTLINE.md')?.trim()) errors.push('V5_OUTLINE_MISSING: record the actual evidence-led structure')
  for (const [name, content] of files) {
    if (/\.(md|json)$/u.test(name) && !content.trim()) errors.push(`V5_EMPTY_MATERIAL: ${name}`)
  }
  return errors
}

/** The same deterministic writer checks run before publication and again at acceptance. */
export async function checkWriterSubmission(stateRoot: string, team: TeamState, task: TeamTask, files: ReadonlyMap<string, string>): Promise<void> {
  if (isResearchV5(team)) {
    if(task.planTask?.logicalId==='viewpoints') viewpointOptions(files.get('viewpoints.md')??'')
    if(task.planTask?.logicalId==='writer') {
      const errors = await collectV5WriterPreflight(resolve(stateRoot, team.id), files)
      if (errors.length) fail('V5_WRITER_PREFLIGHT', JSON.stringify({ retryable: true, repairBudgetCharged: false, errors }))
    }
    for(const [name,content] of files) if(/\.(md|json)$/u.test(name)&&!content.trim()) fail('V5_EMPTY_MATERIAL',name)
    return
  }
  if (!isCompactResearch(team) || task.planTask?.logicalId !== 'writer') return
  const outline = await inputText(stateRoot, team, task, 'outline_final', 'OUTLINE.md')
  const report = files.get('report.md') ?? '', merged = files.get('research-evidence.md') ?? ''
  const inputs = await Promise.all(['main','counter'].map(async kind => ({task: `research_${kind}`, content: await inputText(stateRoot,team,task,`research_${kind}`,`research-${kind}.md`)})))
  const errors: string[] = []
  for (const check of [
    () => checkEvidenceMerge(merged, inputs),
    () => checkEvidenceReceipts(merged, resolve(stateRoot, team.id)),
    () => checkReportSourcePreflight(report, outline),
    () => checkReportSourceLedger(files.get('report-source-ledger.json') ?? '',report,outline,merged),
  ]) { try { await check() } catch (error) { errors.push(String(error)) } }
  if (errors.length) fail('RESEARCH_SUBMISSION_PREFLIGHT', JSON.stringify({retryable:true, repairBudgetCharged:false, errors}))
}

/** The writer's source ledger binds all five chapter parts and every measured value to current upstream bytes. */
export function checkReportSourceLedger(ledgerText: string, report: string, outline: string, evidence: string): void {
  let parsed: unknown
  try { parsed = JSON.parse(ledgerText) } catch { fail('DEEP_RESEARCH_SOURCE_LEDGER', 'invalid JSON') }
  if (!object(parsed) || parsed.schemaVersion !== 1 || parsed.outlineSha256 !== sha(outline)
    || parsed.evidenceSha256 !== sha(evidence) || parsed.reportSha256 !== sha(report)
    || !Array.isArray(parsed.chapters)) fail('DEEP_RESEARCH_SOURCE_LEDGER', 'current outline/evidence/report SHA256 required')
  const expected = chapters(outline)
  const actual = chapters(report).filter(title => expected.includes(title))
  if (parsed.chapters.length !== expected.length || actual.length !== expected.length) fail('DEEP_RESEARCH_SOURCE_LEDGER', 'all selected analysis chapters must be listed')
  const evidenceData = jsonFence(evidence, 'evidence-merge')
  const sourceIds = new Set((evidenceData.sources as unknown[]).filter(object).map(row => row.id))
  for (const [index, raw] of parsed.chapters.entries()) {
    if (!object(raw) || raw.heading !== expected[index] || !object(raw.parts) || !Array.isArray(raw.sourceIds)
      || raw.sourceIds.length < 1 || raw.sourceIds.some(id => !sourceIds.has(id)) || !Array.isArray(raw.numericClaims))
      fail('DEEP_RESEARCH_SOURCE_LEDGER', `chapter ${index + 1} has invalid heading or sources`)
    const start = report.indexOf(`## ${expected[index]}`)
    const nextHeading = report.indexOf('\n## ', start + 3)
    const next = nextHeading < 0 ? report.length : nextHeading
    const body = report.slice(start, next)
    const spans: string[] = []
    for (const part of ['position', 'roles', 'basis', 'inference', 'opportunity', 'risk']) {
      const quote = raw.parts[part]
      if (!nonempty(quote) || quote.length < 8 || !body.includes(quote) || spans.includes(quote))
        fail('DEEP_RESEARCH_SOURCE_LEDGER', `${expected[index]} missing substantive ${part} quote`)
      spans.push(quote)
    }
    if (!raw.sourceIds.some(id => body.includes(String(id)))) fail('DEEP_RESEARCH_SOURCE_LEDGER', `${expected[index]} does not cite its declared source`)
    for (const claim of raw.numericClaims) {
      if (!object(claim) || !nonempty(claim.quote) || !body.includes(claim.quote)
        || !sourceIds.has(claim.sourceId) || !nonempty(claim.date) || !nonempty(claim.geography)
        || !nonempty(claim.unit) || !nonempty(claim.caliber)
        || !['reported', 'estimated', 'derived'].includes(String(claim.kind))
        || (claim.kind === 'derived' && !nonempty(claim.formula)))
        fail('DEEP_RESEARCH_SOURCE_NUMBERS', `${expected[index]} has an untraceable numeric claim`)
    }
    const quantified = /\d+(?:[.,]\d+)?\s*(?:%|亿元|万元|元|套|平方米|倍)(?![\w])/gu
    for (const match of body.matchAll(quantified)) {
      const offset = match.index
      if (!raw.numericClaims.some(claim => {
        if (!object(claim) || !nonempty(claim.quote)) return false
        const quote = claim.quote
        return [...body.matchAll(new RegExp(quote.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu'))]
          .some(span => offset >= span.index && offset < span.index + quote.length)
      }))
        fail('DEEP_RESEARCH_SOURCE_NUMBERS', `${expected[index]} has an unlisted measured value ${match[0]}`)
    }
  }
}

export function checkContentReview(markdown: string, report: string, outline: string, ledger: string): void {
  if (!markdown.includes(`报告SHA256: ${sha(report)}`) || !markdown.includes(`来源台账SHA256: ${sha(ledger)}`)
    || !/^结论:\s*PASS\s*$/mu.test(markdown))
    fail('DEEP_RESEARCH_CONTENT_REVIEW', 'independent review must bind current report and source ledger SHA256 with a PASS verdict')
  for (const chapter of chapters(outline)) if (!markdown.includes(`## ${chapter}`))
    fail('DEEP_RESEARCH_CONTENT_REVIEW', `missing chapter review: ${chapter}`)
}

export function checkReviewedReportCopy(copy: string, writerReport: string): void {
  if (copy !== writerReport) fail('DEEP_RESEARCH_REVIEWED_REPORT', 'content reviewer must republish the exact approved writer report')
}

/** Check the immutable Markdown source before figure design or rendering. */
export function checkReportSourcePreflight(report: string, outline: string): void {
  const headings = (source: string) => {
    const tree = fromMarkdown(source)
    return tree.children.filter(node => node.type === 'heading').map(node => {
      if (node.type !== 'heading') throw new Error('unreachable')
      const text = source.slice(node.position!.start.offset!, node.position!.end.offset!)
        .replace(/^#{1,6}\s*/u, '').replace(/\s*#+\s*$/u, '').trim()
      return { depth: node.depth, title: text, start: node.position!.start.offset!, end: node.position!.end.offset! }
    })
  }
  const reportHeadings = headings(report)
  const outlineHeadings = headings(outline)
  // Keep this H2 exemption aligned with the selected pack's chapter inventory.
  // In particular, “外部增量清单” and “报告薄弱点” are analysis H2 there.
  const metadata = /^(?:卷首速览|摘要|目录|总论|来源披露|数据来源|附录|观察清单|信息缺口|封面|封底|免责声明|Introduction|Source Disclosure|Appendix|Contents|Abstract|Disclaimer)(?:\s|[（(:：]|$)/iu
  const closing = /^(?:总结|结语|结论)(?:(?:与|及)(?:行动|建议))?(?:\s|[（(:：]|$)/u
  const analysis = (rows: typeof reportHeadings) => rows.filter(row => row.depth === 2 && !metadata.test(row.title) && !closing.test(row.title)).map(row => row.title)
  const section = (row: typeof reportHeadings[number]) => {
    const next = reportHeadings.find(candidate => candidate.start > row.start && candidate.depth <= row.depth)
    return report.slice(row.end, next?.start ?? report.length)
  }
  for (const label of ['卷首速览', '总论']) {
    const row = reportHeadings.find(item => item.depth === 2 && new RegExp(`^${label}(?:\\s|[（(:：]|$)`, 'u').test(item.title))
    if (row === undefined || section(row).trim().length < 12) fail('DEEP_RESEARCH_SOURCE_OPENING', `report.md needs substantive ${label}`)
  }
  const expected = analysis(outlineHeadings)
  const actual = analysis(reportHeadings)
  if (expected.length < 5 || expected.length !== actual.length || expected.some((title, index) => title !== actual[index])) {
    fail('DEEP_RESEARCH_SOURCE_CHAPTERS', `report.md analysis H2 chapters must match selected OUTLINE.md in order; expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
  }
  const disclosure = reportHeadings.find(row => /^(?:数据)?来源披露(?:\s|[（(:：]|$)/u.test(row.title))
  if (disclosure === undefined) fail('DEEP_RESEARCH_SOURCE_DISCLOSURE', 'report.md needs an explicit 来源披露 heading')
  const disclosed = section(disclosure).replace(/\*\*|__|`/gu, '')
  const status = '(?:已透出数值|本轮采用|已采用|仅趋势|仅小样本|时点快照|待补|未配置|未采用|未使用|未调用|未接入|通道失败|调用失败|不可用|未交付|无数值|空序列)'
  for (const channel of ['(?:Wind|万得)', '(?:政研通|zyt)', '(?:贝壳|beike)']) {
    if (!new RegExp(`^\\s*(?:[-*]\\s*|\\|\\s*)?${channel}[^\\n]*?(?:[:：|])[^\\n]*?${status}`, 'imu').test(disclosed)) {
      fail('DEEP_RESEARCH_SOURCE_DISCLOSURE', `report.md 来源披露 needs an explicit status for ${channel}`)
    }
  }
  const closingSection = reportHeadings.find(row => closing.test(row.title))
  if (closingSection === undefined || closingSection.start <= Math.max(...reportHeadings.filter(row => row.depth === 2 && actual.includes(row.title)).map(row => row.start))) {
    fail('DEEP_RESEARCH_SOURCE_CLOSING', 'report.md needs a closing summary after the analysis chapters')
  }
  const conclusion = section(closingSection).replace(/\*\*|__|`/gu, '')
  const prose = conclusion.split('\n').some(line => line.trim() && !/^\s*(?:>|#|[-*]\s|\|)/u.test(line))
  const quote = /(?:^>\s*\S|^\s*(?:收束金句|收束句|结尾金句)\s*[:：]\s*\S)/mu.test(conclusion)
  if (!prose || !quote) fail('DEEP_RESEARCH_SOURCE_CLOSING', 'closing section needs summary prose and an explicit closing quote')
}

/** Keep the renderer's repair loop open until the bound visual critic signs off. */
export function checkDeepResearchReviewer(team: TeamState, task: TeamTask, callerId: string): void {
  if (!requiresDesignCritic(team, task)) return
  if (team.members.find(member => member.id === callerId)?.capabilityScope?.expertId !== 'design-critic')
    fail('DEEP_RESEARCH_RENDER_REVIEWER', 'the bound design critic must review renderer before integration')
}

export async function requiredOutlineMaterials(): Promise<{ id: string; sha256: string; path: string }[]> {
  return Promise.all(MATERIALS.map(async material => ({ ...material, sha256: sha(await readFile(material.path)) })))
}

export async function checkOutlineCandidates(markdown: string): Promise<void> {
  for (const option of ['A', 'B', 'C']) {
    if (!new RegExp(`^##\\s+${option}(?:\\s|[｜:：])`, 'mu').test(markdown)) fail('DEEP_RESEARCH_OUTLINE_CANDIDATES', `missing ${option} outline`)
  }
  for (const material of await requiredOutlineMaterials()) {
    if (!markdown.includes(material.id) || !markdown.includes(material.sha256)) fail('DEEP_RESEARCH_MATERIAL_NOT_BOUND', `${material.id} and its current SHA256 must appear in the candidate artifact`)
  }
}

export async function checkSelectedOutline(markdown: string, choice: string, candidateSha: string, immutablePath: string): Promise<void> {
  if (!markdown.includes(`选择: ${choice}`) || !markdown.includes(`候选稿SHA256: ${candidateSha}`)) fail('DEEP_RESEARCH_OUTLINE_CHOICE', 'selected outline must bind the Host choice and reviewed candidate SHA256')
  if (chapters(markdown).length < 5) fail('DEEP_RESEARCH_OUTLINE_CHAPTERS', 'selected outline needs at least five chapters')
  try { await run('bash', [OUTLINE_GATE, 'outline', immutablePath], { timeout: 10_000, maxBuffer: 64 * 1024 }) }
  catch (error) { fail('DEEP_RESEARCH_OUTLINE_GATE', error instanceof Error ? error.message.slice(0, 2000) : 'outline gate failed') }
}

export function checkPointFigures(specMarkdown: string, fragments: string, outline: string, report: string): void {
  const match = specMarkdown.match(/```json figure-spec\s*\n([\s\S]*?)\n```/u)
  if (!match) fail('DEEP_RESEARCH_FIGURE_SPEC', 'figure-spec.md needs one json figure-spec block')
  let parsed: unknown
  try { parsed = JSON.parse(match[1]!) } catch { fail('DEEP_RESEARCH_FIGURE_SPEC', 'invalid JSON block') }
  const items = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { figures?: unknown }).figures : undefined
  const expected = chapters(outline)
  if (!Array.isArray(items) || items.length !== expected.length || expected.length < 5) fail('DEEP_RESEARCH_FIGURE_COUNT', 'exactly one figure per selected outline chapter is required')
  const rendered = [...fragments.matchAll(/\bdata-chapter\s*=\s*["']([^"']+)["']/gu)].map(item => item[1])
  if (rendered.length !== expected.length) fail('DEEP_RESEARCH_FIGURE_FRAGMENT_COUNT', 'one data-chapter card per outline chapter is required')
  const reportNumbers = new Set(numbers(report))
  const visible = fragments.replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '').replace(/<[^>]+>/gu, ' ')
  for (const value of numbers(visible)) if (!reportNumbers.has(value)) fail('DEEP_RESEARCH_FIGURE_NEW_NUMBER', `${value} is absent from report.md`)
  expected.forEach((chapter, index) => {
    const row = items[index]
    if (row === null || typeof row !== 'object' || Array.isArray(row)) fail('DEEP_RESEARCH_FIGURE_SPEC', `figure ${index + 1} is invalid`)
    const fig = row as Record<string, unknown>
    if (fig.chapter !== chapter || rendered[index] !== chapter || !report.includes(`## ${chapter}`)
      || typeof fig.claim !== 'string' || !fig.claim.trim()
      || typeof fig.selector !== 'string' || !classes(fragments, fig.selector)
      || typeof fig.sourceQuote !== 'string' || !fig.sourceQuote.trim() || !report.includes(fig.sourceQuote)
      || !Array.isArray(fig.data) || fig.data.some(value => typeof value !== 'string' || !report.includes(value))) {
      fail('DEEP_RESEARCH_FIGURE_BINDING', `figure ${index + 1} must bind chapter, selector, claim and actual report source line`)
    }
  })
}

export async function checkRenderReferences(mappingText: string, html: string, outline: string, fragments: string): Promise<void> {
  let parsed: unknown
  try { parsed = JSON.parse(mappingText) } catch { fail('DEEP_RESEARCH_REFERENCE_MAP', 'invalid JSON') }
  const rows = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { references?: unknown }).references : undefined
  if (!Array.isArray(rows) || rows.length !== REFERENCES.length) fail('DEEP_RESEARCH_REFERENCE_MAP', 'both reference mappings are required')
  const expectedChapters = new Set(chapters(outline))
  for (const reference of REFERENCES) {
    const source = await readFile(reference.path)
    const matches = rows.filter(row => row !== null && typeof row === 'object' && !Array.isArray(row) && (row as Record<string, unknown>).id === reference.id)
    if (matches.length !== 1) fail('DEEP_RESEARCH_REFERENCE_MAP', `missing unique ${reference.id} mapping`)
    const row = matches[0] as Record<string, unknown>
    if (row.sha256 !== sha(source) || typeof row.sourceSelector !== 'string' || !(reference.selectors as readonly string[]).includes(row.sourceSelector)
      || !classes(source.toString('utf8'), row.sourceSelector)
      || typeof row.outputSelector !== 'string' || !classes(html, row.outputSelector)
      || typeof row.chapter !== 'string' || !expectedChapters.has(row.chapter)
      || !html.includes(row.chapter)
      || typeof row.reason !== 'string' || !row.reason.trim()) {
      fail('DEEP_RESEARCH_REFERENCE_BINDING', `${reference.id} must bind its current bytes, source selector, rendered selector and selected chapter`)
    }
  }
  const renderedChapters = [...html.matchAll(/\bdata-chapter\s*=\s*["']([^"']+)["']/gu)].map(match => match[1])
  if (renderedChapters.length !== expectedChapters.size || renderedChapters.some(chapter => !expectedChapters.has(chapter!))) fail('DEEP_RESEARCH_RENDER_FIGURE', 'rendered HTML needs exactly one figure for each selected chapter')
  if (!fragments.trim()) fail('DEEP_RESEARCH_RENDER_FRAGMENT', 'reviewed figure fragments are empty')
  // The selected domain checker performs parsed-DOM card identity and chapter containment checks.
  // A full-string HTML comparison here would incorrectly force all chapter cards into one block.
}

/** The domain checker validates the two visible layers; Host authenticates the figure layer's source. */
export function checkRenderFigureLayer(craftText: string, fragments: string, outline: string): void {
  let parsed: unknown
  try { parsed = JSON.parse(craftText) } catch { fail('DEEP_RESEARCH_FIGURE_LAYER', 'invalid craft evidence JSON') }
  const layer = object(parsed) && parsed.schemaVersion === 3 ? parsed.figureLayer : undefined
  if (!object(layer) || layer.fragmentsHtml !== fragments || layer.sha256 !== sha(fragments)
    || !Array.isArray(layer.chapters) || JSON.stringify(layer.chapters) !== JSON.stringify(chapters(outline)))
    fail('DEEP_RESEARCH_FIGURE_LAYER', 'schema 3 must bind the exact reviewed figure bytes and selected chapter order')
}

/** Resolve the consumer's pinned publication, never the first/latest source version. */
async function pinnedInput(stateRoot: string, team: TeamState, task: TeamTask, logicalId: string, name: string) {
  const override = task.inputSourceOverrides?.[logicalId]
  if (override !== undefined) {
    const revision = task.inputRevisions?.slice().reverse().find(row => row.logicalSource === logicalId)
    if (revision?.replacementTaskId !== override) fail('DEEP_RESEARCH_INPUT_NOT_PINNED', `${logicalId}/${name}: missing source revision receipt`)
    const approved = revision.nextManifest.filter(row => row.sourceTaskId === override && row.reviewArtifactId === `published:${name}`)
    const frozen = task.inputArtifactManifest?.find(row => row.sourceTaskId === override && row.reviewArtifactId === `published:${name}`)
    if (approved.length !== 1 || frozen === undefined || approved[0]?.artifactId !== frozen.artifactId
      || approved[0]?.sha256 !== frozen.sha256 || approved[0]?.attempt !== frozen.attempt
      || approved[0]?.versionPath !== frozen.versionPath) fail('DEEP_RESEARCH_INPUT_NOT_PINNED', `${logicalId}/${name}: revision publication changed`)
  }
  const sources = team.tasks.filter(candidate => override === undefined ? candidate.planTask?.logicalId === logicalId : candidate.id === override)
  const source = sources[0]
  if (sources.length !== 1 || source?.status !== 'completed') fail('DEEP_RESEARCH_INPUT_NOT_PINNED', `${logicalId}/${name}`)
  const refs = (task.inputArtifacts ?? []).filter(ref => ref.sourceTaskId === source.id
    && source.publishedArtifacts?.some(artifact => artifact.id === ref.artifactId && artifact.reviewId === `published:${name}`))
  const ref = refs[0]
  if (refs.length !== 1 || ref === undefined) fail('DEEP_RESEARCH_INPUT_NOT_PINNED', `${logicalId}/${name}`)
  // The shared reader enforces dependency allowlists, publication identity,
  // frozen attempt/path/hash, directory containment and actual file bytes.
  return readAllowedTaskArtifact(stateRoot, team, task, ref)
}

async function inputText(stateRoot: string, team: TeamState, task: TeamTask, logicalId: string, name: string): Promise<string> {
  const selected = await pinnedInput(stateRoot, team, task, logicalId, name)
  if (selected.encoding !== undefined) fail('DEEP_RESEARCH_INPUT_NOT_TEXT', `${logicalId}/${name}`)
  return selected.content
}

async function inputBytes(stateRoot: string, team: TeamState, task: TeamTask, logicalId: string, name: string): Promise<Buffer> {
  const selected = await pinnedInput(stateRoot, team, task, logicalId, name)
  const bytes = selected.encoding === 'base64' ? Buffer.from(selected.content, 'base64') : Buffer.from(selected.content)
  const actual = sha(bytes)
  if (actual !== selected.artifact.sha256) fail('DEEP_RESEARCH_INPUT_CHANGED', `${logicalId}/${name}`)
  return bytes
}
async function inputHash(stateRoot: string, team: TeamState, task: TeamTask, logicalId: string, name: string): Promise<string> {
  return sha(await inputBytes(stateRoot, team, task, logicalId, name))
}

function auditReceipt(markdown: string, kind: 'visual-audit' | 'delivery-audit', minPages = 3): Record<string, unknown> {
  const audit = jsonFence(markdown, kind)
  if (audit.verdict !== 'PASS' || !nonempty(audit.checkedAt) || Number.isNaN(Date.parse(audit.checkedAt))
    || !nonempty(audit.method) || !Number.isSafeInteger(audit.pageCount) || (audit.pageCount as number) < minPages
    || !object(audit.pages)) fail('DEEP_RESEARCH_VISUAL_AUDIT', `${kind} needs a timed PASS, method, page count and page checks`)
  const pages = audit.pages as Record<string, unknown>
  for (const name of ['first', 'middle', 'last']) {
    const page = pages[name]
    if (!object(page) || !Number.isSafeInteger(page.index) || (page.index as number) < 1
      || (page.index as number) > (audit.pageCount as number) || !SHA256.test(String(page.sha256)) || !nonempty(page.finding))
      fail('DEEP_RESEARCH_VISUAL_AUDIT', `${kind} pages.${name} must be an object with one-based integer index, 64-character lowercase sha256 and nonempty finding`)
  }
  if (audit.blockers !== 0) fail('DEEP_RESEARCH_VISUAL_AUDIT', `${kind} cannot pass with blockers`)
  return audit
}
export async function verifyPdfAudit(bytes: Buffer, audit: Record<string, unknown>, minPages: 1 | 3 = 3): Promise<void> {
  const current = await inspectPdfPages(bytes,minPages)
  if (audit.pageCount !== current.pageCount || !object(audit.pages)
    || ['first', 'middle', 'last'].some(name => {
      const page = (audit.pages as Record<string, unknown>)[name]
      return !object(page) || page.index !== current.pages[name]!.index || page.sha256 !== current.pages[name]!.sha256
    })) fail('DEEP_RESEARCH_PDF_AUDIT', 'first/middle/last screenshot hashes must match Host rerender of current PDF')
}
async function checkPdfAudit(stateRoot: string, team: TeamState, task: TeamTask, renderId: string, audit: Record<string, unknown>): Promise<void> {
  await verifyPdfAudit(await inputBytes(stateRoot, team, task, renderId, 'report.pdf'), audit)
}

/** Called inside the locked quality-review path, after immutable bytes are collected. */
export async function checkDeepResearchPass(stateRoot: string, team: TeamState, task: TeamTask, evidence: TaskEvidence): Promise<void> {
  if (team.planRef?.scenarioId !== '98wiki-deep-research') return
  if(isResearchV5(team)) {
    if(task.planTask?.logicalId==='writer') await checkWriterSubmission(stateRoot,team,task,new Map(['report.md','report-source-ledger.json','OUTLINE.md','figure-plan.json'].map(n=>[n,textArtifact(evidence,n).content])))
    if(task.planTask?.logicalId==='renderer') {
      if(textArtifact(evidence,'report.md').content !== await inputText(stateRoot,team,task,'writer','report.md')) fail('DEEP_RESEARCH_RENDER_MD_CHANGED','renderer cannot revise approved text')
      checkV5FigureImplementation(await inputText(stateRoot,team,task,'writer','figure-plan.json'),textArtifact(evidence,'craft-evidence.json').content)
    }
    return
  }
  if (isCompactResearch(team)) {
    const logical = task.planTask?.logicalId
    if (logical === 'outline_final') {
      const outline = textArtifact(evidence, 'OUTLINE.md')
      if (chapters(outline.content).length < 5) fail('DEEP_RESEARCH_OUTLINE_CHAPTERS', 'at least five chapters required')
      for (const material of await requiredOutlineMaterials()) if (!outline.content.includes(material.id) || !outline.content.includes(material.sha256)) fail('DEEP_RESEARCH_MATERIAL_NOT_BOUND', material.id)
      try { await run('bash', [OUTLINE_GATE, 'outline', resolve(stateRoot, outline.path)], { timeout: 10_000, maxBuffer: 64 * 1024 }) }
      catch { fail('DEEP_RESEARCH_OUTLINE_GATE', 'compact outline failed the existing structure gate') }
      checkDataChannelStatus(textArtifact(evidence, 'data-channel-status.md').content, outline.content)
      return
    }
    if (logical === 'writer') {
      await checkWriterSubmission(stateRoot, team, task, new Map(['report.md','research-evidence.md','report-source-ledger.json'].map(name => [name,textArtifact(evidence,name).content])))
      return
    }
    if (logical === 'renderer') {
      const outline = await inputText(stateRoot,team,task,'outline_final','OUTLINE.md')
      const report = await inputText(stateRoot,team,task,'writer','report.md')
      if (textArtifact(evidence,'report.md').content !== report) fail('DEEP_RESEARCH_RENDER_MD_CHANGED','renderer cannot revise the approved report')
      const fragments = textArtifact(evidence,'figure-fragments.html').content
      checkPointFigures(textArtifact(evidence,'figure-spec.md').content,fragments,outline,report)
      await checkRenderReferences(textArtifact(evidence,'reference-map.json').content,textArtifact(evidence,'report.html').content,outline,fragments)
      checkRenderFigureLayer(textArtifact(evidence,'craft-evidence.json').content,fragments,outline)
      return
    }
  }
  switch (task.planTask?.logicalId) {
    case 'outline_candidates':
      await checkOutlineCandidates(textArtifact(evidence, 'outline-candidates.md').content)
      break
    case 'outline_final': {
      const choice = team.tasks.find(candidate => candidate.planTask?.logicalId === 'outline_choice')?.humanChoiceReceipt
      if (choice === undefined) fail('DEEP_RESEARCH_CHOICE_MISSING', 'Host user choice is required')
      const artifact = textArtifact(evidence, 'OUTLINE.md')
      await checkSelectedOutline(artifact.content, choice.choice, choice.sourceSha256, resolve(stateRoot, artifact.path))
      break
    }
    case 'data_preflight':
      checkDataChannelStatus(textArtifact(evidence, 'data-channel-status.md').content,
        await inputText(stateRoot, team, task, 'outline_final', 'OUTLINE.md'))
      break
    case 'evidence_merge': {
      const ids = ['research_main', 'research_counter', ...team.tasks.map(item => item.planTask?.logicalId).filter((id): id is string => typeof id === 'string' && id.startsWith('research_view_'))].sort()
      const inputs = await Promise.all(ids.map(async id => ({ task: id, content: await inputText(stateRoot, team, task, id,
        id === 'research_main' ? 'research-main.md' : id === 'research_counter' ? 'research-counter.md' : `${id}.md`) })))
      checkEvidenceMerge(textArtifact(evidence, 'research-evidence.md').content, inputs)
      break
    }
    case 'point_figures':
      checkPointFigures(textArtifact(evidence, 'figure-spec.md').content, textArtifact(evidence, 'figure-fragments.html').content,
        await inputText(stateRoot, team, task, 'outline_final', 'OUTLINE.md'), await inputText(stateRoot, team, task, 'writer', 'report.md'))
      break
    case 'writer':
      checkReportSourcePreflight(textArtifact(evidence, 'report.md').content,
        await inputText(stateRoot, team, task, 'outline_final', 'OUTLINE.md'))
      checkReportSourceLedger(textArtifact(evidence, 'report-source-ledger.json').content,
        textArtifact(evidence, 'report.md').content,
        await inputText(stateRoot, team, task, 'outline_final', 'OUTLINE.md'),
        await inputText(stateRoot, team, task, 'evidence_merge', 'research-evidence.md'))
      break
    case 'content_review':
      checkReviewedReportCopy(textArtifact(evidence, 'report.md').content,
        await inputText(stateRoot, team, task, 'writer', 'report.md'))
      checkContentReview(textArtifact(evidence, 'review-notes.md').content,
        await inputText(stateRoot, team, task, 'writer', 'report.md'),
        await inputText(stateRoot, team, task, 'outline_final', 'OUTLINE.md'),
        await inputText(stateRoot, team, task, 'writer', 'report-source-ledger.json'))
      break
    case 'renderer':
    case 'render_revision_1':
      if (textArtifact(evidence, 'report.md').content !== await inputText(stateRoot, team, task, 'writer', 'report.md'))
        fail('DEEP_RESEARCH_RENDER_MD_CHANGED', 'renderer must preserve the reviewed writer report.md bytes')
      await checkRenderReferences(textArtifact(evidence, 'reference-map.json').content, textArtifact(evidence, 'report.html').content,
        await inputText(stateRoot, team, task, 'outline_final', 'OUTLINE.md'), await inputText(stateRoot, team, task, 'point_figures', 'figure-fragments.html'))
      if (/^3\./u.test(team.planRef?.templateVersion ?? '')) checkRenderFigureLayer(
        textArtifact(evidence, 'craft-evidence.json').content,
        await inputText(stateRoot, team, task, 'point_figures', 'figure-fragments.html'),
        await inputText(stateRoot, team, task, 'outline_final', 'OUTLINE.md'))
      break
    case 'visual_review':
    case 'visual_review_1': {
      if (!/^3\./u.test(team.planRef?.templateVersion ?? '')) break
      const renderId = task.planTask?.logicalId === 'visual_review_1' ? 'render_revision_1' : 'renderer'
      const audit = auditReceipt(textArtifact(evidence, 'visual-review.md').content, 'visual-audit')
      if (audit.htmlSha256 !== await inputHash(stateRoot, team, task, renderId, 'report.html')
        || audit.pdfSha256 !== await inputHash(stateRoot, team, task, renderId, 'report.pdf')
        || !nonempty(audit.dom) || !nonempty(audit.wide) || !nonempty(audit.narrow)
        || !nonempty(audit.interactions) || !nonempty(audit.accessibility))
        fail('DEEP_RESEARCH_VISUAL_AUDIT', 'visual review must bind current HTML/PDF and record DOM, viewport, interaction and accessibility inspections')
      await checkPdfAudit(stateRoot, team, task, renderId, audit)
      break
    }
    case 'finalqa': {
      if (!/^3\./u.test(team.planRef?.templateVersion ?? '')) break
      const revised = task.dependencies.some(id => team.tasks.find(candidate => candidate.id === id)?.planTask?.logicalId === 'render_revision_1')
      const renderId = revised ? 'render_revision_1' : 'renderer'
      const reviewId = revised ? 'visual_review_1' : 'visual_review'
      if (!task.dependencies.some(id => team.tasks.find(candidate => candidate.id === id)?.planTask?.logicalId === reviewId))
        fail('DEEP_RESEARCH_DELIVERY', 'finalqa must depend on the matching current visual review')
      const audit = auditReceipt(textArtifact(evidence, 'delivery-check.md').content, 'delivery-audit')
      const review = await inputText(stateRoot, team, task, reviewId, 'visual-review.md')
      const hashes = await Promise.all(['report.md', 'report.html', 'report.pdf', 'craft-evidence.json', 'reference-map.json']
        .map(name => inputHash(stateRoot, team, task, renderId, name)))
      if (audit.visualReviewSha256 !== sha(review) || !object(audit.artifacts)
        || ['report.md', 'report.html', 'report.pdf', 'craft-evidence.json', 'reference-map.json']
          .some((name, index) => (audit.artifacts as Record<string, unknown>)[name] !== hashes[index]))
        fail('DEEP_RESEARCH_DELIVERY', 'delivery audit must bind the current visual review and every renderer artifact')
      await checkPdfAudit(stateRoot, team, task, renderId, audit)
      break
    }
  }
}

/** V4 keeps independent substantive audits on the producer's exact revision. */
export async function checkCompactReviewAudit(root: string, team: TeamState, task: TeamTask, evidence: TaskEvidence, notes?: string): Promise<void> {
  if (!isCompactResearch(team) || !['writer','renderer'].includes(task.planTask?.logicalId ?? '')) return
  if (!notes?.trim() || notes.length > 100_000) fail('RESEARCH_REVIEW_AUDIT_REQUIRED','provide real independent content/visual review notes in review_audit')
  if (isResearchV5(team) && task.planTask?.logicalId === 'writer') {
    const audit=jsonFence(notes.replace('```content-audit','```json content-audit'),'content-audit')
    if(!['argument','novelty','sources','calculations','uncertainty','coverage'].every(k=>nonempty(audit[k]))) fail('V5_CONTENT_AUDIT','describe actual argument, evidence-led novelty, sources, calculations, uncertainty and omitted-claim coverage; Host binds artifact hashes automatically')
    return
  }
  if (task.planTask?.logicalId === 'writer') {
    checkContentReview(notes,textArtifact(evidence,'report.md').content,await inputText(root,team,task,'outline_final','OUTLINE.md'),textArtifact(evidence,'report-source-ledger.json').content)
  } else {
    const audit = auditReceipt(notes,'visual-audit',isResearchV5(team)?1:3)
    const html = textArtifact(evidence,'report.html')
    const pdf = evidence.artifacts.find(a => a.id === 'published:report.pdf')
    const requiredVisualFields = isResearchV5(team) ? ['dom','wide','narrow','accessibility','references','figures'] : ['dom','wide','narrow','interactions','accessibility']
    if (!pdf || audit.htmlSha256 !== html.sha256 || audit.pdfSha256 !== pdf.sha256) fail('DEEP_RESEARCH_VISUAL_AUDIT','htmlSha256 and pdfSha256 must match the current published HTML/PDF bytes')
    const missingVisualFields = requiredVisualFields.filter(k => !nonempty(audit[k]))
    if (missingVisualFields.length) fail('DEEP_RESEARCH_VISUAL_AUDIT',`top-level nonempty string fields required: ${missingVisualFields.join(', ')}`)
    if (isResearchV5(team)) {
      const plan=JSON.parse(await inputText(root,team,task,'writer','figure-plan.json')) as {chapters:{chapter:string}[]}
      if (!['credit-policy','designer-paper',...plan.chapters.map(c=>c.chapter)].every(label=>String(label==='credit-policy'||label==='designer-paper'?audit.references:audit.figures).includes(label))) fail('V5_VISUAL_REVIEW_COVERAGE','review both reference decisions and each actual analytical chapter figure')
    }
    await verifyPdfAudit(await readFile(resolve(root,pdf.path)),audit,isResearchV5(team)?1:3)
  }
}
