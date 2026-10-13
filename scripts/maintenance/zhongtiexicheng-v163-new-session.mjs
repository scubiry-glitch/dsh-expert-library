/** One-time online 1.6.3 rent pricing trial requested by the user. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createUserMessage } from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'

export const name = 'zhongtiexicheng-v163-new-session'
export const inject = ['agents', 'agentPresets']

const sessionId = 'session-a6b81f59-f419-4162-906e-8075f164bf77'
const workspace = '/root/.openclaw/workspace/98wiki'
const receipt = `${workspace}/expert-teams/.zhongtiexicheng-v163-new-session.json`
const recoveryReceipt = `${workspace}/expert-teams/.zhongtiexicheng-v163-new-session-recovery.json`
const repairReceipt = `${workspace}/expert-teams/.zhongtiexicheng-v163-new-session-report-repair.json`
const inventory = '/root/zhijian/zhijianharness-main/pack-center/inventory/state.json'
const releaseId = '5a892f4d-bbd9-4e0b-be75-5cca4b7d7b7e'
const instruction = `用户要求用线上已激活的 zhijian-realestate 1.6.3 新建会话，试跑“北京门头沟中铁西城小区租金定价评估”，观察是否能复现海兴雅苑报告的证据与表达质量。这是新会话、新取证；不得续写旧的中铁西城任务，不得沿用旧价格。请先核对当前运行时版本和 zhijian-rent-pricing 场景、skill、任务图和输出模板确实可用，再用正式 Host 工具归型、路由、建立独立团队并推进。用户只给了小区，未给楼栋、房号、面积、户型、装修和出租方式：先核验小区身份与数据可得性，把这些作为待确认项；可以形成有明示适用范围的分户型/面积样本区间，但不得虚构具体标的或把区间当成一套房的最终挂牌价。真实查询优先使用可用的贝壳、政研通等接口，保存原始回执、采样时间、TopK边界、去重和缺口；挂牌与成交分开。按照 1.6.3 包内租金定价任务图推进同质样本、独立交叉证据、可复算定价、独立审计、冻结正文和最终图文输出；图表表达结论与证据关系，不做装饰图。保留需要真实用户确认的门控，不代用户或独立评审确认。若缺少标的细节导致无法形成最终定价，明确列出最少补充字段，并给出当前可审查的进度、证据和访问入口。记录试跑是否确实命中新场景、团队任务并行情况、完成物及阻塞。`

export function apply(ctx) {
  let stopped = false
  const timer = setTimeout(async () => {
    if (stopped || existsSync(repairReceipt)) return
    const result = { at: new Date().toISOString(), sessionId, releaseId }
    const existing = existsSync(receipt)
    const repair = existsSync(recoveryReceipt)
    try {
      const state = JSON.parse(readFileSync(inventory, 'utf8'))
      if (state.active?.['zhijian-realestate'] !== releaseId) throw Error('ACTIVE_RELEASE_CHANGED')
      const options = {
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
        setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'zhijian') },
      }
      const captain = (existing
        ? await ctx.agents.resume({ resumeSessionId: sessionId, ...options })
        : await ctx.agents.create({ sessionId, meta: { cwd: workspace, agentPreset: 'zhijian' }, ...options })).agent
      if (stopped) return
      captain.followup(createUserMessage({
        source: { kind: 'plugin', plugin: name },
        content: [{ type: 'text', text: repair
          ? 'Host 已修复 DomainPack V2 场景的报告产物绑定，现支持在 zhijian-rent-pricing 的最终 t8 任务附带显式 report_bundle 并冻结所选技能。刚才暂存的无报告校验计划 plan-45113208ac1226587f80c52d3dd297a2 请先用正式 plan_discard 废弃；然后复用本会话原始证据、此前的 report_bundle 与 report_outline，重新预览和暂存带报告校验的同一新场景计划。保持真实用户确认门控，不代用户批准。'
          : existing
            ? 'Host 已补齐 active DomainPack V2 场景接线：expert_teams_plan_preview 和 expert_teams_plan_stage 现接受 scenario="zhijian-rent-pricing" 及 scenario_params={property:"北京门头沟中铁西城小区；面积、户型、装修、整租方式待确认",asOfDate:"2026-10-09"}。请从本会话继续，复用刚取得的本次贝壳原始回执，不重做无必要查询；用正式场景重新预览、暂存计划，保持真实用户确认门控。不要改写 Host 或领域包源码。'
            : instruction }],
      }))
      result.state = 'queued'
    } catch (error) {
      result.state = 'failed'
      result.error = String(error)
    }
    writeFileSync(repair ? repairReceipt : existing ? recoveryReceipt : receipt, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' })
  }, 12000)
  ctx.effect(() => () => { stopped = true; clearTimeout(timer) })
}
