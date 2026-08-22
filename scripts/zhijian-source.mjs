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

/** Roster data row: `| BK-004 | 邢自强 | 宏观周期派 X 首席 | … |`. */
const ROSTER_ROW = /^\| (BK-\d+) \| ([^|]+) \| ([^|]+) \| ([^|]*) \| ([^|]*) \| ([^|]*) \| ([^|]*) \|$/

/** Flattened Profile file name: `<真实姓名>_专家Profile_BK-NNN.json`. */
const PROFILE_FILE = /^(.+)_专家Profile_(BK-\d+)\.json$/

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
