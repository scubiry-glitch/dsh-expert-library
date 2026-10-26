/** Account-local, verified domain-pack and expert mentions for customer sessions. */
import { realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CustomerCapabilityMention, CustomerMention } from './customer-mentions.ts'
import { resolveManagedRuntimePack, type ManagedRuntimePackSelection } from './pack-runtime.ts'
import { buildZhijianDomainPack } from '../v2/zhijian-pack.ts'
import { recordCustomerUsage } from './customer-usage.ts'
import type { DomainPackV2, ExpertV2, ModelPolicy } from '../v2/types.ts'

interface CapabilityConfig extends ManagedRuntimePackSelection {
  readonly memberProvider?: string
  readonly expertModelOverrides?: Readonly<Record<string, ModelPolicy>>
}

interface Target {
  readonly mention: CustomerCapabilityMention
  readonly pack: DomainPackV2
  readonly expert?: ExpertV2
}

const safeLabel = (value: string) => value.replace(/\s+/gu, '').replace(/[@，。！？、,!?;；:：)\]）]/gu, '').slice(0, 54)
const targetKey = (kind: string, id: string, version: string) => `${kind}:${id}:${version}`

async function accountPacks(ctx: Context, config: CapabilityConfig, workspace: string): Promise<DomainPackV2[]> {
  const root = await realpath(workspace)
  const home = dirname(root)
  const localDir = resolve(root, config.packsDir)
  const active = await resolveManagedRuntimePack(ctx, config, buildZhijianDomainPack())
  const centerRoots = new Set((active.centerSnapshot?.packs ?? [])
    .map(item => resolve(item.root)).filter(path => path.startsWith(`${home}${sep}pack-center${sep}`)))
  const packs: DomainPackV2[] = []
  for (const [index, layer] of active.layers.entries()) {
    const physical = await realpath(layer.dir)
    const local = dirname(physical) === localDir
    if (!local && !centerRoots.has(physical)) continue
    const pack = active.layerPacks[index]
    if (!pack) throw new Error('CUSTOMER_PACK_UNAVAILABLE')
    packs.push(pack)
  }
  return packs
}

export async function customerCapabilityTargets(
  ctx: Context, config: CapabilityConfig, workspace: string,
): Promise<readonly Target[]> {
  const packs = await accountPacks(ctx, config, workspace)
  const targets: Target[] = []
  const names = new Set<string>()
  for (const pack of packs) {
    const packName = safeLabel(pack.pack.name)
    if (packName && !names.has(packName)) {
      names.add(packName)
      targets.push({ pack, mention: { kind: 'domain-pack', id: pack.pack.id, version: pack.pack.version,
        name: packName, description: pack.pack.description?.slice(0, 180) || '研究方法与场景' } })
    }
    const eligible = pack.experts.flatMap(expert => {
      if (expert.legacySource || expert.compliance.internalOnly) return []
      const preferred = config.expertModelOverrides?.[expert.id] ?? expert.modelPolicy
      return preferred ? [{ expert, preferred }] : []
    })
    const models: (ModelPolicy | undefined)[] = new Array(eligible.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(8, eligible.length) }, async () => {
      while (next < eligible.length) {
        const index = next++
        const preferred = eligible[index]!.preferred
        try {
          const selected = await ctx.llm.resolveCallConfig({ provider: preferred.provider, model: preferred.model,
            ...(preferred.reasoningEffort === undefined ? {} : { reasoningEffort: preferred.reasoningEffort as LlmCallConfig['reasoningEffort'] }) })
          models[index] = { provider: selected.provider, model: selected.model,
            ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: String(selected.reasoningEffort) }) }
        } catch { /* This expert is unavailable in the current model catalog. */ }
      }
    }))
    for (const [index, { expert }] of eligible.entries()) {
      const model = models[index]
      if (!model) continue
      const label = safeLabel(expert.display.publicLabel)
      const name = `${label}·${expert.id}`
      if (!label || names.has(name) || name.length > 64) continue
      names.add(name)
      targets.push({ pack, expert, mention: { kind: 'expert', id: expert.id, version: expert.version,
        name, description: expert.domains.slice(0, 3).join('、') || '领域专家',
        packId: pack.pack.id, packVersion: pack.pack.version, model } })
    }
  }
  return targets
}

export async function customerCapabilityMentions(
  ctx: Context, config: CapabilityConfig, workspace: string, sources: readonly CustomerMention[],
): Promise<CustomerMention[]> {
  return [...sources, ...(await customerCapabilityTargets(ctx, config, workspace)).map(target => target.mention)]
}

