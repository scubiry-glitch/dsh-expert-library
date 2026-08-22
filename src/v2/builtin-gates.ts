/**
 * Phase 4 — Builtin deterministic gate evaluators (`quality-runtime`
 * foundation, §8.1). A practical, model-free evaluator set so a policy like
 * the Zhijian 智见点评 quality policy executes without every caller
 * reimplementing the checks:
 *
 * - `schema-structure`        — artifact non-empty + required section markers.
 * - `data-citation`           — numeric claims must carry a citation marker on
 *   their line; `null` must never be converted to `0` (null≠0 guard).
 * - `compliance-anonymization`— blocked identities, internal-only terms and
 *   deceased experts (allowed only in explicitly historical citations).
 * - `style-lint`              — AI-flavor phrase density (warning) and
 *   word-limit (error).
 *
 * Semantics:
 * - **Deterministic only.** `semantic` and `visual` gates are deliberately
 *   NOT provided here and never faked: a policy binding such a gate simply
 *   fails with `gate-evaluator-missing` until the caller injects a real
 *   evaluator (the runtime already makes that failure block delivery for
 *   hard gates).
 * - **Config-driven, conservatively.** Every evaluator reads
 *   `QualityGateSpec.config` first (`sections`/`requiredSections`,
 *   `citationMarkers`, `requireCitation`, `nullAsZero`, `blockedTerms`,
 *   `internalOnlyTerms`, `deceasedTerms`, `historicalMarkers`, `phrases`,
 *   `maxPhraseCount`, `maxWords`) and falls back to the options passed to
 *   {@link createBuiltinGateEvaluators}; nothing is guessed from
 *   free-form `checks`/`rules` prose.
 * - **Issues carry location/evidence/correction** so the targeted repair
 *   loop (§4.4) can act on them.
 *
 * Pure module: no I/O, no model calls; results are deterministic for a fixed
 * artifact and fixed clock.
 * @module dsh-expert-library/v2/builtin-gates
 */

import type { GateIssue, GateResult } from './types.ts'
import type { GateEvaluator, GateEvaluatorMap, GateInput, GateEvaluationContext } from './quality.ts'

/** Canonical deterministic gate ids covered by the builtin map (Zhijian policy ids). */
export const BUILTIN_DETERMINISTIC_GATE_IDS: readonly string[] = [
  'schema-structure',
  'data-citation',
  'compliance-anonymization',
  'style-lint',
]

/** Identity/export terms the compliance gate can check (options or config). */
export interface BuiltinComplianceTerms {
  /** Real/internal identities that must never appear in an external deliverable. */
  readonly blockedTerms?: readonly string[]
  /** Identifiers of internal-only experts/content that must not be exported. */
  readonly internalOnlyTerms?: readonly string[]
  /** Deceased expert identifiers; allowed only in explicitly historical citations. */
  readonly deceasedTerms?: readonly string[]
  /** Line markers that turn a deceased-term mention into an allowed historical citation. */
  readonly historicalMarkers?: readonly string[]
}

/** Options applied when a gate's own `config` does not specify the value. */
export interface BuiltinGateOptions {
  /** Default required section markers for the structure gate. */
  readonly sections?: readonly string[]
  /** Extra citation markers for the data-citation gate (defaults always apply). */
  readonly citationMarkers?: readonly string[]
  /** Default word limit for the style gate (`config.maxWords` wins). */
  readonly maxWords?: number
  /** Default AI-flavor phrase list for the style gate (`config.phrases` wins). */
  readonly phrases?: readonly string[]
  /** Default max total phrase occurrences before a density warning. */
  readonly maxPhraseCount?: number
  /** Compliance term lists used when the gate config does not supply them. */
  readonly compliance?: BuiltinComplianceTerms
}

const DEFAULT_CITATION_MARKERS: readonly string[] = [
  '来源', '口径', '数据来源', '根据', '统计局', '克而瑞', '中指', '贝壳',
  'wind', 'zyt', 'http://', 'https://', 'www.', '引自', '引用', '参见',
  'ref:', 'source:',
]

const DEFAULT_PHRASES: readonly string[] = [
  '值得注意的是', '综上所述', '总而言之', '总的来说', '综上',
  '值得一提的是', '需要指出的是', '不可否认', '毫无疑问', '众所周知', '毋庸置疑',
]

const DEFAULT_HISTORICAL_MARKERS: readonly string[] = ['历史', '已故', '曾', '生前']

/** `null` converted to `0` (the forbidden "null 禁转 0" pattern). */
const NULL_AS_ZERO_RE = /null\s*(?:=|=为|记|转|当|看作|视为|->|→)\s*0\b/i

/** A numeric claim: digits with optional decimal and unit suffix. */
const NUMBER_RE = /\d+(?:\.\d+)?(?:%|‰|万|亿)?/

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function stringList(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
    return value as string[]
  }
  return undefined
}

