/** Account-local, verified domain-pack and expert mentions for customer sessions. */
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { latestVerifiedCustomerMention, type CustomerCapabilityMention, type CustomerMention } from './customer-mentions.ts'
import { sessionOwnEvents } from '../harness-compat.ts'
import { reviewPackFromDir } from './pack-improvement-review.ts'
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
  readonly pack?: DomainPackV2
  readonly expert?: ExpertV2
}

export const CUSTOMER_PACK_ASSISTANT_ID = 'host.domain-pack-assistant'
const PACK_ASSISTANT_SKILLS = {
  create: 'domain-pack-create', update: 'domain-pack-update', check: 'domain-pack-check', download: 'domain-pack-download',
} as const
type PackAssistantAction = keyof typeof PACK_ASSISTANT_SKILLS

export function packAssistantAction(question: string): PackAssistantAction | undefined {
  const patterns: readonly [PackAssistantAction, RegExp][] = [
    ['create', /创建|新建|制作|开发.{0,8}领域包/gu],
    ['update', /更新|升级|修订|改版|修改/gu],
    ['check', /检查|优化|诊断|审查|分析/gu],
    ['download', /下载|导出|获取.{0,12}(?:领域包|发布件|ZIP|压缩包)|安装.{0,8}(?:领域包|发布件)|启用到|请启用|帮我启用|回滚/gu],
  ]
  let first: { index: number; action: PackAssistantAction } | undefined
  for (const [action, pattern] of patterns) {
    const match = pattern.exec(question)
    if (match && (!first || match.index < first.index)) first = { index: match.index, action }
  }
  return first?.action
}

const safeLabel = (value: string) => value.replace(/\s+/gu, '').replace(/[@，。！？、,!?;；:：)\]）]/gu, '').slice(0, 54)
const targetKey = (kind: string, id: string, version: string) => `${kind}:${id}:${version}`

async function accountPackLayers(ctx: Context, config: CapabilityConfig, workspace: string): Promise<{ pack: DomainPackV2; root: string }[]> {
  const root = await realpath(workspace)
  const home = dirname(root)
  const localDir = resolve(root, config.packsDir)
  const active = await resolveManagedRuntimePack(ctx, config, buildZhijianDomainPack())
  const centerRoots = new Set((active.centerSnapshot?.packs ?? [])
    .map(item => resolve(item.root)).filter(path => path.startsWith(`${home}${sep}pack-center${sep}`)))
  const packs: { pack: DomainPackV2; root: string }[] = []
  for (const [index, layer] of active.layers.entries()) {
    const physical = await realpath(layer.dir)
    const local = dirname(physical) === localDir
    if (!local && !centerRoots.has(physical)) continue
    const pack = active.layerPacks[index]
    if (!pack) throw new Error('CUSTOMER_PACK_UNAVAILABLE')
    packs.push({ pack, root: physical })
  }
  return packs
}

export async function customerReviewPackRoot(ctx: Context, config: CapabilityConfig, workspace: string, packId: string): Promise<string | undefined> {
  const layers = await accountPackLayers(ctx, config, workspace)
  return layers.find(({ pack }) => pack.pack.id === packId)?.root
}

