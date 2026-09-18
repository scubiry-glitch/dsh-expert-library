#!/usr/bin/env node
/**
 * adapt-partner-pack.mjs — 合作伙伴领域包入库适配器（§9 验收流水线工具）。
 *
 * 用法：
 *   node scripts/adapt-partner-pack.mjs check  <packDir>              # 只读体检：跑 v2 加载器，分组打印诊断
 *   node scripts/adapt-partner-pack.mjs adapt  <packDir> [--map stem=scenarioId]  # 备份→按映射规则改写→复检
 *       --map hold-return-team=single-home-hold-return-acquisition
 *       团队模板与场景配对：缺省自动（模板带 scenarioId 字段用之；仅一个场景直接配；否则要求显式 --map）
 *
 * 适配范围（v2 Schema 形态映射，语义零丢失；原文件备份到 <packDir>.pre-adapt/）：
 *   output-templates  documentStructure.sections → sections[]；补 media/renderModes；rendering.notes → renderingNotes
 *   quality-policies  gate 补 kind/appliesTo/phase/config；bannedTokens 入 config；maxRepairRounds 封顶 2
 *   team-templates    leadExpert/memberExperts 名单 → 按场景 DAG 展开 slots/tasks/gates/deliverables
 *   knowledge-providers 包装交接清单 → 标准 KnowledgeProviderManifest；非 Manifest 文件挪到 data-contracts/；文件名对齐实体 id
 *
 * 依赖插件构建产物 ../lib/v2/pack-loader.js（与设置页管理界面同一校验路径）。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPackFromDir } from '../lib/v2/pack-loader.js'

const [, , mode, packArg, ...rest] = process.argv
if (!mode || !packArg || !['check', 'adapt'].includes(mode)) {
  console.error('用法: node scripts/adapt-partner-pack.mjs check|adapt <packDir> [--map stem=scenarioId ...]')
  process.exit(2)
}
const packDir = resolve(packArg)
if (!existsSync(packDir) || !statSync(packDir).isDirectory()) {
  console.error(`包目录不存在: ${packDir}`)
  process.exit(2)
}

const readJson = f => JSON.parse(readFileSync(f, 'utf8'))
const writeJson = (f, obj) => writeFileSync(f, JSON.stringify(obj, null, 2) + '\n', 'utf8')
const listJson = dir => existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')).map(n => join(dir, n)) : []

// ---------- 校验 ----------
async function validate() {
  const r = await loadPackFromDir(packDir, { layer: 'workspace', label: 'domain-packs/' + basename(packDir) })
  if (r.ok) {
    const p = r.pack
    console.log(`OK ${p.pack.id} v${p.pack.version}`)
    console.log(`  experts:${p.experts.length} scenarios:${p.scenarios.length} teamTemplates:${p.teamTemplates.length} outputTemplates:${p.outputTemplates.length} qualityPolicies:${p.qualityPolicies.length} knowledgeProviders:${p.knowledgeProviders.length}`)
    for (const d of r.diagnostics.filter(d => d.severity !== 'error')) console.log(`  [warn] ${d.code} @ ${d.path}: ${d.message}`)
    return true
  }
  const errs = r.diagnostics.filter(d => d.severity === 'error')
  const groups = {}
  for (const d of errs) { const k = d.path.replace(/\[\d+\]/g, '[]'); groups[k] = (groups[k] ?? 0) + 1 }
  console.log(`FAILED - ${errs.length} errors`)
  for (const [k, n] of Object.entries(groups)) console.log(`  ${String(n).padStart(3)}  ${k}`)
  if (errs[0]) console.log('  样例:', errs[0].code, '@', errs[0].path, '-', errs[0].message)
  return false
}

// ---------- gate 分类规则（与 §9 反馈文档保持一致） ----------
function gateKind(g) {
  const id = String(g.id ?? '')
  if (/render|overflow|layout|page|docx|pdf/i.test(id)) return 'visual'
  if (/outline|evidence|disclosure|consistency|semantic|reason/i.test(id)) return 'semantic'
  return 'deterministic'
}
function gatePhase(kind, g) {
  const id = String(g.id ?? '')
  if (kind === 'visual') return 'format'
  if (kind === 'semantic') return 'semantic'
  if (/banned|token|compliance|sensitive|anonym|declaration/i.test(id)) return 'compliance'
  if (/number|data|release|coverage|citation|dataset|ref/i.test(id)) return 'data'
  if (/placeholder|format|section|structure/i.test(id)) return 'structure'
  return undefined
}
const SAFE_ID = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u

// ---------- 1) output-templates ----------
function adaptOutputTemplates() {
  for (const f of listJson(join(packDir, 'output-templates'))) {
    const d = readJson(f)
    if (d.media && d.sections && d.renderModes) continue // 已是 v2 形态
    const sections = (d.documentStructure?.sections ?? d.sections ?? []).map(s => ({
      id: s.name ?? s.id,
      required: Boolean(s.required),
      ...(s.notes ? { fields: [s.notes] } : {}),
    }))
    const fmt = String(d.rendering?.format ?? '').toUpperCase()
    const media = fmt === 'PDF' ? ['markdown', 'pdf'] : ['markdown']
    const out = {
      id: d.id ?? basename(f, '.json'),
      version: d.version ?? '0.1.0',
      schemaVersion: 2,
      media,
      sections,
      renderModes: { discussion: { anonymize: true }, final: { anonymize: false } },
      ...(d.appliesToScenario ? { appliesToScenario: d.appliesToScenario } : {}),
      ...(d.dataRules ? { dataRules: d.dataRules } : {}),
      ...(d.rendering?.notes ? { renderingNotes: d.rendering.notes } : {}),
    }
    writeJson(f, out)
    console.log('  output-template 适配:', out.id)
  }
}

// ---------- 2) quality-policies ----------
function adaptQualityPolicies() {
  for (const f of listJson(join(packDir, 'quality-policies'))) {
    const d = readJson(f)
    if (Array.isArray(d.gates) && d.gates.every(g => g.kind && g.appliesTo)) continue
    const gates = (d.gates ?? []).map(g => {
      const kind = gateKind(g)
      const phase = gatePhase(kind, g)
      const cfg = { ...(g.config ?? {}) }
      if (g.description && !cfg.rules) cfg.rules = [g.description]
      if (g.bannedTokens) cfg.bannedTokens = g.bannedTokens
      return {
        id: g.id,
        kind,
        appliesTo: Array.isArray(g.appliesTo) && g.appliesTo.length ? g.appliesTo : ['deliverable'],
        severity: g.severity === 'soft' ? 'soft' : 'hard',
        ...(phase ? { phase } : {}),
        config: cfg,
      }
    })
    writeJson(f, {
      id: d.id ?? basename(f, '.json'),
      version: d.version ?? '0.1.0',
      schemaVersion: 2,
      gates,
      maxRepairRounds: Math.min(Number(d.maxRepairRounds ?? 2), 2),
      ...(d.appliesToScenario ? { appliesToScenario: d.appliesToScenario } : {}),
      ...(d.notes ? { notes: d.notes } : {}),
    })
    console.log(`  quality-policy 适配: ${d.id} (${gates.length} gates)`)
  }
}

// ---------- 3) team-templates ----------
function adaptTeamTemplates(mapArgs) {
  const map = new Map(mapArgs) // stem → scenarioId
  const scenDir = join(packDir, 'scenarios')
  const scenFiles = listJson(scenDir)
  if (scenFiles.length === 0) return console.log('  (无 scenarios，跳过 team-templates)')
  const expertCaps = {}
  for (const f of listJson(join(packDir, 'experts'))) {
    const e = readJson(f)
    expertCaps[e.id] = (e.capabilities ?? []).map(c => c.capability ?? c).filter(x => typeof x === 'string')
  }
  for (const f of listJson(join(packDir, 'team-templates'))) {
    const stem = basename(f, '.json')
    const tt = readJson(f)
    if (tt.slots && tt.tasks && tt.deliverables) continue // 已是 v2 形态
    let scenId = tt.scenarioId ?? map.get(stem)
    if (!scenId && scenFiles.length === 1) scenId = readJson(scenFiles[0]).id
    if (!scenId) { console.log(`  ! ${stem}: 多场景需 --map ${stem}=<scenarioId>，已跳过`); continue }
    const scen = readJson(join(scenDir, `${scenId}.json`))
    const otId = scen.outputTemplate ?? `${scenId}.output`
    const qpId = scen.qualityPolicy ?? `${scenId}.quality`
    let qpGates = []
    try { qpGates = readJson(join(packDir, 'quality-policies', `${qpId}.json`)).gates ?? [] } catch { /* 稍后由校验器报 */ }
    const experts = scen.experts ?? [...new Set((scen.tasks ?? []).map(t => t.expert).filter(Boolean))]
    const slots = experts.map(e => ({ id: e, capabilities: expertCaps[e] ?? [], cardinality: { min: 1, max: 1 } }))
    const tasks = (scen.tasks ?? []).map((t, i) => ({
      id: `t${i}`,
      role: t.expert ?? experts[0],
      dependsOn: (t.dependsOn ?? []).map(d => `t${d}`),
      inputs: (t.dependsOn ?? []).map(d => ({ kind: 'task-output', ref: `t${d}` })),
      allowedCapabilities: expertCaps[t.expert] ?? [],
      outputSchema: otId,
      retryPolicy: 'quality-repair',
      ...(t.subject ? { subject: t.subject } : {}),
      ...(t.description ? { description: t.description } : {}),
    }))
    const gates = qpGates.filter(g => g.severity !== 'soft')
      .map(g => ({ policy: qpId, gate: g.id, appliesTo: ['deliverable'] }))
    writeJson(f, {
      id: tt.id ?? stem,
      version: tt.version ?? '0.1.0',
      schemaVersion: 2,
      parameters: { type: 'object', properties: { data: { type: 'string', description: '标的与数据上下文' } } },
      slots,
      tasks,
      gates,
      deliverables: [{ id: 'deliverable', outputTemplate: otId, fromTasks: [`t${tasks.length - 1}`], renderMode: 'final' }],
      scenarioId: scenId,
      ...(tt.leadExpert ? { leadExpert: tt.leadExpert } : {}),
    })
    console.log(`  team-template 适配: ${tt.id} (场景 ${scenId}，${slots.length} slots / ${tasks.length} tasks / ${gates.length} gate 绑定)`)
  }
}