function numberOption(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Deterministic status from issue severities: error ⇒ fail, warning ⇒ warn. */
function toResult(gateId: string, issues: readonly GateIssue[], now: () => string): GateResult {
  const hasError = issues.some(issue => issue.severity === 'error')
  return {
    gateId,
    status: hasError ? 'fail' : issues.length > 0 ? 'warn' : 'pass',
    issues,
    evaluatedAt: now(),
  }
}

function excerpt(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed
}

/** CJK-aware word count: each CJK char counts as one word, latin tokens as one. */
function countWords(text: string): number {
  const cjk = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g)?.length ?? 0
  const latinTokens = text
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ')
    .match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g)?.length ?? 0
  return cjk + latinTokens
}

/**
 * Numeric claims on one line, excluding date-like tokens ("2026-07",
 * "2026年7月"), ranges ("3-5") and list numbering ("1. 结论").
 */
function numericClaims(line: string): string[] {
  const claims: string[] = []
  const re = new RegExp(NUMBER_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(line)) !== null) {
    const raw = match[0]
    const index = match.index
    const prev = line[index - 1]
    const next = line[index + raw.length]
    // Date-like / range tokens: adjacent digit or date separator on either side.
    if (prev !== undefined && /[\d\-/年.]/.test(prev)) continue
    if (next !== undefined && /[\d\-/年月日]/.test(next)) continue
    // List numbering at line start ("1. 结论", "2、…").
    if (/^\s*\d+[.、)）]\s/.test(line) && /^\s*$/.test(line.slice(0, index))) continue
    claims.push(raw)
  }
  return claims
}

/* ------------------------------------------------------------------ */
/* Evaluators                                                          */
/* ------------------------------------------------------------------ */

function evaluateStructure(input: GateInput, ctx: GateEvaluationContext, options: BuiltinGateOptions): GateResult {
  const config = ctx.spec.config ?? {}
  const issues: GateIssue[] = []
  if (input.artifact.trim() === '') {
    issues.push({
      code: 'empty-artifact',
      severity: 'error',
      evidence: '交付物为空（无任何内容）',
      correction: '生成正文后再交付，不要提交空文档',
    })
    return toResult(ctx.spec.id, issues, ctx.now)
  }
  // Contract-driven validation: when the caller binds an output-template
  // contract (the plan's declared output schema), the artifact must satisfy
  // it — JSON templates must parse as JSON, and every `required` section
  // marker must appear (markdown section headings / JSON keys / markers).
  // This closes the "declared but not enforced" gap: the gate validates the
  // submitted output against the plan's bound OutputTemplate, not just
  // free-form gate config.
  if (input.outputTemplate !== undefined) {
    if (input.outputTemplate.media.includes('json')) {
      try {
        JSON.parse(input.artifact)
      } catch (error: unknown) {
        issues.push({
          code: 'invalid-json',
          severity: 'error',
          location: '全文',
          evidence: `输出不是合法 JSON（${String(error)}）`,
          correction: '输出必须是可解析的 JSON 文档，按模板声明的字段结构组织',
        })
      }
    }
    for (const section of input.outputTemplate.sections) {
      if (section.required && !input.artifact.includes(section.id)) {
        issues.push({
          code: 'missing-section',
          severity: 'error',
          location: section.id,
          evidence: `未找到必填章节标记 "${section.id}"`,
          correction: `补充必填章节 "${section.id}"`,
        })
      }
    }
    return toResult(ctx.spec.id, issues, ctx.now)
  }
  const sections = stringList(config.sections)
    ?? stringList(config.requiredSections)
    ?? options.sections
    ?? []
  for (const marker of sections) {
    if (!input.artifact.includes(marker)) {
      issues.push({
        code: 'missing-section',
        severity: 'error',
        location: marker,
        evidence: `未找到必填章节标记 "${marker}"`,
        correction: `补充必填章节 "${marker}"`,
      })
    }
  }
  return toResult(ctx.spec.id, issues, ctx.now)
}

function evaluateDataCitation(input: GateInput, ctx: GateEvaluationContext, options: BuiltinGateOptions): GateResult {
  const config = ctx.spec.config ?? {}
  // Defaults are on unless explicitly disabled (false) in the gate config.
  const requireCitation = config.requireCitation !== false
  const nullAsZero = config.nullAsZero !== false
  const markers = [
    ...(stringList(config.citationMarkers) ?? []),
    ...(options.citationMarkers ?? []),
    ...DEFAULT_CITATION_MARKERS,
  ]
  const lower = (value: string): string => value.toLowerCase()
  const issues: GateIssue[] = []
  const lines = input.artifact.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const location = `line ${index + 1}`
    const evidence = excerpt(line)
    if (nullAsZero && NULL_AS_ZERO_RE.test(line)) {
      issues.push({
        code: 'null-as-zero',
        severity: 'error',
        location,
        evidence,
        correction: '缺失值保持缺失（null 禁转 0），不得当作 0 参与计算或展示',
      })
    }
    if (requireCitation) {
      const claims = numericClaims(line)
      if (claims.length > 0 && !markers.some(marker => lower(line).includes(lower(marker)))) {
        issues.push({
          code: 'number-without-source',
          severity: 'error',
          location,
          evidence: `${evidence}（数字：${claims.join('、')}）`,
          correction: '为数字补来源/时段/区域/单位/口径（或明确标注为估算值）',
        })
      }
    }
  }
  return toResult(ctx.spec.id, issues, ctx.now)
}

