/** Owner-authorized, identity-bound recovery for the interrupted 98wiki t7.
 * No HTTP route, credential changes, history rewrite, or quality acceptance.
 * Remove the profile entry after this task is closed.
 */
import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { installContinuableMemberSetup } from '../../lib/harness-compat.js';
import { createUserMessage } from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';

export const name = 't7-catalog-recovery';
export const inject = ['agents', 'agentPresets', 'tools', 'subagents'];
const captainId = 'session-bdf4fe75-fc8d-4cde-90d7-78f7d84ffd0f';
const memberId = 'aa995166-37ad-4ea2-bcbe-52f16b608804';
const attemptId = 'f9d5668d-f528-4d2c-98af-1113e555535d';
const teamDir = '/root/.openclaw/workspace/98wiki/expert-teams/98wiki-上海与一线租赁市场见底研判-v3-1-材料绑定修正版';
const auditPath = `${teamDir}/catalog-runtime-recovery.jsonl`;
const oncePath = `${teamDir}/catalog-runtime-resume.json`;
const guidePath = `${teamDir}/catalog-runtime-guidance.json`;
const amendmentPath = `${teamDir}/capability-amendment-20261006T101611Z.json`;
const audit = (stage, data = {}) => appendFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), stage, ...data }) + '\n', { mode: 0o600 });
function state() {
  const team = JSON.parse(readFileSync(`${teamDir}/team.json`, 'utf8'));
  const task = team.tasks.find(t => t.id === 't7');
  const member = team.members.find(m => m.id === memberId);
  if (team.captainSessionId !== captainId || task?.planTask?.logicalId !== 'data_preflight' || task.assignee !== member?.name)
    throw new Error('Recovery identity/attempt mismatch');
  if (!member.capabilityScope?.allowedTools?.includes('expert_provider_call')
    || JSON.stringify(team.planTaskCapabilities?.data_preflight) !== '["realestate.indicators.catalog"]')
    throw new Error('Recovery requires the existing catalog-only user grant');
  if (!existsSync(amendmentPath)) throw new Error('Missing authorization amendment receipt');
  return { team, task, member };
}

export function apply(ctx) {
  let stopped = false;
  // A scoped registration is the Host-supported way to add an explicitly
  // authorized tool to a cold child. The original descriptor is left intact;
  // member guards and provider capability/provider/approval gates still apply.
  const stopSetup = installContinuableMemberSetup(ctx, childCtx => {
    if (childCtx.agent?.id !== memberId) return () => {};
    const { task } = state();
    if (task.status !== 'in_progress' && task.status !== 'claimed') return () => {};
    const parent = ctx.agents.get(captainId);
    if (!parent || childCtx.agent.session.header.parentSession !== parent.id) throw new Error('Recovery parent mismatch');
    if (ctx.tools.get('expert_provider_call', childCtx.agent)) return () => {};
    const definition = ctx.tools.get('expert_provider_call', parent);
    if (!definition) throw new Error('Captain provider tool is unavailable');
    const dispose = childCtx.tools.register(definition);
    audit('authorized-tool-mounted', { memberId, attemptId: task.attemptId, tool: definition.name,
      amendmentSha256: createHash('sha256').update(readFileSync(amendmentPath)).digest('hex') });
    return dispose;
  });
  async function recover() {
    const { task } = state();
    if (!['claimed', 'in_progress'].includes(task.status)) return;
    const captain = ctx.agents.get(captainId) ?? (await ctx.agents.resume({
      resumeSessionId: captainId,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'zhijian'); },
    })).agent;
    if (stopped) return;
    // The first resumed draft still repeated the pre-repair tool diagnosis.
    // The actual owner/captain must handle review waiting through quality
    // repair; do not reset task state or accept the draft in maintenance code.
    const guidance = '【用户授权的 t7 恢复纠正】本轮由用户要求修复 t7 卡住问题。旧轮次已恢复，当前 member 的模型请求 header 已真实暴露 expert_provider_call（seq 549 及其后），并有 catalog-runtime-recovery.jsonl 的 authorized-tool-mounted 记录。刚提交的 data-channel-status.md 仍沿用旧判断“本会话未暴露工具”，这一判断已经失效，不能据此验收。请现在检查原 t7 的质量状态，使用正常 quality_repair/reopen 等流程退回补证（不要手改 team.json、不要直接接受旧结论）。让原成员先实际调用 expert_provider_call(capability="realestate.indicators.catalog", input={}) 一次，保存真实回执并更正预检文档。当前只授权 catalog，不授权 timeseries/rent/policy；不得越权扩大取数。provenance.unit.missing 需标单位待确认，目录成功不等于四城时序成功。复用已有贝壳/Wind 回执，不重放同一失败。保持原任务和已有证据，只有正常质量流程要求时才换返修 attempt。不要另建团队，不要伪造调用结果。完成后按原验收规则推进。';
    if (!existsSync(guidePath)) {
      captain.followup(createUserMessage({ content: [{ type: 'text', text: guidance }], source: { kind: 'plugin', plugin: 't7-catalog-recovery' } }));
      writeFileSync(guidePath, JSON.stringify({ at: new Date().toISOString(), captainId, memberId, originalAttemptId: attemptId, guidance }, null, 2), { mode: 0o600 });
      audit('captain-correction-queued', { captainId, memberId });
    }
    if (ctx.agents.get(memberId) || state().task.executionState === 'awaiting_review') return;
    const fresh = state();
    const block = fresh.member.runtimeBlock;
    if (block && block.code !== 'HOST_RESTART_UNCONFIRMED') {
      audit('non-restart-block-left-for-review', { block });
      return;
    }
    const args = { task_id: 't7', reason: '用户授权修复：原轮次在 17:23 中断，已补充目录查询权限；保留同一 attempt 和全部已有探针回执，继续完成数据预检。',
      ...(block?.id ? { expected_block_id: block.id } : {}) };
    audit('resume-requested', { captainId, memberId, attemptId });
    const result = await ctx.tools.execute({ callId: `owner-recovery-${randomUUID()}`, name: 'expert_teams_resume_task', arguments: args,
      agent: captain, signal: new AbortController().signal });
    audit('resume-result', { result });
    if (result.isError) throw new Error('Resume tool rejected; inspect audit');
    writeFileSync(oncePath, JSON.stringify({ at: new Date().toISOString(), captainId, memberId, attemptId, result }, null, 2), { mode: 0o600 });
  }
  const timer = setTimeout(() => { recover().catch(error => audit('recovery-error', { message: String(error) })); }, 8000);
  ctx.effect(() => () => { stopped = true; clearTimeout(timer); stopSetup(); });
}
