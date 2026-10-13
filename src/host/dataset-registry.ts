export interface DatasetCapabilityBinding { readonly id: string; readonly schemaVersion: string }
export interface DatasetDefinition { readonly dataset: string; readonly version: string; readonly description: string; readonly providerPreference: readonly string[]; readonly capabilities: readonly DatasetCapabilityBinding[]; readonly requiredFields: readonly string[]; readonly requiredProvenance: readonly string[]; readonly readOnly: true; readonly installPolicy: 'never' | 'explicit' }
export interface DatasetRequest { readonly dataset: string; readonly input: Record<string, unknown>; readonly version?: string }
export interface DatasetResolution { readonly definition: DatasetDefinition; readonly binding: DatasetCapabilityBinding; readonly input: Record<string, unknown>; readonly signature: string }
export interface DatasetError { readonly code: 'DATASET_UNKNOWN' | 'DATASET_VERSION_UNSUPPORTED' | 'CALIBER_MISSING' | 'DATA_QUALITY_INVALID' | 'INPUT_INVALID'; readonly retry: 'never'; readonly correction: string; readonly details?: Record<string, unknown> }

export const ZHIJIAN_DATASETS: readonly DatasetDefinition[] = [
  { dataset: 'realestate.indicators.catalog', version: '1.0', description: '政研通指标目录（指标代码 code 的发现入口，供 city.market 等引用）', providerPreference: ['zyt'], capabilities: [{ id: 'realestate.indicators.catalog', schemaVersion: '1' }], requiredFields: [], requiredProvenance: ['source'], readOnly: true, installPolicy: 'never' },
  { dataset: 'realestate.city.market', version: '1.1', description: '城市房地产指标时序（city=城市名称；code=指标代码，先查 realestate.indicators.catalog，不是城市/行政区编码；可选 periodEnd=截止月 YYYY-MM、limit=期数；当前时序路线不支持 metric/period）', providerPreference: ['zyt', 'beike'], capabilities: [{ id: 'realestate.indicators.timeseries', schemaVersion: '1' }, { id: 'realestate.market.snapshot', schemaVersion: '1' }], requiredFields: ['city', 'code'], requiredProvenance: ['source', 'caliber'], readOnly: true, installPolicy: 'never' },
  { dataset: 'realestate.city.compare', version: '1.0', description: '多城市房地产指标对比', providerPreference: ['zyt'], capabilities: [{ id: 'realestate.city.compare', schemaVersion: '1' }], requiredFields: ['cities'], requiredProvenance: ['source', 'caliber'], readOnly: true, installPolicy: 'never' },
  { dataset: 'realestate.listing.search', version: '1.0', description: '贝壳房源检索', providerPreference: ['beike'], capabilities: [{ id: 'realestate.listing.search', schemaVersion: '1' }], requiredFields: ['city'], requiredProvenance: ['source', 'caliber'], readOnly: true, installPolicy: 'never' },
  { dataset: 'realestate.policy', version: '1.0', description: '购房政策与交易规则检索；city=城市、topic=单个政策问题，可选 query 补充条件；自动转换为 city_name/query', providerPreference: ['beike'], capabilities: [{ id: 'realestate.policy.search', schemaVersion: '1' }], requiredFields: ['city', 'topic'], requiredProvenance: ['source', 'caliber'], readOnly: true, installPolicy: 'never' },
  { dataset: 'realestate.rent.market', version: '1.0', description: '当前在租挂牌房源检索，非成交租金或历史快照；city=城市、period=研究参考期（接口不按该期过滤），可选 query=房源条件。MCP HTTP 可用 business_types 结构化过滤；CLI 优先实例不支持该字段，请改在 query 中描述且不得宣称精确过滤', providerPreference: ['beike'], capabilities: [{ id: 'realestate.rent.search', schemaVersion: '1' }], requiredFields: ['city', 'period'], requiredProvenance: ['source', 'caliber'], readOnly: true, installPolicy: 'never' },
  { dataset: 'financial.stock.quote', version: '1.0', description: '股票行情快照', providerPreference: ['wind'], capabilities: [{ id: 'financial.stock.quote', schemaVersion: '1' }], requiredFields: ['windcode'], requiredProvenance: ['source'], readOnly: true, installPolicy: 'never' },
  { dataset: 'financial.macro', version: '1.1', description: '万得宏观指标查询；input.question=自然语言指标问题，并提供 observation=近 N 期，或 beginDate/endDate=起止日期（YYYY-MM-DD），两种时间方式不能混用', providerPreference: ['wind'], capabilities: [{ id: 'financial.macro.query', schemaVersion: '1' }], requiredFields: ['question'], requiredProvenance: ['source'], readOnly: true, installPolicy: 'never' },
]
const DATASET_BY_ID = new Map(ZHIJIAN_DATASETS.map(definition => [definition.dataset, definition]))
export function datasetDefinition(dataset: string): DatasetDefinition | undefined { return DATASET_BY_ID.get(dataset) }
function datasetError(code: DatasetError['code'], correction: string, details?: Record<string, unknown>): DatasetError { return { code, retry: 'never', correction, ...(details === undefined ? {} : { details }) } }

