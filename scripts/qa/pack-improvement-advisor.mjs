#!/usr/bin/env node
// Read-only partner pack review. The schema loader remains the admission authority;
// these checks identify operational gaps that a schema check cannot prove away.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { loadPackFromDir } from '../../lib/v2/pack-loader.js'

function arg(name) { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const packDir = arg('--pack') && resolve(arg('--pack'))
if (!packDir || !existsSync(join(packDir, 'pack.json'))) {
  console.error('用法: node scripts/qa/pack-improvement-advisor.mjs --pack <目录> [--evidence <JSON>] [--out <JSON>]')
  process.exit(2)
}
const read = p => JSON.parse(readFileSync(p, 'utf8'))
const entities = section => {
  const dir = join(packDir, section)
  return existsSync(dir) && statSync(dir).isDirectory()
    ? readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => ({ file: join(section, f), value: read(join(dir, f)) })) : []
}
const meta = read(join(packDir, 'pack.json'))
const scenarios = entities('scenarios'), experts = entities('experts')
const templates = entities('output-templates'), policies = entities('quality-policies')
const providers = entities('knowledge-providers'), teams = entities('team-templates')
const findings = []
function add(id, category, priority, location, evidence, action, docSection) {
  findings.push({ id, category, priority, location, evidence, action, docSection })
}

