/** One-time native recovery after Host restart interrupted the original member turn. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export const name = 'zhongtiexicheng-v163-member-recover'
export const inject = ['agents', 'agentPresets', 'tools']

const workspace = '/root/.openclaw/workspace/98wiki'
const teamPath = `${workspace}/expert-teams/租金定价-北京门头沟中铁西城/team.json`
const receiptPath = `${workspace}/expert-teams/.zhongtiexicheng-v163-member-recover.json`
const captainSessionId = 'session-a6b81f59-f419-4162-906e-8075f164bf77'

export function apply(ctx) {
  let stopped = false
  const timer = setTimeout(async () => {
    if (stopped || existsSync(receiptPath)) return
    const record = { at: new Date().toISOString(), team: '租金定价-北京门头沟中铁西城' }
    try {
      const team = JSON.parse(readFileSync(teamPath, 'utf8'))
      const member = team.members.find(item => item.name === '制度君')
      const block = member?.runtimeBlock
      if (block?.code !== 'HOST_RESTART_UNCONFIRMED') {
        record.state = block ? 'different-block-preserved' : 'no-block'
      } else {
        const captain = ctx.agents.get(captainSessionId) ?? (await ctx.agents.resume({
          resumeSessionId: captainSessionId,
          agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
          setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'zhijian') },
        })).agent
        const result = await ctx.tools.execute({
          callId: `member-recover-${randomUUID()}`,
          name: 'expert_teams_resume_member',
          arguments: {
            member: '制度君',
            expected_block_id: block.id,
            reason: '已检查原会话：t1 尚未认领，上一回合在 Host 重启时中断；邮箱投递去重与空闲回合唤醒修复已构建并通过回归，续接原成员，不新建 attempt。',
          },
          agent: captain,
          signal: new AbortController().signal,
        })
        if (result.isError) throw Error('expert_teams_resume_member rejected')
        record.state = 'resumed-by-native-tool'
      }
    } catch (error) {
      record.state = 'failed'
      record.error = String(error)
    }
    writeFileSync(receiptPath, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' })
  }, 12000)
  ctx.effect(() => () => { stopped = true; clearTimeout(timer) })
}
