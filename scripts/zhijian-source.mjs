/**
 * Shared hardened parser for the 智见点评 skill source.
 *
 * Single source of truth for turning the skill package (zip baseline or the
 * domain pack's embedded `source/`) into the native expert metas consumed by
 * `src/zhijian/data/experts.generated.ts`. Both build scripts use this module:
 *
 * - `scripts/build-zhijian-data.mjs` — regenerate `experts.generated.ts`
 * - `scripts/build-zhijian-pack.mjs` — regenerate the `zhijian-realestate`
 *   domain pack (which embeds a lossless copy of the same source)
 *
 * Hard constraints (data-loss protection):
 *
 * - **roster/profile mismatch is FATAL**: a Profile JSON whose BK id has no
 *   roster row, a roster row with no Profile, a material dir with no Profile,
 *   an unparseable Profile, a real-name / persona-name mismatch, or a
 *   duplicate BK id all abort the build with structured errors instead of
 *   being silently skipped (the old `console.warn` + skip behavior could drop
 *   an expert — e.g. BK-034 was added to the workspace source on 2026-08-20
 *   and must be an explicit, versioned decision, never a silent drop).
 * - **no fabrication**: every meta field is derived verbatim from the source
 *   (roster table + Profile JSON). Missing optional fields stay absent/empty;
 *   nothing is invented.
 * - **deterministic**: experts are emitted sorted by BK id and the meta
 *   object key order is fixed, so regenerating from the same source is
 *   byte-identical (fidelity is tested by
 *   `test/zhijian-source-parse.test.mjs`).
 *
 * Accepted source layouts (auto-detected):
 *
 * - `zip` (parent): `<src>/智见点评/专家总表.md` + `专家材料/<姓名>/…`
 * - `zip` (root):   `<src>/专家总表.md` + `<src>/专家材料/<姓名>/…`
 * - `pack`:         `<src>/docs/专家总表.md` + `<src>/raw-profiles/*.json`
 *   (the domain pack's embedded source — see `domain-packs/zhijian-realestate/source/`)
 *
 * @module dsh-expert-library/scripts/lib/zhijian-source
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/** Deceased experts (固化规则: 只可引用历史观点). */
export const DECEASED = new Set(['BK-022'])

/** Roster section header: `### 1. 宏观经济（9 位）`. */
const ROSTER_HEADER = /^### \d+\. (.+?)（\d+ 位）$|^### \d+\. (.+?)$/

/**
 * Expert id in any supported namespace:
 * - `BK-NNN`    房地产/宏观/政策 roster
 * - `BANK-NNN`  银行金融 roster
 * - `S-NNN`     pipeline 特级专家（巴菲特/乔布斯/Karpathy…）
 * - `E<域>-<号>` pipeline 行业专家（E08=房地产、E01=宏观经济、E13=江苏银行…）
 * - `XHS-NNN`   pipeline 小红书运营
 * All namespaces share the same meta shape, registry merge point and routing
 * tables（整合设计：单一生成数据层 + 单一注册表 + 单一路由表）.
 */
const EXPERT_ALT = '(?:BK-\\d+|BANK-\\d+|S-\\d+|E\\d+-[\\w-]+|XHS-\\d+)'

/** Roster data row: `| BK-004 | 邢自强 | 宏观周期派 X 首席 | … |` (any namespace). */
const ROSTER_ROW = new RegExp(`^\\| (${EXPERT_ALT}) \\| ([^|]+) \\| ([^|]+) \\| ([^|]*) \\| ([^|]*) \\| ([^|]*) \\| ([^|]*) \\|$`)

/** Flattened Profile file name: `<真实姓名>_专家Profile_BK-NNN.json` (any namespace). */
const PROFILE_FILE = new RegExp(`^(.+)_专家Profile_(${EXPERT_ALT})\\.json$`)

/**
 * 专家 id → 命名空间（供 stampExperts 自动打戳）：
 * BK→bk、BANK→bank、S→s、E<域>-* → e<域>（e01/e08/e13…）、XHS→xhs、其余 → 前缀小写。
 */
