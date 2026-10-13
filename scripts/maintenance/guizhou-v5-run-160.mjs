/** One-time, authorized continuation of the existing Guizhou online captain. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createUserMessage } from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'

export const name = 'guizhou-v5-run-160'
export const inject = ['agents', 'agentPresets']
const id = 'session-f44ffc89-3bdf-4f8c-a0f3-107c91dc52f3'
const receipt = '/root/.openclaw/workspace/98wiki/expert-teams/.guizhou-v5-run-160.json'
const inventory = '/root/zhijian/zhijianharness-main/pack-center/inventory/state.json'
const releaseId = '98e09ba4-1868-4959-81d7-e0bee8ac67e9'
const framework = '/root/.openclaw/workspace/98wiki/projects/贵州租金与旅居市场分析/20261008_贵州租金公寓租金与旅居市场_V5研究启动框架.md'
const instruction = `用户已要求在领域包 1.6.0 上重新跑贵州租金、公寓租金与旅居市场分析。请继续本线上会话，先核验当前运行时中心快照确为 zhijian-realestate 1.6.0 且能解析 zhijian-research-craft-v5；此前 SKILL_CRAFT_SKILL_NOT_FOUND 已因中心版本更新解除。读取已有研究启动框架 ${framework}，将其当作待检验的输入，不把假设当结论。前一轮的“只出框架”限制已被用户本次“再跑一下”替代；按 V5 的观点驱动研究流程创建计划并推进。地域以贵阳和可取证的 2–3 个旅居目的地为实测核心，其余省域仅作背景；普通租赁、长租公寓、短租、旅居长住严格分口径。先查数据可得性，来源、时间、单位和缺口都要留下回执；Wind 若仍积分不足则用公开官方源，不虚构数据。观点从本次材料中筛选并给反证，写作时每章安排有证据的点睛图，参考两份设计文档在渲染中真实应用。启动 V5 计划的正式 Host 流程；遇到必须由 authenticated-host-user 完成的计划/观点/正文门控，就停在真实待确认状态并明确给出可访问的审核链接，不能伪造用户身份或独立评审。用户此前希望尽量少手动点选，但不能绕过 Host 门控。若有运行阻塞，记下准确错误与最小恢复动作。`

export function apply(ctx) {
  let stopped = false
  const timer = setTimeout(async () => {
    if (stopped || existsSync(receipt)) return
    try {
      const state = JSON.parse(readFileSync(inventory, 'utf8'))
      if (state.active?.['zhijian-realestate'] !== releaseId) throw Error('ACTIVE_RELEASE_CHANGED')
      if (!existsSync(framework)) throw Error('FRAMEWORK_MISSING')
      const captain = ctx.agents.get(id) ?? (await ctx.agents.resume({
        resumeSessionId: id,
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
        setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'zhijian') },
      })).agent
      if (stopped) return
      captain.followup(createUserMessage({ source: { kind: 'plugin', plugin: name }, content: [{ type: 'text', text: instruction }] }))
      writeFileSync(receipt, JSON.stringify({ at: new Date().toISOString(), sessionId: id, releaseId, state: 'queued' }, null, 2), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if (!existsSync(receipt)) writeFileSync(receipt, JSON.stringify({ at: new Date().toISOString(), sessionId: id, releaseId, state: 'failed', error: String(error) }, null, 2), { mode: 0o600, flag: 'wx' })
    }
  }, 8000)
  ctx.effect(() => () => { stopped = true; clearTimeout(timer) })
}