export async function customerCapabilityTargets(
  ctx: Context, config: CapabilityConfig, workspace: string,
): Promise<readonly Target[]> {
  const packs = (await accountPackLayers(ctx, config, workspace)).map(layer => layer.pack)
  const targets: Target[] = [{ mention: { kind: 'expert', id: CUSTOMER_PACK_ASSISTANT_ID, version: '1.0.0',
    name: '领域包助手', description: '创建、更新、检查和下载领域包；按任务调用对应 Skill' } }]
  const names = new Set<string>()
  const modelCache = new Map<string, Promise<ModelPolicy | undefined>>()
  const resolveModel = (preferred: ModelPolicy): Promise<ModelPolicy | undefined> => {
    const key = JSON.stringify([preferred.provider, preferred.model, preferred.reasoningEffort ?? null])
    let pending = modelCache.get(key)
    if (!pending) {
      pending = ctx.llm.resolveCallConfig({ provider: preferred.provider, model: preferred.model,
        ...(preferred.reasoningEffort === undefined ? {} : { reasoningEffort: preferred.reasoningEffort as LlmCallConfig['reasoningEffort'] }) })
        .then(selected => ({ provider: selected.provider, model: selected.model,
          ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: String(selected.reasoningEffort) }) }))
        .catch(() => undefined)
      modelCache.set(key, pending)
    }
    return pending
  }
  for (const pack of packs) {
    const packName = safeLabel(pack.pack.name)
    if (packName) targets.push({ pack, mention: { kind: 'pack-review', id: pack.pack.id, version: pack.pack.version,
      name: '领域包优化顾问', packName, description: `检查「${packName}」的数据口径、门禁、模板、专家档案与任务节点` } })
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
        models[index] = await resolveModel(eligible[index]!.preferred)
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
    description: '处理客户页已选中的 @领域包、@专家或 @领域包助手。必须使用客户消息中经服务端核验的 kind/id/version。领域包助手按创建、更新、检查、下载意图选择 Skill；其返回的工作流须继续执行。',
    parameters: {
      kind: { type: 'string', required: true, enum: ['domain-pack', 'expert', 'pack-review'] },
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
      const root = resolve(workspace), cwd = resolve(agent?.session.header.cwd ?? '')
      if (!agent || agent.session.header.origin === 'subagent'
        || (cwd !== root && !cwd.startsWith(join(root, 'spaces') + sep))) throw new Error('CUSTOMER_MENTION_SESSION_REQUIRED')
      if (typeof args.id !== 'string' || typeof args.version !== 'string' || typeof args.question !== 'string'
        || !args.question.trim() || args.question.length > 4000) throw new Error('CUSTOMER_MENTION_INVALID_REQUEST')
      const targets = await customerCapabilityTargets(ctx, config, workspace)
      const found = targets.find(target => targetKey(target.mention.kind, target.mention.id, target.mention.version)
        === targetKey(args.kind, args.id, args.version))
      if (!found) throw new Error('CUSTOMER_MENTION_UNAVAILABLE')
      const { mention, pack, expert } = found
      if (mention.kind === 'expert' && mention.id === CUSTOMER_PACK_ASSISTANT_ID) {
        if (!latestVerifiedCustomerMention(sessionOwnEvents(agent.session), {
          kind: mention.kind, id: mention.id, version: mention.version, name: mention.name,
        })) throw new Error('CUSTOMER_ASSISTANT_SELECTION_REQUIRED')
        const action = packAssistantAction(args.question)
        const layers = await accountPackLayers(ctx, config, workspace)
        const available = layers.map(({ pack: item }) => `${item.pack.name}（${item.pack.id}@${item.pack.version}）`)
        if (!action) return { kind: mention.kind, id: mention.id, version: mention.version, name: mention.name,
          pack: 'host', packVersion: mention.version,
          answer: `请根据用户目标选择创建、更新、检查或下载领域包。当前账号启用：${available.join('；') || '无'}。缺少目标包或操作时，只追问必要条件。` }
        const taskSkill = await readFile(join(workspace, 'knowledge', 'skills', PACK_ASSISTANT_SKILLS[action], 'SKILL.md'), 'utf8')
        const baseSkill = action === 'create' || action === 'update'
          ? await readFile(join(workspace, 'knowledge', 'skills', 'pack-center-domain-pack', 'SKILL.md'), 'utf8') : ''
        const matches = layers.filter(({ pack: item }) => args.question.includes(item.pack.id) || args.question.includes(item.pack.name))
        const selected = matches.length === 1 ? matches[0] : undefined
        let review = ''
        if (action === 'check' && selected) {
          const result = await reviewPackFromDir(selected.root)
          review = `\n当前启用版本静态检查：结构校验${result.schemaValid ? '通过' : '未通过'}，${result.findings.length} 条发现。\n${result.findings.slice(0, 20)
            .map((item, index) => `${index + 1}. [${item.priority}][${item.category}] ${item.location}；依据：${item.evidence}；建议：${item.action}`).join('\n')}`
        }
        if (action === 'check' && selected && !/会话|运行|日志|卡住|失败/u.test(args.question)) {
          return { kind: mention.kind, id: mention.id, version: mention.version, name: mention.name,
            pack: selected.pack.pack.id, packVersion: selected.pack.pack.version,
            answer: `已按 domain-pack-check 对「${selected.pack.pack.name}」当前启用版本完成只读静态检查。请直接根据以下结果回答用户，不重复扫描文件或运行加载器；若用户要求专项核查，再说明本轮范围并继续。${review}` }
        }
        return { kind: mention.kind, id: mention.id, version: mention.version, name: mention.name,
          pack: selected?.pack.pack.id ?? 'host', packVersion: selected?.pack.pack.version ?? mention.version,
          answer: `这是领域包助手的执行工作流，须继续完成用户请求，再汇报实际完成状态。操作：${action}。${selected ? `目标：${selected.pack.pack.name}（${selected.pack.pack.id}@${selected.pack.pack.version}）` : `当前账号启用：${available.join('；') || '无'}`}。\n${taskSkill}${baseSkill ? `\n\n基础创作规范：\n${baseSkill}` : ''}${review}` }
      }
      if (!pack) throw new Error('CUSTOMER_MENTION_UNAVAILABLE')
      if (mention.kind === 'pack-review') {
        if (!latestVerifiedCustomerMention(sessionOwnEvents(agent.session), {
          kind: mention.kind, id: mention.id, version: mention.version, name: mention.name,
        })) throw new Error('CUSTOMER_REVIEW_SELECTION_REQUIRED')
        const packRoot = await customerReviewPackRoot(ctx, config, workspace, pack.pack.id)
        if (!packRoot) throw new Error('PACK_NOT_ACTIVE')
        const review = await reviewPackFromDir(packRoot)
        if (review.pack.version !== mention.version) throw new Error('CUSTOMER_MENTION_UNAVAILABLE')
        const visibleFindings = review.findings.slice(0, 20)
        const summary = visibleFindings.map((item, index) => `${index + 1}. [${item.priority}][${item.category}] ${item.location}\n依据：${item.evidence}\n建议：${item.action}\n开发文档：${item.docSection}`).join('\n\n')
        const remaining = review.findings.length - visibleFindings.length
        await recordCustomerUsage({ kind: 'pack', id: pack.pack.id, version: pack.pack.version,
          sessionId: agent.id, workspace }).catch(() => undefined)
        return { kind: mention.kind, id: mention.id, version: mention.version, name: mention.name,
          pack: pack.pack.id, packVersion: pack.pack.version,
          answer: `已对当前启用的领域包进行只读静态检查。结构校验：${review.schemaValid ? '通过' : '未通过'}；发现 ${review.findings.length} 条建议。\n${summary || '本轮未发现静态规则问题。'}${remaining ? `\n其余 ${remaining} 条请在能力管理的优化检查中查看。` : ''}\n${review.guidance}\n开发文档：https://packs.meizu.life/guides/partner-devdoc` }
      }
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