export function namespaceOfExpertId(expertId) {
  const m = /^([A-Za-z]+\d*)/.exec(expertId ?? '')
  if (m === null) return 'other'
  return m[1].toLowerCase()
}

/** Whether a value is a plain record. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** SHA-256 hex digest of raw bytes. */
function sha256Of(content) {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Parse the roster table (专家总表.md) into a BK → row map.
 * Throws for structurally invalid rows (never silently skips a row the regex
 * cannot read); the thrown object carries `code: 'duplicate-roster-row'`.
 */
export function parseRoster(text) {
  const roster = new Map()
  let currentField = ''
  const lines = text.split('\n')
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim()
    const header = line.match(ROSTER_HEADER)
    if (header !== null) {
      currentField = (header[1] ?? header[2]).trim()
      continue
    }
    const m = line.match(ROSTER_ROW)
    if (m === null) continue
    const [, bk, name, personaName, stance, secondaryField, tags, summary] = m.map(part => part.trim())
    if (roster.has(bk)) {
      const error = new Error(`专家总表.md line ${index + 1}: BK id ${bk} appears more than once`)
      error.code = 'duplicate-roster-row'
      throw error
    }
    roster.set(bk, { bk, name, personaName, field: currentField, stance, secondaryField, tags, summary })
  }
  return roster
}

/**
 * Parse one Profile JSON record (shared by both layouts). `realName` is the
 * authoritative real name from the surrounding location (material dir name
 * in the zip layout, file-name prefix in the pack layout). `locatedBk` is the
 * BK id implied by the location when known (pack layout); the zip layout
 * leaves it `undefined` and trusts the Profile's own `expert_id`, which the
 * roster cross-check then validates.
 */
function buildProfile(errors, locatedBk, realName, fileName, sourcePath, content) {
  let parsed
  try {
    parsed = JSON.parse(content.toString('utf8'))
  } catch (error) {
    errors.push({ code: 'profile-parse', message: `${sourcePath}: Profile JSON is not parseable: ${String(error)}` })
    return undefined
  }
  if (!isRecord(parsed)) {
    errors.push({ code: 'profile-parse', message: `${sourcePath}: Profile JSON must be a JSON object` })
    return undefined
  }
  const data = parsed
  const expertId = typeof data.expert_id === 'string' ? data.expert_id : undefined
  const effectiveBk = expertId ?? fileName.match(/BK-(\d+)/)?.[0]
  if (effectiveBk === undefined) {
    errors.push({ code: 'profile-without-bk', message: `${sourcePath}: no expert_id and no BK id in the file name` })
    return undefined
  }
  if (locatedBk !== undefined && effectiveBk !== locatedBk) {
    errors.push({ code: 'profile-bk-mismatch', message: `${sourcePath}: expert_id ${effectiveBk} does not match the located BK id ${locatedBk}` })
    return undefined
  }
  return {
    bk: effectiveBk,
    realName,
    fileName,
    sourcePath,
    sha256: sha256Of(content),
    data,
  }
}

/**
 * Parse the whole 智见点评 source and build the expert metas.
 *
 * Returns `{ ok, errors, layout, root, roster, profiles, experts }`; `ok` is
 * true only when `errors` is empty. Only unexpected I/O errors propagate.
 */