/** A real, scoped call: pack advice reads the active pack; expert advice runs its model and persona once. */
export function registerCustomerMentionTool(ctx: Context, config: CapabilityConfig, workspace: string): void {
  ctx.tools.register(defineTool({
    name: 'customer_mention_call',
    description: '处理客户页已选中的 @领域包或 @专家。必须使用客户消息中经服务端核验的 kind/id/version，结合具体问题调用；领域包返回当前版本的方法与场景，专家以该档案的模型和人格执行一次问答。不会建立报告团队。',
    parameters: {
      kind: { type: 'string', required: true, enum: ['domain-pack', 'expert'] },
      id: { type: 'string', required: true },
      version: { type: 'string', required: true },
      question: { type: 'string', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', required: true }, id: { type: 'string', required: true },
      version: { type: 'string', required: true }, name: { type: 'string', required: true },
      pack: { type: 'string', required: true }, packVersion: { type: 'string', required: true },
      answer: { type: 'string', required: true }, provider: { type: 'string' }, model: { type: 'string' },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent || agent.session.header.origin === 'subagent'
        || resolve(agent.session.header.cwd ?? '') !== resolve(workspace)) throw new Error('CUSTOMER_MENTION_SESSION_REQUIRED')
      if (typeof args.id !== 'string' || typeof args.version !== 'string' || typeof args.question !== 'string'
        || !args.question.trim() || args.question.length > 4000) throw new Error('CUSTOMER_MENTION_INVALID_REQUEST')
      const targets = await customerCapabilityTargets(ctx, config, workspace)
      const found = targets.find(target => targetKey(target.mention.kind, target.mention.id, target.mention.version)
        === targetKey(args.kind, args.id, args.version))
      if (!found) throw new Error('CUSTOMER_MENTION_UNAVAILABLE')
      const { mention, pack, expert } = found
      if (!expert) {
        const methods = pack.methodPacks.slice(0, 4).map(method => `${method.name}（${method.id}@${method.version}）\n${method.body.slice(0, 2800)}`)
        const scenarios = pack.scenarios.slice(0, 12).map(scenario => `${scenario.id}@${scenario.version}: ${scenario.intents.join('、')}`)
        await recordCustomerUsage({ kind: 'pack', id: pack.pack.id, version: pack.pack.version,
          sessionId: agent.id, workspace }).catch(() => undefined)
        return { kind: mention.kind, id: mention.id, version: mention.version, name: mention.name,
          pack: pack.pack.id, packVersion: pack.pack.version,
          answer: `包说明：${pack.pack.description ?? ''}\n适用场景：${scenarios.join('；') || '未声明'}\n方法：${methods.join('\n\n') || '未声明'}\n请仅据这些实际内容回答问题；缺失口径应追问。` }
      }
      const model = mention.model!
      const persona = `你是领域专家「${expert.display.publicLabel}」。只回答当前用户的具体问题，不创建团队、计划或报告。证据不足要说明，不编造数据。专家档案：${JSON.stringify({ domains: expert.domains, persona: expert.persona, methodProfile: expert.methodProfile,
        methods: expert.methods, constraints: expert.constraints, compliance: expert.compliance }).slice(0, 16000)}`
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(120_000)])
      const run = await ctx.subagents.start(config.memberProvider ?? 'spawn', {
        label: `customer-expert:${expert.id}`, parent: agent, signal,
        prompt: [{ type: 'text', text: args.question }], persona, toolFilter: { allow: [] },
        agentOptions: { provider: model.provider, model: model.model,
          ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }) },
      })
      let answer: string
      try {
        const result = await run.result
        if (result.stopReason !== 'completed') throw new Error('CUSTOMER_EXPERT_RUN_FAILED')
        answer = result.output.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
        if (!answer) throw new Error('CUSTOMER_EXPERT_EMPTY_ANSWER')
      } finally { await run.dispose() }
      await Promise.allSettled([
        recordCustomerUsage({ kind: 'expert', id: expert.id, version: expert.version, sessionId: agent.id, workspace }),
        recordCustomerUsage({ kind: 'pack', id: pack.pack.id, version: pack.pack.version, sessionId: agent.id, workspace }),
      ])
      return { kind: mention.kind, id: mention.id, version: mention.version, name: mention.name,
        pack: pack.pack.id, packVersion: pack.pack.version, answer,
        provider: model.provider, model: model.model }
    },
  }))
}
