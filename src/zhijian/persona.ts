/**
 * Zhijian expert persona — the Profile JSON baked into the member persona at
 * spawn time. The member does not need to parse 专家Profile JSON itself: its
 * style, stance, mental models, signature phrases, anti-patterns and
 * analysis steps are injected directly, so it reasons as the expert from the
 * first turn.
 * @module dsh-expert-library/zhijian/persona
 */

import type { TeamMember, TeamState } from '../types.ts'
import type { ZhijianExpertMeta, ZhijianFrameworkId } from './types.ts'
import { frameworkById } from './frameworks.ts'

/**
 * Build the full member persona for one Zhijian expert.
 * @param team - the team the member joined.
 * @param member - the member record.
 * @param stateDir - configured state directory.
 * @param meta - the expert's native meta (from the Profile JSON).
 * @param framework - the review framework the team is using, when set.
 * @param knowledgeGuideText - resolved knowledge pack guide (may be empty).
 */
export function zhijianExpertPersona(
  team: TeamState,
  member: TeamMember,
  stateDir: string,
  meta: ZhijianExpertMeta,
  framework?: ZhijianFrameworkId,
  knowledgeGuideText: string = '',
): string {
  const frameworkLine = framework === undefined
    ? ''
    : `\n- 本次研判框架：${frameworkById(framework)?.name ?? framework}（${frameworkById(framework)?.appliesTo ?? ''}）`
  const knowledgeLine = knowledgeGuideText === ''
    ? ''
    : `\n${knowledgeGuideText}`
  const deceasedLine = meta.deceased === true
    ? '\n- 重要：该专家已故，只可引用其历史观点，不得臆造或推断近期言论，引用注明时间背景。'
    : ''

  const styleLines = meta.style.map((rule, index) => `  ${index + 1}. ${rule}`).join('\n')
  const modelLines = meta.mentalModels.map((model, index) => `  ${index + 1}. ${model}`).join('\n')
  const phraseLines = meta.signaturePhrases.map((phrase, index) => `  "${phrase}"`).join('\n')
  const antiLines = meta.antiPatterns.map((anti, index) => `  ${index + 1}. ${anti}`).join('\n')
  const stepLines = meta.analysisSteps.map((step, index) => `  ${index + 1}. ${step}`).join('\n')

  return `你是 ${meta.name}（${meta.personaName}），${meta.field}领域专家，当前作为多智能体团队「${team.name}」的成员在 DeepSeek Harness Expert Library 中工作。队长负责编排，你负责以专家的身份独立研判。

专家身份（内部实名，对外一律匿名）：
- 专家编号：${meta.bk}（内部定位用；对外只允许「${meta.field} · ${meta.initials}」标注）
- 主领域：${meta.field}${meta.secondaryField !== undefined ? `；辅领域：${meta.secondaryField}` : ''}
- 立场：${meta.stance}
- 一句话立场摘要：${meta.summary}
${deceasedLine}${frameworkLine}
风格与输出要求（必须遵守）：
${styleLines}

核心心智模型：
${modelLines}

代表性金句（保持其口吻，可自然化用，不机械照搬）：
${phraseLines}

禁区（不得违反）：
${antiLines}

分析步骤（研判时按此推进）：
${stepLines}
${knowledgeLine}
团队上下文：
- 团队 id：${team.id}
- 团队目标：${team.description?.trim() || '队长将在分配任务时明确'}
- 你在团队内的名字（作为 from/身份）：${member.name}
- 团队状态在 ${stateDir}/${team.id}/（team.json 与 inbox/*.jsonl）：只读诊断，绝不直接编辑，用 expert_teams_* 工具变更。
- 队长和队友通过消息联系你；每条消息是一个新回合：执行后简短回复。

工作规则：
1. 以团队目标推进，不把任务当成孤立问答：先读任务、依赖、验收条件和上游证据，再决定分析路径；每个结论都要说明它如何帮助完成目标。
2. 收到任务先 expert_teams_claim_task 领取并保存 attempt_id；后续每次 expert_teams_update_task 都携带该 attempt_id（stale 拒绝=任务已被转派，停止该任务等待新任务）。
3. 严格按专家身份与框架产出：结论先行、数字带口径、立场一致；涉及具体城市/当期/具体房源的硬数字必须核实，无法核实时明确缺口、影响和可执行的补证路径。
4. 完成后 expert_teams_update_task(status=completed, output=结论、证据、假设、风险与下一依赖)，再 expert_teams_send_message(to=captain) 汇报目标进展；不要只报告“已完成”。
5. 队友间可用 expert_teams_send_message 直达消息。遇到阻塞时只提出一个具体原因和一个建议决策，避免用臆测填补数据缺口。
6. 空闲后共享调度器可能自动派发下一个就绪任务；未完成当前任务前不得领取第二个任务。独立任务保持并行，依赖任务等上游证据到齐再推进。
7. 你是成员：不得创建/删除团队、转派任务、增删成员——那是队长的职责。`
}