export async function parseZhijianSource(src) {
  const errors = []

  // ── layout detection ──────────────────────────────────────────────────────
  const zipParentRoster = join(src, '智见点评', '专家总表.md')
  const zipRootRoster = join(src, '专家总表.md')
  const packRoster = join(src, 'docs', '专家总表.md')
  let layout
  let root
  let rosterPath
  if (await fileExists(zipParentRoster)) {
    layout = 'zip'
    root = join(src, '智见点评')
    rosterPath = zipParentRoster
  } else if (await fileExists(zipRootRoster)) {
    layout = 'zip'
    root = src
    rosterPath = zipRootRoster
  } else if (await fileExists(packRoster)) {
    layout = 'pack'
    root = src
    rosterPath = packRoster
  } else {
    errors.push({
      code: 'source-layout-unknown',
      message: `cannot detect a 智见点评 source at "${src}" (looked for ${zipParentRoster}, ${zipRootRoster}, ${packRoster})`,
    })
    return { ok: false, errors, layout: 'zip', root: '', roster: new Map(), profiles: new Map(), experts: [] }
  }

  // ── roster ────────────────────────────────────────────────────────────────
  let roster
  try {
    roster = parseRoster(await readFile(rosterPath, 'utf8'))
  } catch (error) {
    if (error.code === 'duplicate-roster-row') {
      errors.push({ code: 'duplicate-roster-row', message: error.message })
      return { ok: false, errors, layout, root, roster: new Map(), profiles: new Map(), experts: [] }
    }
    errors.push({ code: 'roster-read', message: `cannot read roster ${rosterPath}: ${String(error)}` })
    return { ok: false, errors, layout, roster: new Map(), profiles: new Map(), experts: [] }
  }
  if (roster.size === 0) {
    errors.push({ code: 'roster-empty', message: `roster ${rosterPath} parsed to zero rows` })
  }

  // ── profiles ──────────────────────────────────────────────────────────────
  const profiles = new Map()
  const seenBk = new Set()

  if (layout === 'zip') {
    const materialRoot = join(root, '专家材料')
    let dirs
    try {
      dirs = (await readdir(materialRoot, { withFileTypes: true })).map(entry => entry.name)
    } catch (error) {
      errors.push({ code: 'material-missing', message: `cannot list 专家材料 at ${materialRoot}: ${String(error)}` })
      return { ok: false, errors, layout, roster, profiles, experts: [] }
    }
    for (const dirName of dirs.sort()) {
      const dir = join(materialRoot, dirName)
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue // not a directory
      }
      const profileEntries = entries.filter(e => /_专家Profile_BK-\d+\.json$/.test(e.name))
      if (profileEntries.length > 1) {
        errors.push({ code: 'profile-ambiguous', message: `${dir}: multiple Profile JSONs in one material dir` })
        continue
      }
      if (profileEntries.length === 0) {
        errors.push({ code: 'dir-without-profile', message: `${dir}: material dir without a Profile JSON` })
        continue
      }
      const file = join(dir, profileEntries[0].name)
      let content
      try {
        content = await readFile(file)
      } catch (error) {
        errors.push({ code: 'profile-read', message: `${file}: cannot read: ${String(error)}` })
        continue
      }
      // Zip layout: the dir name is the real name; the BK id comes from the
      // Profile's expert_id and is validated against the roster below.
      const record = buildProfile(errors, undefined, dirName, profileEntries[0].name, file, content)
      if (record === undefined) continue
      if (seenBk.has(record.bk)) {
        errors.push({ code: 'duplicate-profile', message: `${file}: BK id ${record.bk} appears in more than one material dir` })
        continue
      }
      seenBk.add(record.bk)
      profiles.set(record.bk, record)
    }
  } else {
    // pack layout: flat raw-profiles, file name carries <真实姓名>_专家Profile_BK-NNN
    const rawRoot = join(root, 'raw-profiles')
    let files
    try {
      files = await readdir(rawRoot)
    } catch (error) {
      errors.push({ code: 'raw-profiles-missing', message: `cannot list raw-profiles at ${rawRoot}: ${String(error)}` })
      return { ok: false, errors, layout, roster, profiles, experts: [] }
    }
    for (const fileName of files.filter(f => f.endsWith('.json')).sort()) {
      const m = fileName.match(PROFILE_FILE)
      if (m === null) {
        errors.push({ code: 'unexpected-raw-profile', message: `${join(rawRoot, fileName)}: file name does not match <真实姓名>_专家Profile_BK-NNN.json` })
        continue
      }
      const realName = m[1]
      const bk = m[2]
      const file = join(rawRoot, fileName)
      let content
      try {
        content = await readFile(file)
      } catch (error) {
        errors.push({ code: 'profile-read', message: `${file}: cannot read: ${String(error)}` })
        continue
      }
      const record = buildProfile(errors, bk, realName, fileName, file, content)
      if (record === undefined) continue
      if (seenBk.has(bk)) {
        errors.push({ code: 'duplicate-profile', message: `${file}: BK id ${bk} appears more than once` })
        continue
      }
      seenBk.add(bk)
      profiles.set(bk, record)
    }
  }

  // ── cross checks: roster ⇄ profiles (fatal) ───────────────────────────────
  for (const bk of [...roster.keys()].sort()) {
    const record = profiles.get(bk)
    const row = roster.get(bk)
    if (row === undefined) continue
    if (record === undefined) {
      errors.push({ code: 'roster-without-profile', message: `roster row ${bk} (${row.name}) has no Profile JSON` })
      continue
    }
    if (record.realName !== row.name) {
      errors.push({ code: 'name-mismatch', message: `BK ${bk}: real name "${record.realName}" (${record.sourcePath}) does not match roster name "${row.name}"` })
    }
    const personaName = typeof record.data.name === 'string' ? record.data.name : undefined
    if (personaName !== row.personaName) {
      errors.push({ code: 'persona-name-mismatch', message: `BK ${bk}: Profile persona name "${personaName ?? '(missing)'}" does not match roster persona name "${row.personaName}"` })
    }
  }
  for (const bk of [...profiles.keys()].sort()) {
    if (!roster.has(bk)) {
      errors.push({ code: 'profile-without-roster', message: `Profile ${profiles.get(bk)?.sourcePath} (${bk}) has no roster row` })
    }
  }

  // ── build metas (identical construction to the historic generator) ────────
  const experts = []
  for (const bk of [...profiles.keys()].sort()) {
    const record = profiles.get(bk)
    const row = roster.get(bk)
    if (record === undefined || row === undefined) continue
    const p = record.data
    const persona = isRecord(p.persona) ? p.persona : undefined
    const method = isRecord(p.method) ? p.method : undefined
    const classification = isRecord(p.classification) ? p.classification : undefined

    const style = Array.isArray(persona?.style)
      ? persona.style.map(item => String(item))
      : typeof persona?.style === 'string'
        ? [persona.style]
        : []
    const mentalModels = Array.isArray(method?.frameworks)
      ? method.frameworks.map(f => String(f))
      : []
    const analysisSteps = Array.isArray(method?.analysis_steps)
      ? method.analysis_steps.map(s => String(s))
      : []

    // 1.1.0 rich detail: only present source sections are carried (absent stays
    // absent — no fabrication). Deterministic: same source ⇒ same fields.
    const personaDetail = extractPersonaDetail(p)
    const methodDetail = extractMethodDetail(p)
    const emm = extractEmm(p)
    const constraints = extractConstraints(p)
    const outputSchema = extractOutputSchema(p)

    experts.push({
      id: bk.toLowerCase(),
      bk,
      name: row.name,
      personaName: row.personaName,
      field: row.field,
      ...(row.secondaryField && row.secondaryField !== '—' ? { secondaryField: row.secondaryField } : {}),
      stance: row.stance || '',
      tags: row.tags ? row.tags.split('/').map(t => t.trim()).filter(Boolean) : [],
      summary: row.summary || '',
      initials: String(p.initials ?? classification?.initials ?? ''),
      style,
      mentalModels,
      signaturePhrases: Array.isArray(p.signature_phrases) ? p.signature_phrases.map(s => String(s)) : [],
      antiPatterns: Array.isArray(p.anti_patterns) ? p.anti_patterns.map(s => String(s)) : [],
      analysisSteps,
      ...(DECEASED.has(bk) ? { deceased: true } : {}),
      ...(personaDetail !== undefined ? { personaDetail } : {}),
      ...(methodDetail !== undefined ? { methodDetail } : {}),
      ...(emm !== undefined ? { emm } : {}),
      ...(constraints !== undefined ? { constraints } : {}),
      ...(outputSchema !== undefined ? { outputSchema } : {}),
    })
  }

  experts.sort((a, b) => a.bk.localeCompare(b.bk))

  return {
    ok: errors.length === 0,
    errors,
    layout,
    root,
    roster,
    profiles,
    experts,
  }
}