const load = await loadPackFromDir(packDir, { layer: 'workspace', label: `domain-packs/${basename(packDir)}` })
for (const d of load.diagnostics.filter(d => d.severity === 'error')) {
  add(`schema:${d.code}:${d.path}`, '形态与引用', 'P0', d.path, d.message,
    '先运行 adapt-partner-pack check，修复该实体或引用，再复检。', '1.3 / 9')
}
if (!Object.keys(meta.caliberDeclarations ?? {}).length) {
  add('caliber-declarations', '数据漂移', 'P0', 'pack.json', '未声明取数口径',
    '逐指标声明来源、统计范围、单位和更新时间，并与数据提供方映射。', '1.3 / 7')
}
if (!providers.length) {
  add('provider-manifest', '数据漂移', 'P1', 'knowledge-providers/', '没有数据提供方清单',
    '增加来源能力、freshness、缺失值三态和字段映射；月度样本做跨期核对。', '7')
}
for (const { file, value: p } of providers) {
  if (!p.freshness) add(`freshness:${p.id ?? file}`, '数据漂移', 'P1', file, '缺少 freshness',
    '标明更新频率和过期处理；以时间戳与样本哈希检测漂移。', '7')
}
for (const { file, value: s } of scenarios) {
  if (!s.outputTemplate || !s.qualityPolicy) add(`bindings:${s.id ?? file}`, '任务节点稳定', 'P0', file,
    '场景缺少输出模板或质量策略绑定', '在场景中显式绑定输出模板、质量策略，逐节点指定输入、输出和失败恢复。', '3 / 6')
  const ts = teams.filter(x => x.value.scenarioId === s.id || x.value.id === s.teamTemplate)
  if (!ts.length && !Array.isArray(s.tasks)) add(`dag:${s.id ?? file}`, '任务节点稳定', 'P1', file,
    '找不到可核验的任务节点 DAG', '给每个任务节点定义依赖、交付物、超时与重试上限；做中断续跑试验。', '3')
}
for (const { file, value: q } of policies) {
  const gates = q.gates ?? []
  const phases = new Set(gates.filter(g => g.severity !== 'soft').map(g => g.phase))
  for (const phase of ['data', 'structure', 'semantic', 'format']) {
    if (!phases.has(phase)) add(`gate:${q.id ?? file}:${phase}`, '门禁稳定', 'P1', file,
      `缺少 ${phase} 阶段硬门禁`, '补充有机器回执的硬门禁，并在 10 次试跑中记录误放行、误阻断和修复轮次。', '6')
  }
  if ((q.maxRepairRounds ?? 0) > 2) add(`repair:${q.id ?? file}`, '门禁稳定', 'P0', file,
    `maxRepairRounds=${q.maxRepairRounds}`, '将修复轮次封顶为 2，并显式给出失败原因。', '6')
}
const promisedFormats = /\b(?:DOCX|Word|PDF)\b/i.test(`${meta.description ?? ''} ${meta.name ?? ''}`)
for (const { file, value: t } of templates) {
  const media = t.media ?? []
  if (promisedFormats && !media.some(x => ['docx', 'pdf'].includes(String(x).toLowerCase()))) {
    add(`media:${t.id ?? file}`, '模板格式稳定', 'P0', file,
      `包描述承诺报告，media=${JSON.stringify(media)}`, '按真实交付格式声明 DOCX/PDF，并以样板文件验收章节、图表、页边距和下载。', '6')
  }
  if (!(t.sections ?? []).some(x => x.required)) add(`sections:${t.id ?? file}`, '模板格式稳定', 'P1', file,
    '没有必备章节', '固定章节 ID 与顺序；允许文字表达变化，并把图表尺寸写成可执行校验。', '6')
}
for (const { file, value: e } of experts) {
  if (!e.persona?.tone || !e.methodProfile?.evidenceStandard || !e.emm?.vetoRules?.length) {
    add(`expert:${e.id ?? file}`, '专家拟人化', 'P1', file,
      '语气、证据标准或否决规则不完整', '补齐具体工作习惯、证据标准和可判定的否决规则；由盲评样本检查套话与越权推断。', '4')
  }
}
const evidenceFile = arg('--evidence')
let sessionEvidence = []
if (evidenceFile) {
  sessionEvidence = read(resolve(evidenceFile))
  if (!Array.isArray(sessionEvidence) || sessionEvidence.some(x => !x.sessionId || !x.category || !x.observation)) {
    throw Error('EVIDENCE_SCHEMA: 需为 [{sessionId,category,observation}]')
  }
  // Observations stay in the private source file; output only counts and session IDs.
}
const evidenceByCategory = Object.groupBy(sessionEvidence, x => x.category)
const sessionActions = {
  '数据漂移': ['P0', '把每个指标的来源、口径、城市、时间窗、单位、更新时间和缺失状态固化为机器可比对底稿；跨期及跨城样本复算。', '7'],
  '门禁稳定': ['P0', '将数据、结构、语义、格式硬门禁绑定真实检查回执，记录误放行、误阻断及两轮修复后的终态。', '6'],
  '模板格式稳定': ['P0', '采用唯一格式规格；对 DOCX/PDF 的章节、图表、表格合并、页边距和下载做渲染回归。', '6'],
  '专家拟人化': ['P1', '以独立样本盲评专家判断、证据锚、语气与反模板腔表现，并把否决项写入专家配置。', '4'],
  '任务节点稳定': ['P0', '逐节点保存输入输出、重试次数和恢复点，测试中断续跑、超时和重复请求幂等。', '3'],
  '发布交付': ['P0', '把审核、发布、安装、可调用和产物下载设为可查询状态；版本号和哈希贯穿全链。', '9'],
}
const sessionPatterns = []
for (const [category, items] of Object.entries(evidenceByCategory)) {
  const policy = sessionActions[category]
  if (!policy) continue
  const sessions = [...new Set(items.map(x => x.sessionId))]
  sessionPatterns.push({ category, priority: policy[0], sessionIds: sessions,
    action: policy[1], docSection: policy[2] })
}
const report = {
  tool: 'partner-pack-improvement-advisor', pack: { id: meta.id, version: meta.version, path: packDir },
  schemaValid: load.ok, entityCounts: { scenarios: scenarios.length, experts: experts.length,
    outputTemplates: templates.length, qualityPolicies: policies.length, knowledgeProviders: providers.length,
    teamTemplates: teams.length },
  sessionEvidence: Object.fromEntries(Object.entries(evidenceByCategory).map(([k, a]) => [k, [...new Set(a.map(x => x.sessionId))]])),
  sessionPatterns: sessionPatterns.sort((a, b) => a.category.localeCompare(b.category)),
  findings: findings.sort((a, b) => (a.priority.localeCompare(b.priority) || a.category.localeCompare(b.category) || a.id.localeCompare(b.id))),
  guidance: '静态诊断只提出优化建议；审核通过须按合作伙伴文档第 9 节完成形态检查、灰度试跑和真实门禁回执。',
}
if (arg('--out')) writeFileSync(resolve(arg('--out')), JSON.stringify(report, null, 2) + '\n')
else console.log(JSON.stringify(report, null, 2))
