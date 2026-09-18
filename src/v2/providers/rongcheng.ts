/* ------------------------------------------------------------------ *
 *  rongcheng provider — 容诚在线估价（housevalue.*）
 *
 *  Binds the partner-deployed FastAPI services to the platform tool
 *  channel:
 *    - adapter (03-provider-adapter): valuation.infer / rent.infer
 *    - hold-return engine (04):       hold-return.calculate
 *
 *  The services already speak the platform envelope
 *  ({ok, capability, provider, provenance, warnings, data, error,
 *  truncated}), so the normalizer is a validating passthrough.
 *  Deployment status stays `candidate` until the zhijian gate passes
 *  (the adapter's /models/quality endpoint declares the same).
 * ------------------------------------------------------------------ */

import type { ToolCapability, ToolProviderManifest, ToolTransport } from '../types.ts'
import { SCHEMA_VERSION } from '../types.ts'

export const DEFAULT_RONGCHENG_ADAPTER_URL = 'http://127.0.0.1:8791'
export const DEFAULT_RONGCHENG_ENGINE_URL = 'http://127.0.0.1:8792'

/** Adapter-served capabilities (03-provider-adapter). */
export const RONGCHENG_ADAPTER_OPERATIONS: Readonly<Record<string, { path: string; method: string }>> = {
  'housevalue.realestate.valuation.infer': { path: '/api/v1/capabilities/valuation.infer', method: 'POST' },
  'housevalue.realestate.rent.infer': { path: '/api/v1/capabilities/rent.infer', method: 'POST' },
}

/** Engine-served capabilities (04-hold-return-engine). */
export const RONGCHENG_ENGINE_OPERATIONS: Readonly<Record<string, { path: string; method: string }>> = {
  'housevalue.realestate.hold-return.calculate': { path: '/api/v1/calculations/hold-return', method: 'POST' },
}

/** Platform-owned capabilities stay unregistered here (zhijian side). */
export const RONGCHENG_CAVEATS: readonly string[] = [
  '模型 deployment_status=candidate：结果为市场价值/租金参考测算，须经智见门禁与人工复核后方可进入正式交付',
  'address.resolve / sale-comparables.query / rent-comparables.query / report.generate 为智见平台侧能力，不在本 provider 绑定范围',
  '坐标契约：GCJ-02，经度 118.9–119.8、纬度 25.5–26.5；坐标必须来自智见小区主数据，缺失即阻断',
  'numericSourceRule=model_or_deterministic_provider_only：参考价仅可引用本 provider 带 inference_id/model_version 的结构化返回',
]

export interface RongchengManifestOptions {
  adapterBaseUrl?: string
  engineBaseUrl?: string
  version?: string
  timeoutMs?: number
}

export function buildRongchengManifest(options: RongchengManifestOptions = {}): ToolProviderManifest {
  const {
    adapterBaseUrl = DEFAULT_RONGCHENG_ADAPTER_URL,
    engineBaseUrl = DEFAULT_RONGCHENG_ENGINE_URL,
    version = '1.0.0',
    timeoutMs = 120_000,
  } = options
  const transports: ToolTransport[] = [
    { kind: 'http-api', id: 'adapter-api', baseUrl: adapterBaseUrl, timeoutMs, readOnly: true },
    { kind: 'http-api', id: 'engine-api', baseUrl: engineBaseUrl, timeoutMs, readOnly: true },
  ]
  const caliber = '容诚在线估价模型（candidate；结构化快照带 inference_id/model_version，语言模型不得自行计算估值）'
  const capabilities: ToolCapability[] = [
    ...Object.entries(RONGCHENG_ADAPTER_OPERATIONS).map(([capability, op]) => ({
      capability,
      operation: `rongcheng${op.path}`,
      transportId: 'adapter-api',
      caliber,
      freshness: 'realtime' as const,
    })),
    ...Object.entries(RONGCHENG_ENGINE_OPERATIONS).map(([capability, op]) => ({
      capability,
      operation: `rongcheng${op.path}`,
      transportId: 'engine-api',
      caliber: '确定性持有收益/收购价测算引擎（结构化计算快照，语言模型不参与算术）',
      freshness: 'realtime' as const,
    })),
  ]
  return {
    id: 'rongcheng',
    version,
    schemaVersion: SCHEMA_VERSION,
    capabilities,
    transports,
    caveats: RONGCHENG_CAVEATS,
  }
}

export interface RongchengHttpRaw {
  status?: number
  body?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The partner services already emit the platform envelope shape, so the
 * normalizer validates and passes through, attaching transport metadata
 * into provenance when the payload omits it.
 */
export function normalizeRongchengHttpOutput(
  raw: RongchengHttpRaw,
  meta: { provider: string; operation: string; transportId: string; source?: string },
): Record<string, unknown> {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(raw.body ?? '')
    } catch {
      return undefined
    }
  })()
  if (!isRecord(parsed) || typeof parsed['ok'] !== 'boolean' || !isRecord(parsed['provider'])) {
    return {
      ok: false,
      capability: meta.operation,
      provider: { id: meta.provider, version: 'unknown' },
      provenance: { transport_id: meta.transportId, source: meta.source, http_status: raw.status ?? 0 },
      warnings: [],
      data: null,
      error: {
        code: 'transport_invalid_response',
        message: '容诚服务返回了无法解析的非信封响应',
        retry: 'conditional',
        correction: '检查服务进程与 /health 端点；响应必须是平台信封 JSON',
      },
      truncated: false,
    }
  }
  const envelope: Record<string, unknown> = { ...parsed, capability: meta.operation }
  // 平台信封校验要求 provider.id === manifest id（rongcheng）；伙伴侧原始
  // 标识保留进 provenance（审计可回查到 rongcheng-fz-valuation-provider）。
  const partnerProvider = isRecord(parsed['provider']) ? parsed['provider'] : {}
  envelope['provider'] = { id: meta.provider, version: partnerProvider['version'] ?? 'unknown' }
  const provenance = isRecord(envelope['provenance']) ? { ...envelope['provenance'] } : {}
  provenance['partner_provider'] = partnerProvider
  // 平台信封校验：provenance.provider / operation 必须与 binding 一致
  provenance['provider'] = meta.provider
  provenance['operation'] = meta.operation
  if (provenance['transport_id'] === undefined) provenance['transport_id'] = meta.transportId
  if (provenance['source'] === undefined && meta.source !== undefined) provenance['source'] = meta.source
  if (provenance['http_status'] === undefined && raw.status !== undefined) provenance['http_status'] = raw.status
  envelope['provenance'] = provenance
  if (envelope['ok'] === false) {
    const error = isRecord(envelope['error']) ? { ...envelope['error'] } : {}
    if (error['retry'] === undefined) error['retry'] = (raw.status ?? 0) >= 500 ? 'conditional' : 'never'
    envelope['error'] = error
    envelope['data'] = envelope['data'] ?? null
  }
  return envelope
}
