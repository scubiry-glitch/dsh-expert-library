/**
 * zyt (政研通) provider — pure declarations, request planning and
 * output normalization (Phase 2 `provider-zyt`; NEXT-GENERATION-ARCHITECTURE.md
 * §5.2).
 *
 * This module is JSON-safe and performs **no I/O**. It provides:
 * - {@link buildZytRequestPlan}: the CLI-argv → HTTP request-plan parser,
 *   ported 1:1 from the upstream `buildRequestPlan` contract (both the Python
 *   `python/zyt/request_plan.py` and TypeScript `packages/ts-cli` sources
 *   export the identical contract; `tests/contract/cases.json` + golden plans
 *   pin our port in the offline test suite). Chinese and English subcommands
 *   and long-option aliases are accepted.
 * - {@link zytPlanFromOperation}: capability operation + JSON input → the same
 *   request-plan shape, used by the Host invoker.
 * - {@link zytCliArgvFromPlan} / {@link zytHttpRequestFromPlan}: plan → CLI
 *   argv / HTTP request, so the same plan drives either transport.
 * - {@link normalizeZytCliOutput} / {@link normalizeZytHttpOutput}: raw CLI
 *   (exit codes 0/1/2/3) or HTTP (status) output → {@link ProviderEnvelope},
 *   preserving `dataView` caliber (internal = absolute, external = indexed,
 *   first value 100 — never an absolute) and units.
 * - {@link buildZytManifest}: `http-api` transport (direct `/openapi/v1/*`)
 *   plus an optional `local-cli` transport when a `zyt` binary is configured.
 *
 * Live HTTP checks verified catalog, Beijing SH_VOL series, and two-city
 * SH_VOL compare in the internal view; external-license view still needs its
 * own account-level acceptance check.
 * @module dsh-expert-library/v2/providers/zyt
 */

import {
  failEnvelope,
  normalizeZytEnvelope,
  type ProviderEnvelope,
  type ProvenanceInput,
  type ZytNormalizeOptions,
} from '../provider-runtime.ts'
import type { ToolCapability, ToolProviderManifest, ToolTransport } from '../types.ts'
import { SCHEMA_VERSION } from '../types.ts'

/* ------------------------------------------------------------------ *
 *  Request plan contract (mirrors upstream `buildRequestPlan`).
 * ------------------------------------------------------------------ */

/** One zyt request plan — the exact shape the upstream CLI exports. */
export interface ZytRequestPlan {
  readonly command: string
  readonly method?: string
  readonly path?: string
  readonly query?: Readonly<Record<string, string>>
  readonly body?: unknown
  readonly local?: boolean
  readonly action?: string
}

/** Value-taking long-option aliases → canonical query keys. */
const VALUE_FLAGS: Readonly<Record<string, string>> = {
  '--city': 'city', '--城市': 'city',
  '--code': 'code', '--指标': 'code',
  '--cities': 'cities', '--城市列表': 'cities',
  '--period': 'period', '--月份': 'period',
  '--ym': 'ym', '--年月': 'ym',
  '--period-end': 'periodEnd', '--截止月': 'periodEnd',
  '--limit': 'limit', '--期数': 'limit',
  '--granularity': 'granularity', '--粒度': 'granularity',
  '--district': 'district', '--行政区': 'district',
  '--bizcircle': 'bizcircle', '--商圈': 'bizcircle',
  '--community': 'community', '--小区': 'community',
  '--caliber': 'caliber', '--口径': 'caliber',
  '--geo-id': 'geoId', '--地理编码': 'geoId',
  '--q': 'q', '--query': 'q', '--关键词': 'q',
  '--category': 'category', '--分类': 'category',
  '--queries': 'queries', '--查询': 'queries',
  '--queries-file': 'queriesFile', '--查询文件': 'queriesFile',
  '--key': 'key', '--api-key': 'apiKey', '--base-url': 'baseUrl',
}

/** Boolean flags → canonical query keys with value `'1'`. */
const BOOL_FLAGS: Readonly<Record<string, readonly [string, string]>> = {
  '--include-peers': ['includePeers', '1'],
  '--含同级': ['includePeers', '1'],
  '--include-city-ref': ['includeCityRef', '1'],
  '--含城市基准': ['includeCityRef', '1'],
}