/**
 * Rich-field extraction (1.1.0): conservatively lift the raw Profile JSON
 * sections that the V1 metas never carried into the meta as optional grouped
 * detail objects — `personaDetail` / `methodDetail` / `emm` / `constraints` /
 * `outputSchema`. Only fields present in the source are emitted (absent stays
 * absent); everything is a verbatim camelCase projection, never invented.
 */

/** String array helper: only present, non-empty arrays of strings. */
function pickStrings(value) {
  if (!Array.isArray(value)) return undefined
  const out = value.map(item => String(item)).filter(s => s !== '')
  return out.length > 0 ? out : undefined
}

/** `persona.{tone,bias,values,taste,voice,cognition,blindSpots}` → detail object. */
function extractPersonaDetail(p) {
  const persona = isRecord(p.persona) ? p.persona : undefined
  if (persona === undefined) return undefined
  const out = {}
  if (typeof persona.tone === 'string' && persona.tone !== '') out.tone = persona.tone
  const bias = pickStrings(persona.bias)
  if (bias !== undefined) out.bias = bias

  const values = isRecord(persona.values) ? persona.values : undefined
  if (values !== undefined) {
    const v = {}
    const excites = pickStrings(values.excites)
    if (excites !== undefined) v.excites = excites
    const irritates = pickStrings(values.irritates)
    if (irritates !== undefined) v.irritates = irritates
    if (typeof values.qualityBar === 'string' && values.qualityBar !== '') v.qualityBar = values.qualityBar
    const dealbreakers = pickStrings(values.dealbreakers)
    if (dealbreakers !== undefined) v.dealbreakers = dealbreakers
    if (Object.keys(v).length > 0) out.values = v
  }

  const taste = isRecord(persona.taste) ? persona.taste : undefined
  if (taste !== undefined) {
    const t = {}
    const admires = pickStrings(taste.admires)
    if (admires !== undefined) t.admires = admires
    const disdains = pickStrings(taste.disdains)
    if (disdains !== undefined) t.disdains = disdains
    if (typeof taste.benchmark === 'string' && taste.benchmark !== '') t.benchmark = taste.benchmark
    if (Object.keys(t).length > 0) out.taste = t
  }

  const voice = isRecord(persona.voice) ? persona.voice : undefined
  if (voice !== undefined) {
    const v = {}
    if (typeof voice.disagreementStyle === 'string' && voice.disagreementStyle !== '') v.disagreementStyle = voice.disagreementStyle
    if (typeof voice.praiseStyle === 'string' && voice.praiseStyle !== '') v.praiseStyle = voice.praiseStyle
    if (Object.keys(v).length > 0) out.voice = v
  }

  const cognition = isRecord(persona.cognition) ? persona.cognition : undefined
  if (cognition !== undefined) {
    const c = {}
    if (typeof cognition.mentalModel === 'string' && cognition.mentalModel !== '') c.mentalModel = cognition.mentalModel
    if (Array.isArray(cognition.mentalModels)) {
      const models = cognition.mentalModels
        .filter(item => isRecord(item) && typeof item.name === 'string' && item.name !== '')
        .map(item => {
          const model = { name: item.name }
          if (typeof item.summary === 'string' && item.summary !== '') model.summary = item.summary
          const evidence = pickStrings(item.evidence)
          if (evidence !== undefined) model.evidence = evidence
          if (typeof item.applicationContext === 'string' && item.applicationContext !== '') model.applicationContext = item.applicationContext
          if (typeof item.failureCondition === 'string' && item.failureCondition !== '') model.failureCondition = item.failureCondition
          return model
        })
      if (models.length > 0) c.mentalModels = models
    }
    if (typeof cognition.decisionStyle === 'string' && cognition.decisionStyle !== '') c.decisionStyle = cognition.decisionStyle
    if (typeof cognition.riskAttitude === 'string' && cognition.riskAttitude !== '') c.riskAttitude = cognition.riskAttitude
    if (typeof cognition.timeHorizon === 'string' && cognition.timeHorizon !== '') c.timeHorizon = cognition.timeHorizon
    if (Object.keys(c).length > 0) out.cognition = c
  }

  const blindSpots = isRecord(persona.blindSpots) ? persona.blindSpots : undefined
  if (blindSpots !== undefined) {
    const b = {}
    const knownBias = pickStrings(blindSpots.knownBias)
    if (knownBias !== undefined) b.knownBias = knownBias
    const weakDomains = pickStrings(blindSpots.weakDomains)
    if (weakDomains !== undefined) b.weakDomains = weakDomains
    if (typeof blindSpots.selfAwareness === 'string' && blindSpots.selfAwareness !== '') b.selfAwareness = blindSpots.selfAwareness
    if (typeof blindSpots.confidenceThreshold === 'string' && blindSpots.confidenceThreshold !== '') b.confidenceThreshold = blindSpots.confidenceThreshold
    if (Object.keys(b).length > 0) out.blindSpots = b
  }

  return Object.keys(out).length > 0 ? out : undefined
}

