/** 成都数据运营平台：三个已提供合同文档的只读产品。 */
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { SCHEMA_VERSION, type ToolProviderManifest } from '../types.ts'
import { failEnvelope, okEnvelope, type ProviderEnvelope, type ProvenanceInput } from '../provider-runtime.ts'

export const CDDATAOS_BASE_URL = 'https://yypt.cddataos.com:8091'
export const CDDATAOS_CALL_PATH = '/xs-api/data-service-platform/api/platform/service/call'
export const CDDATAOS_OPERATIONS = {
  'cddataos.chengdu.transactions': { capability: 'realestate.cddataos.chengdu-transactions', productCode: 'YY202601231769147202978:V1', fields: ['start_date', 'end_date'], caliber: '成都新房与存量房成交统计；不定期更新；时间窗口对应的汇总口径待供应商确认' },
  'cddataos.enterprise.land': { capability: 'realestate.cddataos.enterprise-land', productCode: 'YY202511211763686834203:V1', fields: ['type', 'keyword', 'auth_authorizeFileCode'], caliber: '全国企业购地信息；须有主体授权；不定期更新' },
  'cddataos.property.risk': { capability: 'realestate.cddataos.property-risk', productCode: 'YY202511261764136870253:V1', fields: ['address', 'auth_authorizeFileCode'], caliber: '全国房产风险核查；须有主体授权；每日更新' },
} as const

const INPUT_PROPERTIES: Readonly<Record<string, Record<string, unknown>>> = {
  'cddataos.chengdu.transactions': {
    start_date: { type: 'string', description: '成都成交统计起始日期，YYYY-MM-DD；2024-01-01 至 2026-10-20 已实测返回数据，调用可能计费' },
    end_date: { type: 'string', description: '成都成交统计结束日期，YYYY-MM-DD；查询前确认所需时间段和可能的计费' },
  },
  'cddataos.enterprise.land': {
    type: { type: 'string', enum: ['1', '2', '3', '4', '5', '6'], description: '1 地块公示，2 结果公告，3 土地转让，4 土地抵押，5 房企购地，6 大地块出让' },
    keyword: { type: 'string', description: '企业全名、注册号或统一社会信用代码；不是城市名称' },
    skip: { type: 'string', description: '跳过条目数，默认 0，每页 10 条' },
    auth_authorizeFileCode: { type: 'string', description: '被查询主体的真实纸质或电子授权凭证编号' },
  },
  'cddataos.property.risk': {
    address: { type: 'string', description: '包含行政区划、精确到户的真实房产地址' },
    match_mode: { type: 'string', enum: ['0', '1'], description: '0 精确匹配（默认），1 模糊匹配' },
    auth_authorizeFileCode: { type: 'string', description: '被查询主体的真实纸质或电子授权凭证编号' },
  },
}

export type CddataosOperation = keyof typeof CDDATAOS_OPERATIONS
export interface CddataosCredential { accessKey: string; accessSecret: string }

export function parseCddataosCredential(raw: string): CddataosCredential | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const row = value as Record<string, unknown>
    if (typeof row['accessKey'] !== 'string' || typeof row['accessSecret'] !== 'string') return undefined
    if (Buffer.byteLength(row['accessKey'], 'utf8') !== 32 || Buffer.byteLength(row['accessSecret'].slice(0, 16), 'utf8') !== 16) return undefined
    return { accessKey: row['accessKey'], accessSecret: row['accessSecret'] }
  } catch { return undefined }
}