/** Global flags stripped by {@link splitZytArgv} (values consumed). */
const GLOBAL_VALUE_FLAGS = new Set(['--base-url', '--api-key'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Split argv into command tokens and option args (upstream `split_argv`). */
export function splitZytArgv(argv: readonly string[]): { readonly tokens: string[]; readonly optArgs: string[] } {
  const tokens: string[] = []
  const optArgs: string[] = []
  let i = 0
  while (i < argv.length) {
    const a = argv[i]!
    if (a === '--json') {
      i += 1
      continue
    }
    if (GLOBAL_VALUE_FLAGS.has(a)) {
      i += 2
      continue
    }
    if (a.startsWith('--base-url=') || a.startsWith('--api-key=')) {
      i += 1
      continue
    }
    if (a.startsWith('-')) {
      optArgs.push(a)
      if (a in BOOL_FLAGS) {
        i += 1
        continue
      }
      const flag = a.split('=', 1)[0]!
      if (!a.includes('=') && flag in VALUE_FLAGS) {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          optArgs.push(next)
          i += 2
          continue
        }
      }
      i += 1
      continue
    }
    tokens.push(a)
    i += 1
  }
  return { tokens, optArgs }
}

/** Parse option args into canonical keys (upstream `parse_opts`). */
export function parseZytOpts(optArgs: readonly string[]): Record<string, string> {
  const opts: Record<string, string> = {}
  let i = 0
  while (i < optArgs.length) {
    const a = optArgs[i]!
    const bool = BOOL_FLAGS[a]
    if (bool !== undefined) {
      opts[bool[0]] = bool[1]
      i += 1
      continue
    }
    if (a.includes('=') && a.startsWith('--')) {
      const eq = a.indexOf('=')
      const flag = a.slice(0, eq)
      const key = VALUE_FLAGS[flag]
      if (key !== undefined) opts[key] = a.slice(eq + 1)
      i += 1
      continue
    }
    const key = VALUE_FLAGS[a]
    if (key !== undefined) {
      const next = optArgs[i + 1]
      opts[key] = next !== undefined ? next : ''
      i += 2
      continue
    }
    i += 1
  }
  return opts
}

function queryOf(entries: ReadonlyArray<readonly [string, string | undefined]>): Record<string, string> {
  const q: Record<string, string> = {}
  for (const [k, v] of entries) {
    if (v !== undefined && v !== '') q[k] = v
  }
  return q
}

function requireCity(opts: Record<string, string>): string {
  const city = opts['city']
  if (!city) throw new Error('缺少必填参数 city/城市')
  return city
}

function requireYm(opts: Record<string, string>): string {
  const ym = opts['ym']
  if (!ym) throw new Error('缺少必填参数 ym/年月（格式 YYYYMM）')
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(ym)) throw new Error('ym/年月格式错误，应为 YYYYMM（如 202609）')
  return ym
}

function requireKey(opts: Record<string, string>, key: string, label: string): string {
  const value = opts[key]
  if (!value) throw new Error(`缺少必填参数 ${key}/${label}`)
  return value
}

/** Python `urllib.parse.quote(s, safe='')`-shaped encoding for path ids. */
function quotePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, char =>
    '%' + char.charCodeAt(0).toString(16).toUpperCase())
}

function seriesPlan(opts: Record<string, string>): ZytRequestPlan {
  return {
    command: '指标时序',
    method: 'GET',
    path: '/openapi/v1/indicators/series',
    query: queryOf([
      ['city', requireCity(opts)],
      ['code', requireKey(opts, 'code', '指标')],
      ['granularity', opts['granularity']],
      ['district', opts['district']],
      ['bizcircle', opts['bizcircle']],
      ['community', opts['community']],
      ['periodEnd', opts['periodEnd']],
      ['limit', opts['limit']],
      ['caliber', opts['caliber']],
    ]),
    body: null,
  }
}

function batchPlan(opts: Record<string, string>): ZytRequestPlan {
  const city = requireCity(opts)
  const raw = opts['queries']
  if (!raw) throw new Error('缺少必填参数 queries/查询（或先由 CLI 展开 --queries-file）')
  let queries: unknown
  try {
    queries = JSON.parse(raw)
  } catch {
    throw new Error('queries/查询 必须是合法 JSON 数组')
  }
  const body: Record<string, unknown> = { city, queries }
  if (opts['periodEnd'] !== undefined) body['periodEnd'] = opts['periodEnd']
  if (opts['limit'] !== undefined) body['limit'] = Number(opts['limit'])
  return { command: '批量时序', method: 'POST', path: '/openapi/v1/indicators/batch-series', query: {}, body }
}

function comparePlan(opts: Record<string, string>): ZytRequestPlan {
  return {
    command: '多城对比',
    method: 'GET',
    path: '/openapi/v1/indicators/compare',
    query: queryOf([
      ['cities', requireKey(opts, 'cities', '城市列表')],
      ['code', opts['code']],
      ['period', opts['period']],
    ]),
    body: null,
  }
}

