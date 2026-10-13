/** One-time operational continuation; all permission restoration is now in core members.ts. */
import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { deliverToMember } from '../../lib/members.js';
import { createUserMessage } from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';

export const name = 'rent-research-recovery';
export const inject = ['agents', 'agentPresets', 'tools', 'subagents'];
const captainId = 'session-bdf4fe75-fc8d-4cde-90d7-78f7d84ffd0f';
const reviewerId = '06880d9a-2564-4f25-a5e3-ce4f9069b452';
const memberIds = ['aa995166-37ad-4ea2-bcbe-52f16b608804', reviewerId, 'cac86e5b-7103-496c-84d1-a586ca32979a'];
const teamDir = '/root/.openclaw/workspace/98wiki/expert-teams/98wiki-上海与一线租赁市场见底研判-v3-1-材料绑定修正版';
const amendmentPath = `${teamDir}/research-capability-amendment.json`;
const audit = (stage, detail = {}) => appendFileSync(`${teamDir}/research-runtime-recovery.jsonl`, JSON.stringify({ at: new Date().toISOString(), stage, ...detail }) + '\n', { mode: 0o600 });
function state() {
  const team = JSON.parse(readFileSync(`${teamDir}/team.json`, 'utf8'));
  const grant = JSON.parse(readFileSync(amendmentPath, 'utf8'));
  if (team.captainSessionId !== captainId || grant.captainId !== captainId) throw new Error('Recovery captain mismatch');
  for (const [logical, caps] of Object.entries(grant.grants)) {
    if (JSON.stringify(team.planTaskCapabilities?.[logical]) !== JSON.stringify(caps)) throw new Error('Recovery capability amendment mismatch');
  }
  return { team, grant };
}

