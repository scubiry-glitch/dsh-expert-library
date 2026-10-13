/** One-time online 1.6.2 trial requested by the user. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createUserMessage } from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'

export const name = 'guizhou-v162-new-session'
export const inject = ['agents', 'agentPresets']

const sessionId = 'session-ac6db9a6-96ea-4018-8994-c68923bf30ca'
const receipt = '/root/.openclaw/workspace/98wiki/expert-teams/.guizhou-v162-new-session.json'
const recoveryReceipt = '/root/.openclaw/workspace/98wiki/expert-teams/.guizhou-v162-new-session-recovery.json'
const inventory = '/root/zhijian/zhijianharness-main/pack-center/inventory/state.json'
const releaseId = '729a2239-6c18-4fe1-ad9e-24a1da3e338c'
const workspace = '/root/.openclaw/workspace/98wiki'
const instruction = `用户要求启用 1.6.2 并新建会话试跑，命题是“贵州的旅居市场分析”。这是全新研究，不续写既有贵州团队。请先核验当前激活的 zhijian-realestate 领域包为 1.6.2，使用已部署的 V5 观点驱动流程。以贵州旅居市场为核心，按材料选择贵阳及有证据的旅居目的地；先做数据可得性与口径预检，区分短租、月租、长住旅居与普通长租，记录来源、时间、单位、缺口。观点应由本次证据生成，包含反证，不套固定结构。每个报告页面至少一张真正传达本页逻辑与观点的图，写作和渲染都实际参考已有两份高质量报告的内容组织、图形表达和任务图做法，不只引用链接；避免假数据或装饰图。请通过正式 Host 工具创建团队与计划、推进研究；遇到计划、观点或正文需要真实用户确认的门控，停在待确认状态并给出可访问审核链接，不代用户确认或代独立评审。请在团队任务中记录 1.6.2 调度表现：研究阶段是否能并发至 4、普通和评审阶段是否仍按 2，统计排队与协议/质量返工，并报告首次试跑的客观进展和问题。`

export function apply(ctx) {
  let stopped = false
  const timer = setTimeout(async () => {
    if (stopped || existsSync(recoveryReceipt)) return
    const result = { at: new Date().toISOString(), sessionId, releaseId }
    try {
      const state = JSON.parse(readFileSync(inventory, 'utf8'))
      if (state.active?.['zhijian-realestate'] !== releaseId) throw Error('ACTIVE_RELEASE_CHANGED')
      const existing = ctx.agents.get(sessionId)
      const options = {
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
        setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'zhijian') },
      }
      const captain = existing ?? (existsSync(receipt)
        ? (await ctx.agents.resume({ resumeSessionId: sessionId, ...options })).agent
        : (await ctx.agents.create({ sessionId, meta: { cwd: workspace, agentPreset: 'zhijian' }, ...options })).agent)
      if (stopped) return
      captain.followup(createUserMessage({
        source: { kind: 'plugin', plugin: name },
        content: [{ type: 'text', text: existsSync(receipt)
          ? '上轮因启动入口配置热加载被中断，原会话和已完成的预检仍在。请从原会话继续，复用已验证的数据口径与文档观察，按用户原指令创建新的贵州旅居市场 V5 计划和团队，保留真实确认门控，不重做无必要的查询。'
          : instruction }],
      }))
      result.state = 'queued'
    } catch (error) {
      result.state = 'failed'
      result.error = String(error)
    }
    writeFileSync(existsSync(receipt) ? recoveryReceipt : receipt, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' })
  }, 12000)
  ctx.effect(() => () => { stopped = true; clearTimeout(timer) })
}