function scopePlan(opts: Record<string, string>): ZytRequestPlan {
  return {
    command: '地理数据包',
    method: 'GET',
    path: '/openapi/v1/geo/scope-bundle',
    query: queryOf([
      ['city', requireCity(opts)],
      ['geoId', opts['geoId']],
      ['periodEnd', opts['periodEnd']],
      ['includePeers', opts['includePeers']],
      ['includeCityRef', opts['includeCityRef']],
    ]),
    body: null,
  }
}

function geoSeriesPlan(opts: Record<string, string>): ZytRequestPlan {
  return {
    command: '地理时序',
    method: 'GET',
    path: '/openapi/v1/geo/series',
    query: queryOf([
      ['city', requireCity(opts)],
      ['code', opts['code']],
      ['key', opts['key']],
      ['granularity', opts['granularity']],
      ['district', opts['district']],
      ['bizcircle', opts['bizcircle']],
      ['community', opts['community']],
      ['periodEnd', opts['periodEnd']],
      ['limit', opts['limit']],
    ]),
    body: null,
  }
}

function geoSearchPlan(opts: Record<string, string>): ZytRequestPlan {
  return {
    command: '地理搜索',
    method: 'GET',
    path: '/openapi/v1/geo/search',
    query: queryOf([
      ['city', requireCity(opts)],
      ['q', requireKey(opts, 'q', '关键词')],
    ]),
    body: null,
  }
}

function districtsPlan(opts: Record<string, string>): ZytRequestPlan {
  return {
    command: '行政区分布',
    method: 'GET',
    path: '/openapi/v1/districts',
    query: queryOf([
      ['city', requireCity(opts)],
      ['code', opts['code']],
      ['period', opts['period']],
    ]),
    body: null,
  }
}

function marketPlan(opts: Record<string, string>): ZytRequestPlan {
  return {
    command: '市场快照',
    method: 'GET',
    path: '/openapi/v1/market-snapshot',
    query: queryOf([
      ['city', requireCity(opts)],
      ['period', opts['period']],
    ]),
    body: null,
  }
}

function cityReportPlan(sub: string | undefined, opts: Record<string, string>): ZytRequestPlan {
  const routes: Readonly<Record<string, readonly [string, string]>> = {
    city: ['城市专报城市级', 'city'], 城市级: ['城市专报城市级', 'city'],
    area: ['城市专报面积结构', 'area'], 面积: ['城市专报面积结构', 'area'],
    district: ['城市专报城区级', 'district'], 城区: ['城市专报城区级', 'district'],
    'total-price': ['城市专报总价结构', 'total-price'], 总价: ['城市专报总价结构', 'total-price'],
  }
  const route = routes[sub ?? '']
  if (!route) throw new Error(`未知城市专报子命令: ${sub}（可选：city/area/district/total-price）`)
  return {
    command: route[0], method: 'GET', path: `/openapi/v1/city-report2026/${route[1]}`,
    query: queryOf([
      ['city', requireCity(opts)], ['ym', requireYm(opts)],
      ...(route[1] === 'district' ? [['district', opts['district']] as const] : []),
    ]),
    body: null,
  }
}

function creisPlan(sub: string | undefined, opts: Record<string, string>): ZytRequestPlan {
  const routes: Readonly<Record<string, readonly [string, string]>> = {
    'land-market': ['中指土地统计', 'land-market'], 土地统计: ['中指土地统计', 'land-market'],
    'land-transaction': ['中指土地明细', 'land-transaction'], 土地明细: ['中指土地明细', 'land-transaction'],
    'new-home-market': ['中指新房统计', 'new-home-market'], 新房统计: ['中指新房统计', 'new-home-market'],
    'new-home-project': ['中指新房项目', 'new-home-project'], 新房项目: ['中指新房项目', 'new-home-project'],
    'resale-market': ['中指二手统计', 'resale-market'], 二手统计: ['中指二手统计', 'resale-market'],
  }
  const route = routes[sub ?? '']
  if (!route) throw new Error(`未知中指子命令: ${sub}（可选：land-market/land-transaction/new-home-market/new-home-project/resale-market）`)
  return {
    command: route[0], method: 'GET', path: `/openapi/v1/creis/${route[1]}`,
    query: queryOf([
      ['city', requireCity(opts)],
      ...(route[1] === 'land-transaction' ? [] : [['ym', requireYm(opts)] as const]),
    ]),
    body: null,
  }
}

function reportDetailPlan(id: string | undefined): ZytRequestPlan {
  if (!id) throw new Error('缺少报告 id')
  return { command: '报告详情', method: 'GET', path: `/openapi/v1/reports/${quotePathSegment(id)}`, query: {}, body: null }
}