/** Minimal localdb registration slice the dynamic dataset resolution needs. */
export interface LocalDbDatasetSource { readonly id: string; readonly caliber?: string }

/**
 * Dynamic localdb datasets: `localdb.<id>.query` / `localdb.<id>.schema` are
 * derived from the databases the host actually registered (plugin config /
 * `LOCALDB_DATABASES` env / scanDirs discovery) — adding a database needs no
 * code change. Ids absent from the supplied list fail closed as
 * DATASET_UNKNOWN (never guessed, never auto-installed).
 */
export function resolveLocalDbDataset(dataset: string, localDatabases: readonly LocalDbDatasetSource[] | undefined): DatasetDefinition | undefined {
  if (localDatabases === undefined || localDatabases.length === 0) return undefined
  const parts = dataset.split('.')
  if (parts.length !== 3 || parts[0] !== 'localdb') return undefined
  const id = parts[1]!
  const kind = parts[2]!
  if (kind !== 'query' && kind !== 'schema') return undefined
  const db = localDatabases.find(candidate => candidate.id === id)
  if (db === undefined) return undefined
  const caliber = db.caliber ?? '本地 SQLite 只读查询（以库内字段口径为准）'
  return {
    dataset,
    version: '1.0',
    description: `本地 SQLite 数据库「${id}」${kind === 'query' ? '只读查询（单条 SELECT/WITH，input.sql）' : '表结构探查（input.table 可选）'}`,
    providerPreference: ['localdb'],
    capabilities: [{ id: `localdb.${id}.${kind}`, schemaVersion: '1' }],
    requiredFields: kind === 'query' ? ['sql'] : [],
    requiredProvenance: ['source', 'caliber'],
    readOnly: true,
    installPolicy: 'never',
  }
}

export function resolveDatasetRequest(request: DatasetRequest, localDatabases?: readonly LocalDbDatasetSource[]): DatasetResolution | { error: DatasetError } {
  const definition = resolveLocalDbDataset(request.dataset, localDatabases) ?? datasetDefinition(request.dataset)
  if (definition === undefined) return { error: datasetError('DATASET_UNKNOWN', `未注册数据集「${request.dataset}」；禁止猜测 capability key 或自动安装`) }
  if (request.version !== undefined && request.version !== definition.version) return { error: datasetError('DATASET_VERSION_UNSUPPORTED', `数据集「${request.dataset}」仅支持版本 ${definition.version}`) }
  const missing = definition.requiredFields.filter(field => { const value = request.input[field]; return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0) })
  if (missing.length > 0) return { error: datasetError('CALIBER_MISSING', `数据集「${request.dataset}」缺少必填口径：${missing.join('、')}`, { missing }) }
  if (request.dataset === 'financial.macro') {
    const { observation, beginDate, endDate } = request.input
    const hasObservation = observation !== undefined
    const hasRange = beginDate !== undefined || endDate !== undefined
    if (hasObservation === hasRange) return { error: datasetError('INPUT_INVALID', 'financial.macro 必须二选一：observation=正整数，或 beginDate/endDate=完整日期范围') }
    if (hasObservation && (typeof observation !== 'number' || !Number.isInteger(observation) || observation <= 0)) return { error: datasetError('INPUT_INVALID', 'financial.macro 的 observation 必须是正整数') }
    const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
    if (hasRange && (!validDate(beginDate) || !validDate(endDate) || beginDate > endDate)) return { error: datasetError('INPUT_INVALID', 'financial.macro 的 beginDate/endDate 必须是有效且有序的 YYYY-MM-DD 日期') }
  }
  const binding = definition.capabilities[0]
  if (binding === undefined) return { error: datasetError('DATASET_UNKNOWN', `数据集「${request.dataset}」未绑定任何 capability（注册表配置错误，请联系维护者补充映射）`) }
  return { definition, binding, input: request.input, signature: datasetRequestSignature(request.dataset, request.input) }
}
export function datasetRequestSignature(dataset: string, input: Record<string, unknown>): string { const canonical = Object.keys(input).sort().map(key => `${key}=${canonicalValue(input[key])}`).join('&'); return `${dataset}|${canonical}` }
function canonicalValue(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`; if (value !== null && typeof value === 'object') { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map(key => `${key}:${canonicalValue(record[key])}`).join(',')}}` }; return JSON.stringify(value) ?? String(value) }
export function validateDatasetProvenance(definition: DatasetDefinition, provenance: Record<string, unknown> | undefined): DatasetError | undefined { const missing = definition.requiredProvenance.filter(field => { const value = provenance?.[field]; return value === undefined || value === null || value === '' }); if (missing.length === 0) return undefined; return datasetError('DATA_QUALITY_INVALID', `数据集「${definition.dataset}」返回缺少 provenance：${missing.join('、')}`, { missing }) }