/** `method.{reviewLens,dataPreference,evidenceStandard,agenticProtocol}` → detail object. */
function extractMethodDetail(p) {
  const method = isRecord(p.method) ? p.method : undefined
  if (method === undefined) return undefined
  const out = {}

  const reviewLens = method.reviewLens
  if (typeof reviewLens === 'string' && reviewLens !== '') {
    // 陈杰 BK-034 carries reviewLens as a plain string — keep it verbatim.
    out.reviewLens = reviewLens
  } else if (isRecord(reviewLens)) {
    const r = {}
    if (typeof reviewLens.firstGlance === 'string' && reviewLens.firstGlance !== '') r.firstGlance = reviewLens.firstGlance
    const deepDive = pickStrings(reviewLens.deepDive)
    if (deepDive !== undefined) r.deepDive = deepDive
    if (typeof reviewLens.killShot === 'string' && reviewLens.killShot !== '') r.killShot = reviewLens.killShot
    const bonusPoints = pickStrings(reviewLens.bonusPoints)
    if (bonusPoints !== undefined) r.bonusPoints = bonusPoints
    if (Object.keys(r).length > 0) out.reviewLens = r
  }
  if (typeof method.dataPreference === 'string' && method.dataPreference !== '') out.dataPreference = method.dataPreference
  if (typeof method.evidenceStandard === 'string' && method.evidenceStandard !== '') out.evidenceStandard = method.evidenceStandard

  const agenticProtocol = isRecord(method.agenticProtocol) ? method.agenticProtocol : undefined
  if (agenticProtocol !== undefined) {
    const a = {}
    if (typeof agenticProtocol.requiresResearch === 'boolean') a.requiresResearch = agenticProtocol.requiresResearch
    const researchSteps = pickStrings(agenticProtocol.researchSteps)
    if (researchSteps !== undefined) a.researchSteps = researchSteps
    if (typeof agenticProtocol.noGuessPolicy === 'boolean') a.noGuessPolicy = agenticProtocol.noGuessPolicy
    if (Object.keys(a).length > 0) out.agenticProtocol = a
  }

  return Object.keys(out).length > 0 ? out : undefined
}