export function apply(ctx) {
  let stopped = false;
  async function recover() {
    state();
    const captain = ctx.agents.get(captainId) ?? (await ctx.agents.resume({
      resumeSessionId: captainId,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'zhijian'); },
    })).agent;
    if (stopped) return;
    const noticePath = `${teamDir}/research-runtime-guidance.json`;
    if (!existsSync(noticePath)) {
      const text = '【用户已确认继续推进：t7 评审恢复与 t8/t9/t10 取数权限】本次已按 research-capability-amendment.json 配好三个研究任务的只读能力和旧成员工具可见性，并按当前活动任务限制，t7 仍仅 catalog。请继续原团队、原已审 OUTLINE。t7 最新待审产物 e2f6072c-0330-48ef-98e5-cb8c7f12f9d6（e934815e…）必须先由转轨师傅独立审核，通过后你再正式集成，勿跳过评审。我们正恢复该评审者的冷占位。集成后按依赖推进 t8/t9/t10：t9 先用 realestate.city.market input={city:"上海",code:"rent_index",periodEnd:"2026-09",limit:6} 做一次真实时序校验；确认单位、成交/挂牌口径和统计期，单位缺失不得推定。t10 待这次校验结论再扩展京/穗/深，避免重复上海请求；t8 只做独立反方/供给/政策证据。若单城失败，分类留痕并给出可用替代，不重放旧失败，不把目录成功当时序成功。以前“仅授权 catalog”只适用于 t7 补证；新研究按此次任务级授权执行。每个调用保存真实回执与时间；所有评审与人工门控照常，不代签。评审者若仍只有 mailbox delivered 而无新 turn，调用 expert_teams_resume_member，勿反复发相同通知。';
      captain.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: name } }));
      writeFileSync(noticePath, JSON.stringify({ at: new Date().toISOString(), text }, null, 2), { mode: 0o600 });
      audit('captain-guidance-queued');
    }
    const { team } = state();
    const coreNotice = `${teamDir}/systemic-runtime-recovery.json`;
    if (!existsSync(coreNotice)) {
      const text = '【用户要求的通用修复已部署】旧会话 provider 工具恢复已进入核心成员生命周期，本团队不再使用单独的工具注入补丁；执行时按当前任务能力和实时 durable scope 校验。贝壳租赁/政策字段映射已通过真实调用，租赁返回明确标注当前挂牌，不能当历史成交。冷评审成员恢复也会补发恢复通知，保留原 attempt。请查看当前团队状态继续原 DAG：t12 正在独立评审/修复，按真实 findings 处理，勿重复领取或代签。重启若留下 HOST_RESTART_UNCONFIRMED，请在核对日志后用 resume_member 精确恢复原成员；勿循环重试其他错误。已有报告中的历史失败回执保持原样；新的通道验证不自动变成已审研究证据。t14 人工正文门照常等待用户。';
      captain.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: name } }));
      // A real cold continuation exercises core mounting without business data work.
      const childId = memberIds[0];
      // If shutdown interrupted an accepted turn, resume through the native
      // recovery tool first. Do not bypass a non-restart runtime failure.
      for (const saved of state().team.members) {
        if (saved.status === 'removed' || ctx.agents.get(saved.id)) continue;
        if (saved.runtimeBlock && saved.runtimeBlock.code !== 'HOST_RESTART_UNCONFIRMED') continue;
        if (!saved.activation && !saved.runtimeBlock) continue;
        const recovered = await ctx.tools.execute({ callId: `core-resume-${randomUUID()}`, name: 'expert_teams_resume_member',
          arguments: { member: saved.name, reason: '用户已授权通用修复与继续推进；维护前核对了日志，重载后恢复同一任务/评审，不新增 attempt。',
            ...(saved.runtimeBlock ? { expected_block_id: saved.runtimeBlock.id } : {}) }, agent: captain, signal: new AbortController().signal });
        audit('core-resume', { memberId: saved.id, result: recovered });
        if (recovered.isError) throw new Error('Core member recovery failed');
      }
      const delivered = await deliverToMember(ctx, captain, childId,
        '【运行恢复说明】provider 工具现由核心成员生命周期提供，本团队注入补丁已移除。请只读取团队当前状态：你已提交的 t12 不要重复修改；有正式修复任务按原 attempt 继续，无任务则等待评审。当前任务未授予的数据能力仍禁止调用。', new AbortController().signal);
      const child = ctx.agents.get(childId);
      const toolVisible = Boolean(child && ctx.tools.get('expert_provider_call', child));
      writeFileSync(coreNotice, JSON.stringify({ at: new Date().toISOString(), delivered, childId, toolVisible, maintenanceToolInjection: false }, null, 2), { mode: 0o600 });
      audit('core-provider-tool-recovery', { delivered, childId, toolVisible });
    }
    const t11 = team.tasks.find(t => t.id === 't11');
    const t11Notice = `${teamDir}/t11-pinned-input-recovery.json`;
    if (!existsSync(t11Notice) && t11?.status === 'in_progress' && t11.attemptId === 'a7a3ff38-aaec-4f93-9f9b-65d878c6acca') {
      const text = '【用户要求修复 t11 卡住：Host 版本绑定缺陷已修复】deep-research-gates 原先从 t8 同一 attempt 的发布列表取第一个旧版，误拒正确锁定 v2 的 t11。现已按 consumer inputArtifacts 精确读取，保留 frozen manifest / 路径 / SHA 校验；定向回归及本团队现有字节的完整 checkDeepResearchPass 已通过。t11 attempt 3、artifact 7d477e93-f9a1-4496-a34a-2f2d5f4979ce、SHA e3e3e922c96309bcecaacb32e830c24e7a5fe92475bd816e83d8eeb06bd84480 均未修改。请能级参谋先核对当前状态与字节，仍与先前独立审核一致时，重试原未成功提交的 review-t11-repair-a3-indep-tier-20261006；材料回执 5ef80ca3-f9aa-4244-9fed-da88e1f11858。若证据发生变化，重新评审并据实裁定。不要新建绕行任务、增加修复预算、改为引用 t8 旧版、重开已完成的 t8 或代签 PASS。请队长等待独立评审真正入账后正式 integrate t11，再按原 DAG 推进 t12。此消息只是 Host 故障恢复说明，不是质量审批。';
      const delivered = await deliverToMember(ctx, captain, 'cac86e5b-7103-496c-84d1-a586ca32979a', text, new AbortController().signal);
      audit('t11-reviewer-notice', { delivered });
      if (delivered) {
        captain.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: name } }));
        writeFileSync(t11Notice, JSON.stringify({ at: new Date().toISOString(), delivered, text }, null, 2), { mode: 0o600 });
      }
    }
    const reviewer = team.members.find(m => m.id === reviewerId);
    if (ctx.agents.get(reviewerId)) return;
    if (reviewer.runtimeBlock && reviewer.runtimeBlock.code !== 'HOST_RESTART_UNCONFIRMED') {
      audit('reviewer-non-restart-block', { block: reviewer.runtimeBlock }); return;
    }
    const result = await ctx.tools.execute({ callId: `review-recovery-${randomUUID()}`, name: 'expert_teams_resume_member',
      arguments: { member: reviewer.name, reason: '用户已确认继续推进；检查到 t7 评审旧轮次中断，恢复冷成员和未处理的最新修订版评审邮件，保持原质量门控。',
        ...(reviewer.runtimeBlock ? { expected_block_id: reviewer.runtimeBlock.id } : {}) }, agent: captain, signal: new AbortController().signal });
    audit('reviewer-resume-result', { result });
    if (result.isError) throw new Error('Reviewer resume failed');
  }
  const timer = setTimeout(() => recover().catch(error => audit('error', { message: String(error) })), 8000);
  ctx.effect(() => () => { stopped = true; clearTimeout(timer); });
}