export function buildCddataosManifest(baseUrl = CDDATAOS_BASE_URL): ToolProviderManifest {
  return {
    id: 'cddataos', version: '1.0.0', schemaVersion: SCHEMA_VERSION,
    transports: [{ kind: 'http-api', id: 'http', baseUrl, timeoutMs: 60_000, readOnly: true,
      auth: { credentialRef: 'CDDATAOS_CREDENTIALS', source: 'file', hint: '~/.config/cddataos/credentials.json' } }],
    capabilities: Object.entries(CDDATAOS_OPERATIONS).map(([operation, entry]) => ({
      capability: entry.capability, operation, transportId: 'http', caliber: entry.caliber,
      freshness: operation === 'cddataos.property.risk' ? 'daily' as const : undefined,
      inputSchema: { type: 'object', required: [...entry.fields], properties: INPUT_PROPERTIES[operation], additionalProperties: false },
    })),
    caveats: [
      '仅 demo-c 显式授权；三个产品均可能计费，按供应商响应 fee 字段核算',
      '出口 IP 须在供应商白名单；企业购地与房产风险查询须提供真实主体授权凭证编号',
      '成交统计仅限成都；结果口径、覆盖范围与更新频率以对应供应商产品文档为准',
      '成交统计长区间有数据、窄区间查无，不能据此断言结果是区间累计或产品不支持月度；fee=1 仅表示该次计费，不代表费用金额或扣费单位数',
    ],
  }
}

function aesKey(credential: CddataosCredential): { key: Buffer; iv: Buffer } {
  return { key: Buffer.from(credential.accessKey, 'utf8'), iv: Buffer.from(credential.accessSecret.slice(0, 16), 'utf8') }
}

export function cddataosEncrypt(plaintext: string, credential: CddataosCredential): string {
  const { key, iv } = aesKey(credential)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64')
}

export function cddataosDecrypt(ciphertext: string, credential: CddataosCredential): string {
  const { key, iv } = aesKey(credential)
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([decipher.update(ciphertext, 'base64'), decipher.final()]).toString('utf8')
}

export function cddataosSign(params: Record<string, string>, timestamp: string, credential: CddataosCredential): string {
  const pairs = Object.keys(params).sort().filter(key => params[key] !== '').map(key => `${key}=${params[key]}&`).join('')
  return createHash('md5').update(`${pairs}timeStamp=${timestamp}&key=${credential.accessKey}&secret=${credential.accessSecret}`, 'utf8').digest('hex')
}

function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function validDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value }

const SUPPLIER_ERRORS: Readonly<Record<string, { correction: string; retry: 'never' | 'correct-input' | 'backoff' }>> = {
  '30000': { correction: '数据源查无；核对查询范围与条件，勿将此码判为产品未开通或 IP 白名单失败', retry: 'never' },
  '30001': { correction: '数据源异常；联系供应商核查', retry: 'backoff' },
  '30002': { correction: '数据源访问超时；稍后重试', retry: 'backoff' },
  '30003': { correction: '数据源访问出错；联系供应商核查', retry: 'backoff' },
  '30004': { correction: '入参校验异常；核对产品字段与取值', retry: 'correct-input' },
  '300002': { correction: '必填查询参数缺失', retry: 'correct-input' },
  '300003': { correction: '签名验证失败；检查签名算法和时间戳', retry: 'never' },
  '300004': { correction: '必填主体授权参数缺失', retry: 'correct-input' },
  '300005': { correction: '产品编号与 appKey 校验失败；核对产品权限', retry: 'never' },
  '400002': { correction: '产品订单不存在；核对订购状态', retry: 'never' },
  '400007': { correction: '产品订单调用次数用完', retry: 'never' },
  '400008': { correction: '账户余额不足', retry: 'never' },
  '500003': { correction: '用户未配置 IP 白名单；请联系供应商登记出口 IP', retry: 'never' },
  '500004': { correction: '供应商系统忙；稍后重试', retry: 'backoff' },
}