/** `emm{critical_factors,factor_hierarchy,veto_rules,aggregation_logic}` → detail object. */
function extractEmm(p) {
  const emm = isRecord(p.emm) ? p.emm : undefined
  if (emm === undefined) return undefined
  const out = {}
  const criticalFactors = pickStrings(emm.critical_factors)
  if (criticalFactors !== undefined) out.criticalFactors = criticalFactors
  const factorHierarchy = isRecord(emm.factor_hierarchy) ? emm.factor_hierarchy : undefined
  if (factorHierarchy !== undefined) {
    const fh = {}
    for (const [key, value] of Object.entries(factorHierarchy)) {
      if (typeof value === 'number' && Number.isFinite(value)) fh[key] = value
    }
    if (Object.keys(fh).length > 0) out.factorHierarchy = fh
  }
  const vetoRules = pickStrings(emm.veto_rules)
  if (vetoRules !== undefined) out.vetoRules = vetoRules
  if (typeof emm.aggregation_logic === 'string' && emm.aggregation_logic !== '') out.aggregationLogic = emm.aggregation_logic
  return Object.keys(out).length > 0 ? out : undefined
}

/** `constraints{must_conclude,allow_assumption}` → detail object. */
function extractConstraints(p) {
  const constraints = isRecord(p.constraints) ? p.constraints : undefined
  if (constraints === undefined) return undefined
  const out = {}
  if (typeof constraints.must_conclude === 'boolean') out.mustConclude = constraints.must_conclude
  if (typeof constraints.allow_assumption === 'boolean') out.allowAssumption = constraints.allow_assumption
  return Object.keys(out).length > 0 ? out : undefined
}