/**
 * Parse CLI argv (Chinese or English subcommands and aliases) into a
 * {@link ZytRequestPlan}, ported 1:1 from the upstream `buildRequestPlan`
 * contract. Throws on unknown commands / missing required args (the Host
 * invoker maps the error to a `correct-input` envelope).
 */
export function buildZytRequestPlan(argv: readonly string[]): ZytRequestPlan {
  const { tokens, optArgs } = splitZytArgv(argv)
  const opts = parseZytOpts(optArgs)
  if (tokens.length === 0) throw new Error('缺少命令')
  const t0 = tokens[0]!
  const t1 = tokens[1]

  if (t0 === '配置' || t0 === 'config') {
    const action = t1 === '设置' || t1 === 'set' ? 'set' : 'show'
    return { command: '配置', local: true, action }
  }
  if (t0 === '身份' || t0 === 'me') {
    return { command: '身份', method: 'GET', path: '/openapi/v1/me', query: {}, body: null }
  }
  if (t0 === 'indicators') {
    return indicatorsPlan(t1 ?? '', opts)
  }
  if (t0 === 'geo') {
    return geoPlan(t1 ?? '', opts)
  }
  if (t0 === 'reports') {
    return reportsPlan(tokens, opts)
  }
  if (t0 === 'policies' || t0 === '政策列表') {
    return { command: '政策列表', method: 'GET', path: '/openapi/v1/policies', query: queryOf([['city', opts['city']], ['category', opts['category']]]), body: null }
  }
  if (t0 === 'districts' || t0 === '行政区分布') {
    return districtsPlan(opts)
  }
  if (t0 === 'market-snapshot' || t0 === '市场快照') {
    return marketPlan(opts)
  }
  if (t0 === 'city-report2026' || t0 === '城市专报') {
    return cityReportPlan(t1, opts)
  }
  if (t0 === 'creis' || t0 === '中指') {
    return creisPlan(t1, opts)
  }

  switch (t0) {
    case '指标目录':
      return { command: '指标目录', method: 'GET', path: '/openapi/v1/indicators/catalog', query: {}, body: null }
    case '指标时序':
      return seriesPlan(opts)
    case '批量时序':
      return batchPlan(opts)
    case '多城对比':
      return comparePlan(opts)
    case '地理数据包':
      return scopePlan(opts)
    case '地理时序':
      return geoSeriesPlan(opts)
    case '地理树':
      return { command: '地理树', method: 'GET', path: '/openapi/v1/geo/tree', query: queryOf([['city', requireCity(opts)]]), body: null }
    case '地理搜索':
      return geoSearchPlan(opts)
    case '报告列表':
      return { command: '报告列表', method: 'GET', path: '/openapi/v1/reports', query: queryOf([['city', opts['city']], ['period', opts['period']]]), body: null }
    case '报告详情':
      return reportDetailPlan(t1)
    default:
      throw new Error(`未知命令: ${t0}`)
  }
}

function indicatorsPlan(sub: string, opts: Record<string, string>): ZytRequestPlan {
  switch (sub) {
    case 'catalog':
      return { command: '指标目录', method: 'GET', path: '/openapi/v1/indicators/catalog', query: {}, body: null }
    case 'series':
      return seriesPlan(opts)
    case 'batch-series':
      return batchPlan(opts)
    case 'compare':
      return comparePlan(opts)
    default:
      throw new Error(`未知 indicators 子命令: ${sub}`)
  }
}

function geoPlan(sub: string, opts: Record<string, string>): ZytRequestPlan {
  switch (sub) {
    case 'scope-bundle':
      return scopePlan(opts)
    case 'series':
      return geoSeriesPlan(opts)
    case 'tree':
      return { command: '地理树', method: 'GET', path: '/openapi/v1/geo/tree', query: queryOf([['city', requireCity(opts)]]), body: null }
    case 'search':
      return geoSearchPlan(opts)
    default:
      throw new Error(`未知 geo 子命令: ${sub}`)
  }
}

function reportsPlan(tokens: readonly string[], opts: Record<string, string>): ZytRequestPlan {
  const sub = tokens[1]
  if (sub === undefined || sub === 'list') {
    return { command: '报告列表', method: 'GET', path: '/openapi/v1/reports', query: queryOf([['city', opts['city']], ['period', opts['period']]]), body: null }
  }
  if (sub === 'get') {
    return reportDetailPlan(tokens[2])
  }
  return reportDetailPlan(sub)
}

