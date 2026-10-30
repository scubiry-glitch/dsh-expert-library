import test from 'node:test'
import assert from 'node:assert/strict'
import { customerMentions, unavailableCustomerMention, verifyCustomerMentionSelections } from '../src/host/customer-mentions.ts'

test('customer mention catalog only offers providers with effective credentials', () => {
  const inventory = {
    providers: ['zyt', 'beike', 'wind', 'localdb'],
    availableCredentials: () => ['ZYT_API_KEY'],
    localDbDatabases: () => [{ id: 'public-demo' }, { id: 'private-sales', sensitivity: 'internal' }],
  }
  const mentions = customerMentions(inventory)
  assert.deepEqual(mentions, [
    { name: '智见', kind: 'data-source', provider: 'zyt' },
    { name: '数据-public-demo', kind: 'data-source', provider: 'localdb' },
  ])
  assert.equal(unavailableCustomerMention('@智见，查一下这个月的数据', mentions), undefined)
  assert.equal(unavailableCustomerMention('请 @贝壳 查询', mentions), '贝壳')
  assert.equal(unavailableCustomerMention('发邮件到 a@example.com', mentions), undefined)
})

test('a typed expert name cannot select a capability or replay an old version', () => {
  const expert = { kind: 'expert', id: 'bk-002', version: '1.1.0', name: '制度派X教授·bk-002',
    description: '政策制度', packId: 'zhijian-realestate', packVersion: '1.6.2',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }
  const text = `@${expert.name} 北京租金数据怎么看？`
  assert.equal(verifyCustomerMentionSelections(text, [expert], []), undefined)
  assert.equal(verifyCustomerMentionSelections(text, [expert], [{ kind: expert.kind, id: expert.id,
    version: '1.0.0', name: expert.name }]), undefined)
  assert.deepEqual(verifyCustomerMentionSelections(text, [expert], [{ kind: expert.kind, id: expert.id,
    version: expert.version, name: expert.name }]), [expert])
  assert.equal(verifyCustomerMentionSelections('@未知 请回答', [expert], []), undefined)
})

test('cddataos mention appears only with the provider grant and credential', () => {
  const inventory = {
    providers: ['cddataos'],
    availableCredentials: () => ['CDDATAOS_CREDENTIALS'],
    localDbDatabases: () => [],
  }
  assert.deepEqual(customerMentions(inventory), [{ name: '成都数据运营平台', kind: 'data-source', provider: 'cddataos' }])
  assert.deepEqual(customerMentions({ ...inventory, availableCredentials: () => [] }), [])
})
