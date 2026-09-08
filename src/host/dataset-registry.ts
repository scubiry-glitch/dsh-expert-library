export interface DatasetCapabilityBinding { readonly id: string; readonly schemaVersion: string }
export interface DatasetDefinition { readonly dataset: string; readonly version: string; readonly description: string; readonly providerPreference: readonly string[]; readonly capabilities: readonly DatasetCapabilityBinding[]; readonly requiredFields: readonly string[]; readonly requiredProvenance: readonly string[]; readonly readOnly: true; readonly installPolicy: 'never' | 'explicit' }
export interface DatasetRequest { readonly dataset: string; readonly input: Record<string, unknown>; readonly version?: string }
export interface DatasetResolution { readonly definition: DatasetDefinition; readonly binding: DatasetCapabilityBinding; readonly input: Record<string, unknown>; readonly signature: string }
export interface DatasetError { readonly code: 'DATASET_UNKNOWN' | 'DATASET_VERSION_UNSUPPORTED' | 'CALIBER_MISSING' | 'DATA_QUALITY_INVALID' | 'INPUT_INVALID'; readonly retry: 'never'; readonly correction: string; readonly details?: Record<string, unknown> }

export const ZHIJIAN_DATASETS: readonly DatasetDefinition[] = [
  { dataset: 'realestate.indicators.catalog', version: '1.0', description: '政研通指标目录（指标代码 code 的发现入口，供 city.market 等引用）', providerPreference: ['zyt'], capabilities: [{ id: 'realestate.indicators.catalog', schemaVersion: '1' }], requiredFields: [], requiredProvenance: ['source'], readOnly: true, installPolicy: 'never' },
  { dataset: 'realestate.city.market', version: '1.1', description: '城市房地产指标时序（code=指标代码，先查 realestate.indicators.catalog；period 为查询起点，periodEnd/limit 可选）', providerPreference: ['zyt', 'beike'], capabilities: [{ id: 'realestate.indicators.timeseries', schemaVersion: '1' }, { id: 'realestate.market.snapshot', schemaVersion: '1' }], requiredFields: ['city', 'code'], requiredProvenance: ['source', 'caliber'], readOnly: true, installPolicy: 'never' },
  { dataset: 'realestate.city.compare', version: '1.0', description: '多城市房地产指标对比', providerPreference: ['zyt'], capabilities: [{ id: 'realestate.city.compare', schemaVersion: '1' }], requiredFields: ['cities'], requiredProvenance: ['source', 'caliber'], readOnly: true, installPolicy: 'never' },
  { dataset: 'realestate.listing.search', version: '1.0', description: '贝壳房源检索', providerPreference: ['beike'], capabilities: [{ id: 'realestate.listing.search', schemaVersion: '1' }], requiredFields: ['city'], requiredProvenance: ['source', 'caliber'], readOnly: true, installPolicy: 'never' },
  { dataset: 'realestate.policy', version: '1.0', description: '城市房地产政策检索', providerPreference: ['beike'], capabilities: [{ id: 'realestate.policy.search', schemaVersion: '1' }], requiredFields: ['city', 'topic'], requiredProvenance: ['source', 'caliber'], readOnly: true, installPolicy: 'never' },
  { dataset: 'realestate.rent.market', version: '1.0', description: '城市租赁市场检索', providerPreference: ['beike'], capabilities: [{ id: 'realestate.rent.search', schemaVersion: '1' }], requiredFields: ['city', 'period'], requiredProvenance: ['source', 'caliber'], readOnly: true, installPolicy: 'never' },
  { dataset: 'financial.stock.quote', version: '1.0', description: '股票行情快照', providerPreference: ['wind'], capabilities: [{ id: 'financial.stock.quote', schemaVersion: '1' }], requiredFields: ['windcode'], requiredProvenance: ['source'], readOnly: true, installPolicy: 'never' },
  { dataset: 'financial.macro', version: '1.0', description: '宏观经济指标查询', providerPreference: ['wind'], capabilities: [{ id: 'financial.macro.query', schemaVersion: '1' }], requiredFields: ['metric', 'period'], requiredProvenance: ['source'], readOnly: true, installPolicy: 'never' },
]
const DATASET_BY_ID = new Map(ZHIJIAN_DATASETS.map(definition => [definition.dataset, definition]))
export function datasetDefinition(dataset: string): DatasetDefinition | undefined { return DATASET_BY_ID.get(dataset) }
function datasetError(code: DatasetError['code'], correction: string, details?: Record<string, unknown>): DatasetError { return { code, retry: 'never', correction, ...(details === undefined ? {} : { details }) } }
export function resolveDatasetRequest(request: DatasetRequest): DatasetResolution | { error: DatasetError } {
  const definition = datasetDefinition(request.dataset)
  if (definition === undefined) return { error: datasetError('DATASET_UNKNOWN', `未注册数据集「${request.dataset}」；禁止猜测 capability key 或自动安装`) }
  if (request.version !== undefined && request.version !== definition.version) return { error: datasetError('DATASET_VERSION_UNSUPPORTED', `数据集「${request.dataset}」仅支持版本 ${definition.version}`) }
  const missing = definition.requiredFields.filter(field => { const value = request.input[field]; return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0) })
  if (missing.length > 0) return { error: datasetError('CALIBER_MISSING', `数据集「${request.dataset}」缺少必填口径：${missing.join('、')}`, { missing }) }
  const binding = definition.capabilities[0]
  if (binding === undefined) return { error: datasetError('DATASET_UNKNOWN', `数据集「${request.dataset}」未绑定任何 capability（注册表配置错误，请联系维护者补充映射）`) }
  return { definition, binding, input: request.input, signature: datasetRequestSignature(request.dataset, request.input) }
}
export function datasetRequestSignature(dataset: string, input: Record<string, unknown>): string { const canonical = Object.keys(input).sort().map(key => `${key}=${canonicalValue(input[key])}`).join('&'); return `${dataset}|${canonical}` }
function canonicalValue(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`; if (value !== null && typeof value === 'object') { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map(key => `${key}:${canonicalValue(record[key])}`).join(',')}}` }; return JSON.stringify(value) ?? String(value) }
export function validateDatasetProvenance(definition: DatasetDefinition, provenance: Record<string, unknown> | undefined): DatasetError | undefined { const missing = definition.requiredProvenance.filter(field => { const value = provenance?.[field]; return value === undefined || value === null || value === '' }); if (missing.length === 0) return undefined; return datasetError('DATA_QUALITY_INVALID', `数据集「${definition.dataset}」返回缺少 provenance：${missing.join('、')}`, { missing }) }
