/** One-time recovery of a ready notice stranded in nextStep after boot turn/end. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export const name = 'zhongtiexicheng-v163-member-wake'
export const inject = ['agents', 'agentPresets', 'tools']

const workspace = '/root/.openclaw/workspace/98wiki'
const teamPath = `${workspace}/expert-teams/租金定价-北京门头沟中铁西城/team.json`
const receiptPath = `${workspace}/expert-teams/.zhongtiexicheng-v163-member-wake.json`
const captainSessionId = 'session-a6b81f59-f419-4162-906e-8075f164bf77'

export function apply(ctx) {
  let stopped = false
  const timer = setTimeout(async () => {
    if (stopped || existsSync(receiptPath)) return
    const record = { at: new Date().toISOString(), team: '租金定价-北京门头沟中铁西城' }
    try {
      const team = JSON.parse(readFileSync(teamPath, 'utf8'))
      const t1 = team.tasks.find(task => task.id === 't1')
      if (t1?.status !== 'pending' || t1?.attempt !== 0) {
        record.state = 'already-started'
      } else {
        const captain = ctx.agents.get(captainSessionId) ?? (await ctx.agents.resume({
          resumeSessionId: captainSessionId,
          agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
          setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'zhijian') },
        })).agent
        const result = await ctx.tools.execute({
          callId: `member-wake-${randomUUID()}`,
          name: 'expert_teams_send_message',
          arguments: {
            to: '制度君',
            idempotency_key: 'zhongtiexicheng-v163-t1-wake-20261009',
            content: '计划已由用户确认。请读取当前团队状态，若 t1 仍 pending，则按正式工具认领并完成标的核验；复用本会话已保存的原始回执，不虚构房号、面积或出租条件。若任务状态已变化，以最新状态为准。',
          },
          agent: captain,
          signal: new AbortController().signal,
        })
        if (result.isError) throw Error('expert_teams_send_message rejected')
        record.state = 'queued-by-native-tool'
      }
    } catch (error) {
      record.state = 'failed'
      record.error = String(error)
    }
    writeFileSync(receiptPath, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' })
  }, 12000)
  ctx.effect(() => () => { stopped = true; clearTimeout(timer) })
}