/* ------------------------------------------------------------------ *
 *  Operation → plan (capability input, used by the Host invoker).
 * ------------------------------------------------------------------ */

/** Operation ids this provider serves, with the plan command they map to. */
export const ZYT_OPERATION_COMMANDS: Readonly<Record<string, string>> = {
  'zyt.auth.identity': '身份',
  'zyt.indicators.catalog': '指标目录',
  'zyt.indicators.series': '指标时序',
  'zyt.indicators.batch-series': '批量时序',
  'zyt.indicators.compare': '多城对比',
  'zyt.geo.search': '地理搜索',
  'zyt.reports.list': '报告列表',
  'zyt.policies.list': '政策列表',
  'zyt.market-snapshot': '市场快照',
  'zyt.city-report2026.city': '城市专报城市级',
  'zyt.city-report2026.area': '城市专报面积结构',
  'zyt.city-report2026.district': '城市专报城区级',
  'zyt.city-report2026.total-price': '城市专报总价结构',
  'zyt.creis.land-market': '中指土地统计',
  'zyt.creis.land-transaction': '中指土地明细',
  'zyt.creis.new-home-market': '中指新房统计',
  'zyt.creis.new-home-project': '中指新房项目',
  'zyt.creis.resale-market': '中指二手统计',
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Build the request plan for one provider operation from a JSON-safe input.
 * Input keys are the canonical query keys (`city`, `code`, `periodEnd`,
 * `limit`, `granularity`, `district`, `cities`, `q`, `category`, …); for
 * `batch-series` the input carries `queries` (array) plus optional
 * `periodEnd`/`limit`.
 */
export function zytPlanFromOperation(operation: string, input: unknown): ZytRequestPlan {
  const command = ZYT_OPERATION_COMMANDS[operation]
  if (command === undefined) throw new Error(`unknown zyt operation: ${operation}`)
  const o = isRecord(input) ? input : {}
  const opts: Record<string, string> = {}
  for (const key of Object.keys(o)) {
    // canonical query keys are strings; coerce numbers (e.g. batch `limit`)
    const value = key === 'cities' && Array.isArray(o[key])
      ? (o[key] as unknown[]).every(city => typeof city === 'string' && city.trim() !== '')
        ? (o[key] as string[]).join(',') : undefined
      : typeof o[key] === 'number' ? String(o[key]) : stringOf(o[key])
    if (value !== undefined) opts[key] = value
  }
  switch (command) {
    case '身份':
      return { command: '身份', method: 'GET', path: '/openapi/v1/me', query: {}, body: null }
    case '指标目录':
      return { command: '指标目录', method: 'GET', path: '/openapi/v1/indicators/catalog', query: {}, body: null }
    case '指标时序':
      return seriesPlan(opts)
    case '批量时序': {
      const raw = stringOf(o['queries']) ?? (Array.isArray(o['queries']) ? JSON.stringify(o['queries']) : undefined)
      if (raw === undefined) throw new Error('批量时序需要 queries（JSON 数组或 JSON 字符串）')
      const withQueries: Record<string, string> = { ...opts, queries: raw }
      return batchPlan(withQueries)
    }
    case '多城对比':
      return comparePlan(opts)
    case '地理搜索':
      return geoSearchPlan(opts)
    case '报告列表':
      return { command: '报告列表', method: 'GET', path: '/openapi/v1/reports', query: queryOf([['city', opts['city']], ['period', opts['period']]]), body: null }
    case '政策列表':
      return { command: '政策列表', method: 'GET', path: '/openapi/v1/policies', query: queryOf([['city', opts['city']], ['category', opts['category']]]), body: null }
    case '市场快照':
      return marketPlan(opts)
    case '城市专报城市级':
      return cityReportPlan('city', opts)
    case '城市专报面积结构':
      return cityReportPlan('area', opts)
    case '城市专报城区级':
      return cityReportPlan('district', opts)
    case '城市专报总价结构':
      return cityReportPlan('total-price', opts)
    case '中指土地统计':
      return creisPlan('land-market', opts)
    case '中指土地明细':
      return creisPlan('land-transaction', opts)
    case '中指新房统计':
      return creisPlan('new-home-market', opts)
    case '中指新房项目':
      return creisPlan('new-home-project', opts)
    case '中指二手统计':
      return creisPlan('resale-market', opts)
    default:
      // unreachable: command always comes from ZYT_OPERATION_COMMANDS
      throw new Error(`unknown zyt operation: ${operation}`)
  }
}

/* ------------------------------------------------------------------ *
 *  Plan → CLI argv / HTTP request.
 * ------------------------------------------------------------------ */

const QUERY_TO_FLAG: Readonly<Record<string, string>> = {
  city: '--city', code: '--code', cities: '--cities', period: '--period',
  periodEnd: '--period-end', limit: '--limit', granularity: '--granularity',
  ym: '--ym',
  district: '--district', bizcircle: '--bizcircle', community: '--community',
  caliber: '--caliber', geoId: '--geo-id', q: '--q', category: '--category',
  queries: '--queries',
}

/**
 * CLI argv for one plan (Chinese subcommand + canonical flags). The Host
 * invoker prepends the transport's static `['--json']` args. Local
 * (`配置`) plans are not invocable through the API — they return `[]`.
 */
export function zytCliArgvFromPlan(plan: ZytRequestPlan): string[] {
  if (plan.local === true) return []
  const compoundCommands: Readonly<Record<string, readonly [string, string]>> = {
    城市专报城市级: ['城市专报', '城市级'], 城市专报面积结构: ['城市专报', '面积'],
    城市专报城区级: ['城市专报', '城区'], 城市专报总价结构: ['城市专报', '总价'],
    中指土地统计: ['中指', '土地统计'], 中指土地明细: ['中指', '土地明细'],
    中指新房统计: ['中指', '新房统计'], 中指新房项目: ['中指', '新房项目'],
    中指二手统计: ['中指', '二手统计'],
  }
  const argv = [...(compoundCommands[plan.command] ?? [plan.command])]
  if (plan.command === '批量时序' && isRecord(plan.body)) {
    const body = plan.body as Record<string, unknown>
    if (typeof body['city'] === 'string') argv.push('--city', body['city'])
    if (body['queries'] !== undefined) argv.push('--queries', JSON.stringify(body['queries']))
    if (typeof body['periodEnd'] === 'string') argv.push('--period-end', body['periodEnd'])
    if (body['limit'] !== undefined) argv.push('--limit', String(body['limit']))
    return argv
  }
  if (plan.command === '报告详情') {
    const last = plan.path?.split('/').pop()
    if (last !== undefined && last !== '') argv.push(decodeURIComponent(last))
    return argv
  }
  for (const [key, value] of Object.entries(plan.query ?? {})) {
    const flag = QUERY_TO_FLAG[key]
    if (flag !== undefined && value !== '') argv.push(flag, value)
  }
  return argv
}

/** HTTP request derived from one plan against a base URL. */
export interface ZytHttpRequest {
  readonly method: string
  readonly url: string
  readonly body?: unknown
}

/**
 * Build the HTTP request (`method`, absolute `url` incl. query string, optional
 * JSON `body`) for one plan. The auth header is added by the Host invoker
 * (`X-Api-Key`), never here.
 */
export function zytHttpRequestFromPlan(plan: ZytRequestPlan, baseUrl: string): ZytHttpRequest {
  const url = new URL(plan.path ?? '/', baseUrl)
  for (const [key, value] of Object.entries(plan.query ?? {})) {
    url.searchParams.set(key, value)
  }
  return { method: plan.method ?? 'GET', url: url.toString(), body: plan.body ?? undefined }
}

/* ------------------------------------------------------------------ *
 *  Manifest — http-api primary, optional local-cli.
 * ------------------------------------------------------------------ */

/** Options accepted by {@link buildZytManifest}. */
export interface ZytManifestOptions {
  /** Base URL of the `/openapi/v1/*` API (default `https://dss.ke.com`). */
  readonly baseUrl?: string
  /**
   * Absolute path or command name of a `zyt` binary. When set, a second
   * `local-cli` transport (`cli`) is declared; capabilities bind to it when
   * `preferCli` is true, else to `http`.
   */
  readonly cliCommand?: string
  /** Bind read capabilities to the CLI transport instead of HTTP. */
  readonly preferCli?: boolean
  /** Provider manifest version (default `1.0.0`). */
  readonly version?: string
  /** Per-call timeout in milliseconds (default 60_000). */
  readonly timeoutMs?: number
}

const ZYT_CAPABILITIES: ReadonlyArray<{ readonly capability: string; readonly operation: string; readonly caliber?: string; readonly freshness: 'realtime' | 'daily' | 'monthly' | 'static' }> = [
  { capability: 'realestate.auth.identity', operation: 'zyt.auth.identity', freshness: 'static' },
  { capability: 'realestate.indicators.catalog', operation: 'zyt.indicators.catalog', freshness: 'static' },
  { capability: 'realestate.indicators.timeseries', operation: 'zyt.indicators.series', caliber: 'zyt dataView 口径（external=指数化，首值 100，禁当绝对量）', freshness: 'monthly' },
  { capability: 'realestate.indicators.batch', operation: 'zyt.indicators.batch-series', caliber: 'zyt dataView 口径（external=指数化，首值 100，禁当绝对量）', freshness: 'monthly' },
  { capability: 'realestate.city.compare', operation: 'zyt.indicators.compare', caliber: 'zyt dataView 口径（external=指数化，首值 100，禁当绝对量）', freshness: 'monthly' },
  { capability: 'realestate.geo.search', operation: 'zyt.geo.search', freshness: 'monthly' },
  { capability: 'realestate.reports.search', operation: 'zyt.reports.list', freshness: 'monthly' },
  { capability: 'realestate.policies.search', operation: 'zyt.policies.list', freshness: 'daily' },
  { capability: 'realestate.market.snapshot', operation: 'zyt.market-snapshot', freshness: 'monthly' },
  { capability: 'realestate.city-report2026.city', operation: 'zyt.city-report2026.city', freshness: 'monthly' },
  { capability: 'realestate.city-report2026.area', operation: 'zyt.city-report2026.area', freshness: 'monthly' },
  { capability: 'realestate.city-report2026.district', operation: 'zyt.city-report2026.district', freshness: 'monthly' },
  { capability: 'realestate.city-report2026.total-price', operation: 'zyt.city-report2026.total-price', freshness: 'monthly' },
  { capability: 'realestate.creis.land-market', operation: 'zyt.creis.land-market', freshness: 'monthly' },
  { capability: 'realestate.creis.land-transaction', operation: 'zyt.creis.land-transaction', freshness: 'monthly' },
  { capability: 'realestate.creis.new-home-market', operation: 'zyt.creis.new-home-market', freshness: 'monthly' },
  { capability: 'realestate.creis.new-home-project', operation: 'zyt.creis.new-home-project', freshness: 'monthly' },
  { capability: 'realestate.creis.resale-market', operation: 'zyt.creis.resale-market', freshness: 'monthly' },
]

/**
 * Build the zyt manifest. The `http` transport is always declared (direct
 * `/openapi/v1/*`, `X-Api-Key`); an optional `cli` transport is added when a
 * binary is configured. All transports default read-only.
 */
export function buildZytManifest(options: ZytManifestOptions = {}): ToolProviderManifest {
  const { baseUrl = 'https://dss.ke.com', cliCommand, preferCli = false, version = '1.0.0', timeoutMs = 60_000 } = options
  const transports: ToolTransport[] = [
    {
      kind: 'http-api',
      id: 'http',
      baseUrl,
      timeoutMs,
      readOnly: true,
      auth: { credentialRef: 'ZYT_API_KEY', source: 'file', hint: '~/.config/zyt/config.json' },
    },
  ]
  if (cliCommand !== undefined && cliCommand !== '') {
    transports.push({
      kind: 'local-cli',
      id: 'cli',
      command: cliCommand,
      args: ['--json'],
      timeoutMs,
      readOnly: true,
      // Resolve from the account's private config, then pass the extracted
      // apiKey to the CLI as an ephemeral env value in createZytInvoker.
      auth: { credentialRef: 'ZYT_API_KEY', source: 'file', hint: '~/.config/zyt/config.json' },
    })
  }
  const bindTo = preferCli && cliCommand !== undefined && cliCommand !== '' ? 'cli' : 'http'
  const capabilities: ToolCapability[] = ZYT_CAPABILITIES.map(entry => ({
    capability: entry.capability,
    operation: entry.operation,
    transportId: bindTo,
    ...(entry.caliber === undefined ? {} : { caliber: entry.caliber }),
    freshness: entry.freshness,
  }))
  return {
    id: 'zyt',
    version,
    schemaVersion: SCHEMA_VERSION,
    capabilities,
    transports,
    caveats: [
      'dataView：internal=真实绝对量；external=量类指数化（首值=100，勿当绝对量）',
      '退出码：0 成功 / 1 业务参数错 / 2 鉴权 / 3 网络或 5xx',
      'market-snapshot 联调 500，勿作硬依赖',
      '内部授权口径已实测；外部客户口径需按各账号许可单独验收',
    ],
  }
}

/* ------------------------------------------------------------------ *
 *  Output normalization.
 * ------------------------------------------------------------------ */

/** Raw result of one zyt CLI invocation (`--json` on stdout). */
export interface ZytCliResult {
  /** Process exit code (0/1/2/3 per contract). */
  readonly exitCode: number
  /** stdout text — the JSON payload the CLI writes with `--json`. */
  readonly stdout: string
  /** Bounded stderr, when any (audit only). */
  readonly stderr?: string
}

/** Raw result of one zyt HTTP call. */
export interface ZytHttpResult {
  readonly status: number
  readonly body: string
}

const ZYT_STDERR_LIMIT = 2000

function provenanceOf(options: ZytNormalizeOptions): ProvenanceInput {
  return {
    provider: options.provider ?? 'zyt',
    operation: options.operation,
    transportId: options.transportId,
    fetchedAt: options.fetchedAt,
    source: options.source,
    // caliber is derived from dataView inside normalizeZytEnvelope
  }
}

/**
 * Normalize raw `--json` CLI output, delegating to
 * {@link normalizeZytEnvelope} with exit-code semantics (0/1/2/3) and the
 * payload's own `dataView` threaded into the caliber (when the CLI returned
 * one). `dataView` and `unit` survive untouched.
 */
export function normalizeZytCliOutput(raw: ZytCliResult, options: ZytNormalizeOptions): ProviderEnvelope {
  const stderr = raw.stderr === undefined ? undefined : raw.stderr.slice(0, ZYT_STDERR_LIMIT)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.stdout)
  } catch {
    return failEnvelope({
      code: 'ZYT_INVALID_CLI_OUTPUT',
      retry: 'never',
      correction: 'zyt CLI stdout 不是 JSON（进程崩溃或未加 --json）',
      details: { exitCode: raw.exitCode, stderr },
    }, provenanceOf(options))
  }
  const payload = (isRecord(parsed) ? parsed : {}) as Record<string, unknown>
  const dataView = options.dataView ?? (typeof payload['dataView'] === 'string' ? payload['dataView'] : undefined)
  return normalizeZytEnvelope(payload as Parameters<typeof normalizeZytEnvelope>[0], {
    ...options,
    ...(dataView === undefined ? {} : { dataView }),
    exitCode: raw.exitCode,
  })
}