function evaluateCompliance(input: GateInput, ctx: GateEvaluationContext, options: BuiltinGateOptions): GateResult {
  const config = ctx.spec.config ?? {}
  const blocked = stringList(config.blockedTerms) ?? options.compliance?.blockedTerms ?? []
  const internalOnly = stringList(config.internalOnlyTerms) ?? options.compliance?.internalOnlyTerms ?? []
  const deceased = stringList(config.deceasedTerms) ?? options.compliance?.deceasedTerms ?? []
  const historical = stringList(config.historicalMarkers)
    ?? options.compliance?.historicalMarkers
    ?? DEFAULT_HISTORICAL_MARKERS
  const issues: GateIssue[] = []
  const lines = input.artifact.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? ''
    const line = raw.toLowerCase()
    const location = `line ${index + 1}`
    const evidence = excerpt(raw)
    for (const term of blocked) {
      if (line.includes(term.toLowerCase())) {
        issues.push({
          code: 'blocked-identity',
          severity: 'error',
          location,
          evidence,
          correction: '实名字段仅内部视图；对外只列「领域·首字母」',
        })
      }
    }
    for (const term of internalOnly) {
      if (line.includes(term.toLowerCase())) {
        issues.push({
          code: 'internal-only-exposed',
          severity: 'error',
          location,
          evidence,
          correction: 'internalOnly 专家/内容不得出现在对外交付物中',
        })
      }
    }
    for (const term of deceased) {
      if (line.includes(term.toLowerCase()) && !historical.some(marker => line.includes(marker.toLowerCase()))) {
        issues.push({
          code: 'deceased-cited-as-current',
          severity: 'error',
          location,
          evidence,
          correction: '已故专家仅可引用历史观点（在句中标注「历史观点/曾」）',
        })
      }
    }
  }
  return toResult(ctx.spec.id, issues, ctx.now)
}

function evaluateStyle(input: GateInput, ctx: GateEvaluationContext, options: BuiltinGateOptions): GateResult {
  const config = ctx.spec.config ?? {}
  const phrases = stringList(config.phrases) ?? options.phrases ?? DEFAULT_PHRASES
  const maxPhraseCount = numberOption(config.maxPhraseCount, options.maxPhraseCount ?? 5)
  const maxWords = numberOption(config.maxWords, options.maxWords ?? 2000)
  const issues: GateIssue[] = []
  const text = input.artifact
  let occurrences = 0
  for (const phrase of phrases) {
    occurrences += text.split(phrase).length - 1
  }
  if (occurrences > maxPhraseCount) {
    issues.push({
      code: 'phrase-density',
      severity: 'warning',
      location: '全文',
      evidence: `${occurrences} 处模板套话/课堂式过渡句（上限 ${maxPhraseCount}）`,
      correction: '削减套话，让每段落到事实、判断或行动含义',
    })
  }
  const words = countWords(text)
  if (words > maxWords) {
    issues.push({
      code: 'word-limit-exceeded',
      severity: 'error',
      location: '全文',
      evidence: `${words} 字超过上限 ${maxWords} 字`,
      correction: `压缩至 ${maxWords} 字以内`,
    })
  }
  return toResult(ctx.spec.id, issues, ctx.now)
}

/**
 * Build the deterministic evaluator map (canonical Zhijian policy ids plus
 * short aliases). Semantic/visual gates are intentionally absent — injecting
 * them stays the caller's job and nothing here fakes a model verdict.
 */
export function createBuiltinGateEvaluators(options: BuiltinGateOptions = {}): GateEvaluatorMap {
  const structure: GateEvaluator = (input, ctx) => evaluateStructure(input, ctx, options)
  const dataCitation: GateEvaluator = (input, ctx) => evaluateDataCitation(input, ctx, options)
  const compliance: GateEvaluator = (input, ctx) => evaluateCompliance(input, ctx, options)
  const style: GateEvaluator = (input, ctx) => evaluateStyle(input, ctx, options)
  return {
    'schema-structure': structure,
    structure,
    'data-citation': dataCitation,
    data: dataCitation,
    'compliance-anonymization': compliance,
    compliance,
    'style-lint': style,
    style,
  }
}
