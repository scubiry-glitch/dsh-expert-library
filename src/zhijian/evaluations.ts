/**
 * P2.2 专家反馈评分回写（对齐 pipeline `POST /feedback`、`/rate`）。
 *
 * 存储：`<workspace>/<knowledgeDir>/experts/<expertId>/evaluations.jsonl`
 * （每行一条 EvaluationRecord，追加写、容忍坏行——绝不因反馈损坏专家库）。
 *
 * 反馈不直接烘焙进 persona（避免风格漂移）：spawn 时只注入「既往反馈摘要」
 * （条数/均分/最近备注），供成员在风格与口径上自我校准；支持一键清空
 * （删文件即重置，知识包目录惰性语义不变）。
 *
 * 纯文件层：无模型调用；路径安全由 knowledge id 校验保证（isSafeKnowledgeId）。
 * @module dsh-expert-library/zhijian/evaluations
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isSafeKnowledgeId } from '../knowledge.ts'

/** 一条专家反馈记录（与 pipeline Expert 对象的「评价记录」对齐）。 */
export interface EvaluationRecord {
  /** ISO 时间戳。 */
  readonly at: string
  /** 来源任务 id（可选）。 */
  readonly taskId?: string
  /** 0-100 总分。 */
  readonly score: number
  /** 三维度分项（可选）。 */
  readonly dimensions?: {
    readonly 采纳率?: number
    readonly 相关性?: number
    readonly 口径合规?: number
  }
  /** 备注。 */
  readonly note?: string
}

/** 反馈文件相对 knowledge 目录的路径。 */
export function evaluationsRelPath(expertId: string): string {
  return join('experts', expertId, 'evaluations.jsonl')
}

/** 反馈文件绝对路径；expertId 不安全时返回 undefined。 */
export function evaluationsFile(workspace: string, knowledgeDir: string, expertId: string): string | undefined {
  if (!isSafeKnowledgeId(expertId)) return undefined
  return join(workspace, knowledgeDir, evaluationsRelPath(expertId))
}

/** 读取全部反馈记录（容忍坏行：解析失败的行跳过并继续）。 */
export async function readEvaluations(file: string | undefined): Promise<EvaluationRecord[]> {
  if (file === undefined) return []
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return [] // 无反馈文件 ⇒ 无记录
  }
  const records: EvaluationRecord[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value = JSON.parse(line)
      if (typeof value === 'object' && value !== null && typeof value.score === 'number') {
        records.push(value as EvaluationRecord)
      }
    } catch {
      // 坏行跳过——反馈数据永不阻断专家可用性
    }
  }
  return records
}

/** 追加一条反馈记录（原子：mkdir + append）。 */
export async function appendEvaluation(
  file: string | undefined,
  record: EvaluationRecord,
): Promise<void> {
  if (file === undefined) throw new Error('expert id 不安全，拒绝写入反馈文件')
  await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true })
  await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
}

/** 反馈摘要（一条人类可读行；无记录时返回 undefined）。 */
export function feedbackSummary(records: readonly EvaluationRecord[]): string | undefined {
  if (records.length === 0) return undefined
  const avg = Math.round(records.reduce((sum, record) => sum + record.score, 0) / records.length)
  const latest = records[records.length - 1]
  const parts = [`既往反馈 ${records.length} 条，均分 ${avg}/100`]
  if (latest !== undefined) {
    const latestNote = latest.note === undefined ? '' : `；最近备注：${latest.note}`
    parts.push(`最近一次 ${latest.score}/100${latestNote}`)
  }
  return parts.join('；')
}

/**
 * persona 注入用的反馈指引段（无记录时返回空串，不产生噪音）。
 * 由 team-core 在组装成员 persona 指引时调用（与 expertMemoryGuideSection 同路径）。
 */
export async function feedbackGuideSection(
  workspace: string,
  knowledgeDir: string,
  expertId: string,
): Promise<string> {
  const file = evaluationsFile(workspace, knowledgeDir, expertId)
  const records = await readEvaluations(file)
  const summary = feedbackSummary(records)
  return summary === undefined
    ? ''
    : `既往反馈（可据此校准风格与口径，不覆盖人设）：${summary}`
}
