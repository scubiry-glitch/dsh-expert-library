import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  buildCddataosManifest, cddataosCallPlan, cddataosDecrypt, cddataosEncrypt,
  cddataosSign, normalizeCddataosResponse, parseCddataosCredential,
} from '../lib/v2/index.js'
import { ProviderRegistry } from '../lib/v2/provider-runtime.js'
import { ProviderTransportService } from '../lib/host/provider-service.js'
import { datasetRequestSignature, resolveDatasetRequest } from '../lib/host/dataset-registry.js'

const credential = { accessKey: '0123456789abcdef0123456789abcdef', accessSecret: 'abcdef0123456789abcdef0123456789' }
const credJson = JSON.stringify(credential)
const provenance = { provider: 'cddataos', operation: 'cddataos.chengdu.transactions', transportId: 'http', source: 'test', caliber: 'test' }

test('three document products register with exact product codes and no secret in manifest', () => {
  const manifest = buildCddataosManifest()
  const registry = new ProviderRegistry([manifest])
  assert.ok(registry.get('cddataos'))
  assert.equal(manifest.capabilities.length, 3)
  assert.equal(manifest.transports[0].auth.credentialRef, 'CDDATAOS_CREDENTIALS')
  assert.ok(!JSON.stringify(manifest).includes(credential.accessKey))
  const land = manifest.capabilities.find(capability => capability.operation === 'cddataos.enterprise.land')
  assert.match(land.inputSchema.properties.keyword.description, /企业全名/)
  assert.match(land.inputSchema.properties.auth_authorizeFileCode.description, /真实/)
  const transactions = manifest.capabilities.find(capability => capability.operation === 'cddataos.chengdu.transactions')
  assert.match(transactions.inputSchema.properties.start_date.description, /YYYY-MM-DD/)
  assert.equal(resolveDatasetRequest({ dataset: 'realestate.cddataos.property-risk', input: { address: 'test' } }).error.code, 'CALIBER_MISSING')
  const signature = datasetRequestSignature('realestate.cddataos.property-risk', { address: 'private-address', auth_authorizeFileCode: 'private-auth' })
  assert.ok(!signature.includes('private-address') && !signature.includes('private-auth'))
})

test('request signature and AES-CBC round trip match documented plaintext signing contract', () => {
  assert.deepEqual(parseCddataosCredential(credJson), credential)
  assert.equal(parseCddataosCredential('{}'), undefined)
  const input = { end_date: '2026-10-27', start_date: '2026-10-01' }
  const timestamp = '1760000000000'
  const plan = cddataosCallPlan('cddataos.chengdu.transactions', input, credential, timestamp)
  const expected = createHash('md5').update(`end_date=${input.end_date}&start_date=${input.start_date}&timeStamp=${timestamp}&key=${credential.accessKey}&secret=${credential.accessSecret}`).digest('hex')
  assert.equal(plan.headers.sign, expected)
  assert.equal(cddataosSign(input, timestamp, credential), expected)
  assert.equal(plan.headers.productCode, 'YY202601231769147202978:V1')
  assert.deepEqual(JSON.parse(cddataosDecrypt(plan.body.encryptParam, credential)), input)
  assert.ok(!JSON.stringify(plan.body).includes(input.start_date))
})

test('subject authorization and per-product parameters fail before any HTTP call', () => {
  assert.throws(() => cddataosCallPlan('cddataos.enterprise.land', { type: '1', keyword: '公司' }, credential), /auth_authorizeFileCode/)
  assert.throws(() => cddataosCallPlan('cddataos.property.risk', { address: '地址', auth_authorizeFileCode: 'AUTH', match_mode: '2' }, credential), /match_mode/)
  assert.throws(() => cddataosCallPlan('cddataos.chengdu.transactions', { start_date: '2026-10-27', end_date: '2026-10-01' }, credential), /起始日期/)
  assert.throws(() => cddataosCallPlan('cddataos.chengdu.transactions', { start_date: '2026-02-30', end_date: '2026-10-01' }, credential), /YYYY-MM-DD/)
  const land = cddataosCallPlan('cddataos.enterprise.land', { type: '2', keyword: '测试企业', auth_authorizeFileCode: 'TEST-AUTH', skip: '0' }, credential)
  assert.equal(land.headers.productCode, 'YY202511211763686834203:V1')
  const risk = cddataosCallPlan('cddataos.property.risk', { address: '测试地址', auth_authorizeFileCode: 'TEST-AUTH' }, credential)
  assert.equal(risk.headers.productCode, 'YY202511261764136870253:V1')
})