/** Sign the plaintext before encrypting the whole parameter object, per supplier Java sample. */
export function cddataosCallPlan(operation: string, input: unknown, credential: CddataosCredential, timestamp = String(Date.now())): { method: 'POST'; path: string; headers: Record<string, string>; body: { encryptParam: string } } {
  const entry = CDDATAOS_OPERATIONS[operation as CddataosOperation]
  if (entry === undefined) throw new Error('未知的成都数据运营平台产品')
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('请求参数必须是对象')
  const row = input as Record<string, unknown>
  const allowed = new Set<string>([...entry.fields, ...(operation === 'cddataos.enterprise.land' ? ['skip'] : []), ...(operation === 'cddataos.property.risk' ? ['match_mode'] : [])])
  if (Object.keys(row).some(key => !allowed.has(key))) throw new Error('请求包含未声明字段')
  for (const field of entry.fields) if (!nonempty(row[field])) throw new Error(`缺少必填参数 ${field}`)
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是字符串`)
    params[key] = value
  }
  if (operation === 'cddataos.chengdu.transactions') {
    if (!validDate(params['start_date']!) || !validDate(params['end_date']!)) throw new Error('start_date 和 end_date 必须是有效的 YYYY-MM-DD 日期')
    if (params['start_date']! > params['end_date']!) throw new Error('起始日期不能晚于结束日期')
  }
  if (operation === 'cddataos.enterprise.land') {
    if (!/^[1-6]$/.test(params['type']!)) throw new Error('type 仅支持 1–6')
    if (params['skip'] !== undefined && !/^(0|[1-9]\d*)$/.test(params['skip'])) throw new Error('skip 必须是非负整数字符串')
  }
  if (operation === 'cddataos.property.risk' && params['match_mode'] !== undefined && !/^[01]$/.test(params['match_mode'])) throw new Error('match_mode 仅支持 0 或 1')
  return {
    method: 'POST', path: CDDATAOS_CALL_PATH,
    headers: { sign: cddataosSign(params, timestamp, credential), signMode: 'MD5', encryptMode: 'AES', appKey: credential.accessKey, productCode: entry.productCode, timeStamp: timestamp },
    body: { encryptParam: cddataosEncrypt(JSON.stringify(params), credential) },
  }
}

/** Do not return raw supplier errors, headers or encrypted content in envelopes. */
export function normalizeCddataosResponse(status: number, body: string, credential: CddataosCredential, provenance: ProvenanceInput): ProviderEnvelope {
  let row: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
    row = parsed as Record<string, unknown>
  } catch { return failEnvelope({ code: 'CDDATAOS_INVALID_RESPONSE', retry: 'never', correction: '供应商返回格式无效' }, provenance) }
  const code = String(row['code'] ?? `HTTP_${status}`)
  if (status < 200 || status >= 300 || code !== '200') {
    const mapped = SUPPLIER_ERRORS[code]
    const noDataCorrection = code === '30000'
      ? provenance.operation === 'cddataos.enterprise.land'
        ? '数据源查无；keyword 必须是企业全名、注册号或统一社会信用代码（城市名不适用），并使用真实授权编号核查'
        : provenance.operation === 'cddataos.chengdu.transactions'
          ? '数据源查无；日期须为 YYYY-MM-DD，2024-01-01 至 2026-10-20 已实测返回数据；窄区间查无不能证明不支持月度，也勿将此码判为权限失败'
          : '数据源查无；请核对精确到户的真实地址与授权编号，可按授权范围考虑 match_mode=1'
      : undefined
    return failEnvelope({
      code: `CDDATAOS_${code.replace(/[^A-Za-z0-9_]/g, '').slice(0, 24)}`,
      retry: mapped?.retry ?? 'never',
      correction: noDataCorrection ?? mapped?.correction ?? '供应商返回未映射的错误码；按产品文档核查该状态码',
      details: {
        ...(typeof row['requestId'] === 'string' ? { requestId: row['requestId'] } : {}),
        feeCharged: row['fee'] === 1 || row['fee'] === '1' || row['fee'] === true,
      },
    }, provenance)
  }
  if (typeof row['content'] !== 'string') return failEnvelope({ code: 'CDDATAOS_INVALID_CONTENT', retry: 'never', correction: '供应商未返回 AES 密文' }, provenance)
  try {
    const data: unknown = JSON.parse(cddataosDecrypt(row['content'], credential))
    return okEnvelope({ content: data, requestId: typeof row['requestId'] === 'string' ? row['requestId'] : undefined, fee: row['fee'] === 1 || row['fee'] === '1' || row['fee'] === true ? 1 : 0 }, provenance)
  } catch { return failEnvelope({ code: 'CDDATAOS_DECRYPT_FAILED', retry: 'never', correction: '供应商返回密文无法解密' }, provenance) }
}
