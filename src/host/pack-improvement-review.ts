/** Read-only, account-local review of an activated partner pack. */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { loadPackFromDir } from '../v2/pack-loader.ts'

export interface PackReviewFinding {
  id: string
  category: string
  priority: 'P0' | 'P1'
  location: string
  evidence: string
  action: string
  docSection: string
}
type Json = Record<string, any>

export async function reviewPackFromDir(root: string) {
  const rootReal = realpathSync(root)
  const contained = (file: string) => {
    const resolved = realpathSync(file)
    if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) throw new Error('PACK_FILE_ESCAPE')
    return resolved
  }
  const manifestFile = join(root, 'pack.json')
  const meta = JSON.parse(readFileSync(contained(manifestFile), 'utf8')) as Json
  const entities = (section: string): Array<{ file: string; value: Json }> => {
    const dir = join(root, section)
    return existsSync(dir) && statSync(dir).isDirectory()
      ? readdirSync(contained(dir)).filter(file => file.endsWith('.json')).sort()
        .map(file => ({ file: `${section}/${file}`, value: JSON.parse(readFileSync(contained(join(dir, file)), 'utf8')) as Json })) : []
  }
  const scenarios = entities('scenarios'), experts = entities('experts')
  const templates = entities('output-templates'), policies = entities('quality-policies')
  const providers = entities('knowledge-providers'), teams = entities('team-templates')
  const findings: PackReviewFinding[] = []
  const add = (id: string, category: string, priority: 'P0' | 'P1', location: string,
    evidence: string, action: string, docSection: string) => findings.push({ id, category, priority, location, evidence, action, docSection })
  const publicDiagnostic = (value: string) => value.replace(/\/(?:[^\s"'()]+\/)*[^\s"'()]+/gu, '[包内路径]')
  const loaded = await loadPackFromDir(root, { layer: 'workspace', label: `domain-packs/${meta.id ?? 'review'}` })
  for (const d of loaded.diagnostics.filter(d => d.severity === 'error')) {
    add(`schema:${d.code}:${publicDiagnostic(d.path)}`, '形态与引用', 'P0', publicDiagnostic(d.path), publicDiagnostic(d.message),
      '先修复实体或引用并复检。', '1.3 / 9')
  }
  if (!Object.keys(meta.caliberDeclarations ?? {}).length) add('caliber-declarations', '数据漂移', 'P0', 'pack.json',
    '未声明取数口径', '逐指标声明来源、统计范围、单位和更新时间，并与数据提供方映射。', '1.3 / 7')
  if (!providers.length) add('provider-manifest', '数据漂移', 'P1', 'knowledge-providers/',
    '没有数据提供方清单', '增加来源能力、freshness、缺失值三态和字段映射；月度样本做跨期核对。', '7')
  for (const { file, value: p } of providers) {
    if (!p.freshness) add(`freshness:${p.id ?? file}`, '数据漂移', 'P1', file, '缺少 freshness',
      '标明更新频率和过期处理；以时间戳与样本哈希检测漂移。', '7')
  }
  for (const { file, value: s } of scenarios) {
    if (!s.outputTemplate || !s.qualityPolicy) add(`bindings:${s.id ?? file}`, '任务节点稳定', 'P0', file,
      '场景缺少输出模板或质量策略绑定', '显式绑定输出模板、质量策略，逐节点指定输入、输出和失败恢复。', '3 / 6')
    const matchingTeams = teams.filter(x => x.value.scenarioId === s.id || x.value.id === s.teamTemplate)
    if (!matchingTeams.length && !Array.isArray(s.tasks)) add(`dag:${s.id ?? file}`, '任务节点稳定', 'P1', file,
      '找不到可核验的任务节点 DAG', '给每个任务节点定义依赖、交付物、超时与重试上限；做中断续跑试验。', '3')
  }
  for (const { file, value: q } of policies) {
    const gates: Json[] = Array.isArray(q.gates) ? q.gates : []
    const phases = new Set(gates.filter(g => g.severity !== 'soft').map(g => g.phase))
    for (const phase of ['data', 'structure', 'semantic', 'format']) {
      if (!phases.has(phase)) add(`gate:${q.id ?? file}:${phase}`, '门禁稳定', 'P1', file,
        `缺少 ${phase} 阶段硬门禁`, '补充有机器回执的硬门禁，并在 10 次试跑中记录误放行、误阻断和修复轮次。', '6')
    }
    if (Number(q.maxRepairRounds ?? 0) > 2) add(`repair:${q.id ?? file}`, '门禁稳定', 'P0', file,
      `maxRepairRounds=${q.maxRepairRounds}`, '将修复轮次封顶为 2，并显式给出失败原因。', '6')
  }
  const promisedFormats = /\b(?:DOCX|Word|PDF)\b/i.test(`${meta.description ?? ''} ${meta.name ?? ''}`)
  for (const { file, value: t } of templates) {
    const media = Array.isArray(t.media) ? t.media : []
    if (promisedFormats && !media.some(x => ['docx', 'pdf'].includes(String(x).toLowerCase()))) {
      add(`media:${t.id ?? file}`, '模板格式稳定', 'P0', file,
        `包描述承诺报告，media=${JSON.stringify(media)}`, '按真实交付格式声明 DOCX/PDF，并以样板文件验收章节、图表、页边距和下载。', '6')
    }
    if (!Array.isArray(t.sections) || !t.sections.some((x: Json) => x.required)) add(`sections:${t.id ?? file}`, '模板格式稳定', 'P1', file,
      '没有必备章节', '固定章节 ID 与顺序；允许文字表达变化，并把图表尺寸写成可执行校验。', '6')
  }
  for (const { file, value: e } of experts) {
    if (!e.persona?.tone || !e.methodProfile?.evidenceStandard || !e.emm?.vetoRules?.length) {
      add(`expert:${e.id ?? file}`, '专家拟人化', 'P1', file,
        '语气、证据标准或否决规则不完整', '补齐工作习惯、证据标准和可判定的否决规则；用盲评样本检查套话与越权推断。', '4')
    }
  }
  return { pack: { id: meta.id, version: meta.version }, schemaValid: loaded.ok,
    entityCounts: { scenarios: scenarios.length, experts: experts.length, outputTemplates: templates.length,
      qualityPolicies: policies.length, knowledgeProviders: providers.length, teamTemplates: teams.length },
    findings: findings.sort((a, b) => a.priority.localeCompare(b.priority) || a.category.localeCompare(b.category) || a.id.localeCompare(b.id)),
    guidance: '静态检查只提出优化建议；审核通过仍需完成形态检查、灰度试跑和真实门禁回执。' }
}