// ---------- 4) knowledge-providers ----------
function adaptKnowledgeProviders() {
  const dir = join(packDir, 'knowledge-providers')
  if (!existsSync(dir)) return
  const handover = join(packDir, 'data-contracts')
  for (const f of listJson(dir)) {
    const d = readJson(f)
    const wrapped = d.knowledgeProvider && typeof d.knowledgeProvider === 'object'
    const candidate = wrapped ? d.knowledgeProvider : d
    const looksManifest = candidate && typeof candidate.id === 'string' && SAFE_ID.test(candidate.id)
      && candidate.kind && Array.isArray(candidate.capabilities) && candidate.freshness
    if (!looksManifest && !wrapped) {
      // 非 Provider 实体（技能目录/交接清单等）→ 挪出加载目录
      mkdirSync(handover, { recursive: true })
      const dest = join(handover, basename(f))
      renameSync(f, dest)
      console.log(`  非实体文件挪至 data-contracts/: ${basename(f)}`)
      continue
    }
    const manifest = {
      id: candidate.id,
      version: candidate.version ?? '0.1.0',
      schemaVersion: 2,
      kind: candidate.kind ?? 'files',
      capabilities: candidate.capabilities ?? ['read', 'cite'],
      freshness: candidate.freshness ?? 'static',
      ...(Array.isArray(candidate.scopes) ? { scopes: candidate.scopes.map(s => typeof s === 'string' ? s : s.scope).filter(Boolean) } : {}),
    }
    writeJson(f, manifest) // 原位改写为标准 Manifest
    const wanted = join(dir, `${manifest.id}.json`)
    if (basename(f) !== `${manifest.id}.json`) renameSync(f, wanted) // 文件名对齐实体 id
    console.log(`  knowledge-provider 适配: ${manifest.id}`)
  }
}

// ---------- 主流程 ----------
if (mode === 'check') {
  process.exit(await validate() ? 0 : 1)
}

// adapt：备份 → 改写 → 复检
const backup = packDir + '.pre-adapt'
if (existsSync(backup)) rmSync(backup, { recursive: true })
cpSync(packDir, backup, { recursive: true })
console.log('原文件已备份 →', backup)

const mapArgs = []
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--map' && rest[i + 1]) {
    const [k, v] = rest[i + 1].split('=')
    if (k && v) mapArgs.push([k, v])
    i++
  }
}

console.log('适配开始:')
adaptOutputTemplates()
adaptQualityPolicies()
adaptTeamTemplates(mapArgs)
adaptKnowledgeProviders()
console.log('复检:')
const ok = await validate()
process.exit(ok ? 0 : 1)
