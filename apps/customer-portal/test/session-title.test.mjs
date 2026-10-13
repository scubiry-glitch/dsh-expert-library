import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountStore } from '../account-store.mjs'
import { titleFromUserMessage } from '../session-title.mjs'

test('a clear user request gets a short title while greetings and links keep the placeholder', () => {
  assert.equal(titleFromUserMessage('你好'), null)
  assert.equal(titleFromUserMessage('https://example.com'), null)
  assert.equal(titleFromUserMessage('请帮我写一篇报告'), null)
  assert.equal(titleFromUserMessage('我想做一个研究'), null)
  assert.equal(titleFromUserMessage('请帮我分析南京二手房价格走势。后续再看成交量。'), '分析南京二手房价格走势')
  assert.equal(titleFromUserMessage('研究贵州租金'), '研究贵州租金')
})

test('automatic title is once-only, account-scoped, and cannot replace a manual title', t => {
  const store = new AccountStore()
  t.after(() => store.close())
  const accountA = store.provisionAccount({ slug: 'a' })
  const accountB = store.provisionAccount({ slug: 'b' })
  store.provisionMember({ accountId: accountA, issuer: 'https://id.test', subject: 'a', displayName: 'A' })
  store.provisionMember({ accountId: accountB, issuer: 'https://id.test', subject: 'b', displayName: 'B' })
  const principalA = store.issueBrowserSession({ accountId: accountA, issuer: 'https://id.test', subject: 'a' }).principal
  const principalB = store.issueBrowserSession({ accountId: accountB, issuer: 'https://id.test', subject: 'b' }).principal
  const first = store.createResearchSession({ principal: principalA, requestId: 'first-title-test' })
  assert.equal(store.setAutomaticSessionTitle(principalB, first.id, '别人的标题'), false)
  assert.equal(store.setAutomaticSessionTitle(principalA, first.id, '南京二手房价格走势'), true)
  assert.equal(store.setAutomaticSessionTitle(principalA, first.id, '第二次改名'), false)
  assert.equal(store.getResearchSession(principalA, first.id).title, '南京二手房价格走势')

  const second = store.createResearchSession({ principal: principalA, requestId: 'second-title-test' })
  store.updateSessionPreference(principalA, second.id, { title: '用户自己起的名字' })
  assert.equal(store.setAutomaticSessionTitle(principalA, second.id, '自动建议'), false)
  assert.equal(store.sessionPreference(principalA, second.id).titleOverride, '用户自己起的名字')
})