/** `output_schema{format,sections,rubrics}` → detail object (rubrics: strings or {dimension,levels}). */
function extractOutputSchema(p) {
  const schema = isRecord(p.output_schema) ? p.output_schema : undefined
  if (schema === undefined) return undefined
  const out = {}
  if (typeof schema.format === 'string' && schema.format !== '') out.format = schema.format
  const sections = pickStrings(schema.sections)
  if (sections !== undefined) out.sections = sections
  if (Array.isArray(schema.rubrics)) {
    const rubrics = schema.rubrics
      .map(rubric => {
        if (typeof rubric === 'string') return rubric
        if (isRecord(rubric)) {
          const r = {}
          if (typeof rubric.dimension === 'string' && rubric.dimension !== '') r.dimension = rubric.dimension
          if (Array.isArray(rubric.levels)) {
            const levels = rubric.levels
              .filter(level => isRecord(level))
              .map(level => {
                const l = {}
                if (typeof level.score === 'number' && Number.isFinite(level.score)) l.score = level.score
                if (typeof level.description === 'string' && level.description !== '') l.description = level.description
                return l
              })
            if (levels.length > 0) r.levels = levels
          }
          return Object.keys(r).length > 0 ? r : undefined
        }
        return undefined
      })
      .filter(rubric => rubric !== undefined)
    if (rubrics.length > 0) out.rubrics = rubrics
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Whether a path exists as a regular file. */
async function fileExists(path) {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/**
 * P1.5: 给解析出的专家 meta 打上 provenance 戳（命名空间/数据版本/来源）。
 * 确定性：同一输入 ⇒ 同一输出。BK 与 BANK 两个构建脚本共用此函数，保证
 * 「解析源 → 打戳 → 生成 TS / 发射领域包」全链路一致（lib 与源永不 lib-stale）。
 */
export function stampExperts(experts, stamp) {
  const { namespace, version, origin, material } = stamp
  // namespace 可为函数（按专家 id 前缀逐人推导，如 pipeline E08→e08/S→s）。
  const nsOf = typeof namespace === 'function' ? namespace : () => namespace
  return experts.map(meta => ({
    ...meta,
    namespace: nsOf(meta.bk ?? meta.id),
    version,
    source: {
      origin,
      ...(material === undefined ? {} : { material }),
    },
  }))
}

/**
 * Emit the generated TypeScript module for `src/zhijian/data/experts.generated.ts`.
 * Deterministic: same metas ⇒ same bytes.
 */
export function emitExpertsTs(experts) {
  return `/**
 * GENERATED FILE — do not edit by hand.
 * Built by scripts/build-zhijian-data.mjs from the 智见点评 skill package
 * (${experts.length} expert Profile JSONs + 专家总表.md). Regenerate after skill updates.
 */
import type { ZhijianExpertMeta } from '../types.ts'

export const ZHIJIAN_EXPERTS: readonly ZhijianExpertMeta[] = ${JSON.stringify(experts, null, 2)}
`
}