test('encrypted response decodes and supplier failure does not leak raw data', () => {
  const payload = { rows: [{ total: 42 }] }
  const success = normalizeCddataosResponse(200, JSON.stringify({ code: '200', content: cddataosEncrypt(JSON.stringify(payload), credential), requestId: 'req-1', fee: 1 }), credential, provenance)
  assert.equal(success.ok, true)
  assert.deepEqual(success.data, { content: payload, requestId: 'req-1', fee: 1 })
  const failure = normalizeCddataosResponse(200, JSON.stringify({ code: '500003', message: credential.accessSecret }), credential, provenance)
  assert.equal(failure.ok, false)
  assert.match(failure.error.correction, /IP 白名单/)
  assert.ok(!JSON.stringify(failure).includes(credential.accessSecret))
  const noData = normalizeCddataosResponse(200, JSON.stringify({ code: '30000', fee: 0 }), credential, provenance)
  assert.equal(noData.error.code, 'CDDATAOS_30000')
  assert.match(noData.error.correction, /数据源查无/)
  assert.match(noData.error.correction, /YYYY-MM-DD/)
  assert.match(noData.error.correction, /不能证明不支持月度/)
  assert.equal(noData.error.details.feeCharged, false)
  const landNoData = normalizeCddataosResponse(200, JSON.stringify({ code: '30000', fee: 0 }), credential, { ...provenance, operation: 'cddataos.enterprise.land' })
  assert.match(landNoData.error.correction, /企业全名/)
  assert.match(landNoData.error.correction, /城市名不适用/)
  const propertyNoData = normalizeCddataosResponse(200, JSON.stringify({ code: '30000', fee: 0 }), credential, { ...provenance, operation: 'cddataos.property.risk' })
  assert.match(propertyNoData.error.correction, /精确到户/)
  assert.match(normalizeCddataosResponse(200, JSON.stringify({ code: '300005' }), credential, provenance).error.correction, /产品权限/)
})

test('host registers only when configured and allowed, and missing auth fails closed', async () => {
  const ctx = { get: () => undefined }
  const opts = { cddataos: { baseUrl: 'https://example.invalid' }, allowedProviders: ['cddataos'] }
  const missing = new ProviderTransportService(ctx, { ...opts, credentials: () => undefined })
  assert.deepEqual(missing.providers, ['cddataos'])
  assert.ok(!missing.availableCredentials().includes('CDDATAOS_CREDENTIALS'))
  const denied = new ProviderTransportService(ctx, { ...opts, allowedProviders: [] })
  assert.deepEqual(denied.providers, [])
})

test('host sends encrypted POST through the registered binding and returns provenance', async () => {
  const calls = []
  const service = new ProviderTransportService({ get: () => undefined }, {
    cddataos: { baseUrl: 'https://example.invalid' }, allowedProviders: ['cddataos'],
    credentials: () => credJson,
    fetch: async request => {
      calls.push(request)
      return { status: 200, body: JSON.stringify({ code: '200', content: cddataosEncrypt('{"total":42}', credential), fee: 0 }), truncated: false }
    },
  })
  const resolved = service.resolver.resolve({ capability: 'realestate.cddataos.chengdu-transactions', constraints: { availableCredentials: service.availableCredentials() } })
  assert.equal(resolved.status, 'bound')
  const result = await service.invoke({ binding: resolved.binding, input: { start_date: '2026-10-01', end_date: '2026-10-27' } })
  assert.equal(result.ok, true)
  assert.equal(result.provenance.caliber, '成都新房与存量房成交统计；不定期更新；时间窗口对应的汇总口径待供应商确认')
  assert.equal(result.data.content.total, 42)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.equal(new URL(calls[0].url).pathname, '/xs-api/data-service-platform/api/platform/service/call')
  assert.ok(!JSON.stringify(service.audit()).includes(credential.accessSecret))
  assert.ok(!JSON.stringify(result).includes(credential.accessSecret))
})

test('host routes enterprise land and property risk to their own product codes', async () => {
  const requests = []
  const service = new ProviderTransportService({ get: () => undefined }, {
    cddataos: { baseUrl: 'https://example.invalid' }, allowedProviders: ['cddataos'],
    credentials: () => credJson,
    fetch: async request => {
      requests.push(request)
      return { status: 200, body: JSON.stringify({ code: '200', content: cddataosEncrypt('{"items":[{"id":"sample"}]}', credential), fee: 0 }), truncated: false }
    },
  })
  const cases = [
    ['realestate.cddataos.enterprise-land', { type: '5', keyword: '示例企业有限公司', auth_authorizeFileCode: 'AUTHORIZED-SAMPLE' }, 'YY202511211763686834203:V1'],
    ['realestate.cddataos.property-risk', { address: '示例省示例市示例路1号1栋1单元101室', auth_authorizeFileCode: 'AUTHORIZED-SAMPLE', match_mode: '1' }, 'YY202511261764136870253:V1'],
  ]
  for (const [capability, input, productCode] of cases) {
    const resolved = service.resolver.resolve({ capability, constraints: { availableCredentials: service.availableCredentials() } })
    assert.equal(resolved.status, 'bound')
    const result = await service.invoke({ binding: resolved.binding, input })
    assert.equal(result.ok, true)
    assert.equal(result.data.content.items[0].id, 'sample')
    assert.equal(requests.at(-1).headers.productCode, productCode)
  }
  assert.equal(requests.length, 2)
})