/**
 * Normalize a zyt HTTP response: 2xx → payload (dataView threaded through);
 * 401 → `ZYT_AUTH_ERROR` (never); 5xx → `backoff`; other 4xx →
 * `correct-input`, preserving the backend `error.code/message/httpStatus`
 * when present.
 */
export function normalizeZytHttpOutput(raw: ZytHttpResult, options: ZytNormalizeOptions): ProviderEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.body)
  } catch {
    return failEnvelope({
      code: 'ZYT_INVALID_HTTP_OUTPUT',
      retry: 'never',
      correction: 'zyt HTTP 响应体不是 JSON',
      details: { status: raw.status },
    }, provenanceOf(options))
  }
  const payload = isRecord(parsed) ? parsed : {}
  if (raw.status >= 200 && raw.status < 300) {
    const dataView = options.dataView ?? (typeof payload['dataView'] === 'string' ? payload['dataView'] : undefined)
    return normalizeZytEnvelope(payload as Parameters<typeof normalizeZytEnvelope>[0], {
      ...options,
      ...(dataView === undefined ? {} : { dataView }),
      exitCode: 0,
    })
  }
  const err = isRecord(payload['error']) ? payload['error'] as Record<string, unknown> : undefined
  const httpStatus = typeof err?.['httpStatus'] === 'number' ? err['httpStatus'] : raw.status
  const code = typeof err?.['code'] === 'string' && err['code'] !== '' ? err['code'] : undefined
  const message = typeof err?.['message'] === 'string' && err['message'] !== '' ? err['message'] : undefined
  if (raw.status === 401 || httpStatus === 401) {
    return failEnvelope({
      code: 'ZYT_AUTH_ERROR',
      retry: 'never',
      correction: '检查 X-Api-Key 凭据（flag > env > ~/.config/zyt/config.json）',
      details: { httpStatus },
    }, provenanceOf(options))
  }
  if (raw.status >= 500) {
    return failEnvelope({
      code: code ?? 'ZYT_NETWORK_ERROR',
      retry: 'backoff',
      ...(message === undefined ? {} : { correction: message }),
      details: { httpStatus, ...(message === undefined ? {} : { message }) },
    }, provenanceOf(options))
  }
  return failEnvelope({
    code: code ?? 'ZYT_HTTP_ERROR',
    retry: 'correct-input',
    ...(message === undefined ? {} : { correction: message }),
    details: { httpStatus, ...(message === undefined ? {} : { message }) },
  }, provenanceOf(options))
}

/** Extract the API key from a credential string (env value, or the `{apiKey}` config file JSON). */
export function extractZytApiKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (isRecord(parsed) && typeof parsed['apiKey'] === 'string' && parsed['apiKey'] !== '') {
        return parsed['apiKey']
      }
    } catch {
      return undefined
    }
  }
  return trimmed
}
