import test from 'node:test'
import assert from 'node:assert/strict'
import { addOsaServiceCards, osaDemoPlan, serviceCardsForTurn } from '../osa-service-cards.mjs'

test('only an explicit synthetic OSA seed identifies a demo plan', () => {
  assert.equal(osaDemoPlan([{ role: 'user', text: '林女士买房，帮我看看贷款' }]), null)
  assert.equal(osaDemoPlan([{ role: 'user', text: '【CAgent 场景初始化】\nOSA 客户计划：林女士置换（只读合成模板 lin-case）。' }]), 'lin-case')
  assert.equal(osaDemoPlan([{ role: 'user', text: '【CAgent 场景初始化】\n只读合成模板 unknown-plan' }]), null)
  assert.equal(osaDemoPlan([{ role: 'user', text: '【CAgent 场景初始化】\n客户：林女士，正在考虑卖房与买房置换。' }]), 'lin-case')
})

test('replacement payment gap gives service information and a housing loan checklist, not consumer credit', () => {
  const cards = serviceCardsForTurn('lin-case', '新房首付先到，旧房款未回，我该怎么安排？')
  assert.deepEqual(cards.map(card => card.id), ['demo-housing-plan', 'demo-jsb-housing-loan'])
  assert.ok(cards.every(card => card.source && card.version && card.expiresAt && card.boundary))
  assert.ok(cards.every(card => !/消费贷/.test(card.title)))
  assert.deepEqual(serviceCardsForTurn('lin-case', '不要推荐银行产品，我先自己算'), [])
  assert.deepEqual(serviceCardsForTurn('lin-case', '旧房没挂牌').map(card => card.id), [])
  assert.deepEqual(serviceCardsForTurn('lin-case', '旧房款会晚到，但我不想贷款').map(card => card.id), ['demo-housing-plan'])
})

test('other scenarios start with service material and require an explicit separate consumption need', () => {
  assert.deepEqual(serviceCardsForTurn('osa-young-rent-save', '我租房攒首付').map(card => card.id), ['jsb-first-home-plan'])
  assert.deepEqual(serviceCardsForTurn('osa-elder-travel-rent', '我想异地旅居试住').map(card => card.id), ['travel-stay-verify'])
  assert.deepEqual(serviceCardsForTurn('osa-elder-family-transition', '退休后照护和居住怎么安排').map(card => card.id), ['jsb-family-pension'])
  assert.deepEqual(serviceCardsForTurn('osa-young-multicity', '我经常跨城工作').map(card => card.id), [])
  assert.deepEqual(serviceCardsForTurn('osa-young-multicity', '我想核对信用卡账单和权益').map(card => card.id), ['jsb-card-crosscity-bill'])
  assert.deepEqual(serviceCardsForTurn('lin-case', '交房后要装修，想比较贷款成本').map(card => card.id), ['jsb-online-consumer-loan-renovation'])
  assert.deepEqual(serviceCardsForTurn('lin-case', '交房后装修和新房首付都缺钱').map(card => card.id), ['demo-housing-plan', 'demo-jsb-housing-loan'])
})

test('cards attach under an assistant turn only; expired cards are withheld', () => {
  const page = { messages: [
    { role: 'user', text: '【CAgent 场景初始化】\n只读合成模板 lin-case', seq: 0 },
    { role: 'assistant', text: '先确认您的目标', seq: 1 },
    { role: 'user', text: '新房首付先到、旧房款未回', seq: 2 },
    { role: 'assistant', text: '先核对资金节点', seq: 3 },
    { role: 'assistant', text: '补充说明', seq: 4 },
  ] }
  const result = addOsaServiceCards(page, 'lin-case')
  assert.equal(result.messages[1].serviceCards, undefined)
  assert.equal(result.messages[2].serviceCards, undefined)
  assert.equal(result.messages[3].serviceCards.length, 2)
  assert.equal(result.messages[4].serviceCards, undefined)
  assert.equal(page.messages[3].serviceCards, undefined)
  assert.deepEqual(serviceCardsForTurn('lin-case', '首付', new Date('2027-04-01T00:00:00+08:00')), [])
})

test('the same card stays hidden for seven assistant turns while other cards can appear', () => {
  const messages = [{ role: 'user', text: '【CAgent 场景初始化】\n只读合成模板 lin-case', seq: 0 }]
  for (let turn = 1; turn <= 10; turn++) {
    messages.push({ role: 'user', text: turn === 1 ? '置换怎么安排' : '新房首付先到、旧房款未回', seq: turn * 2 - 1 })
    messages.push({ role: 'assistant', text: `回复 ${turn}`, seq: turn * 2 })
  }
  const full = addOsaServiceCards({ messages }, 'lin-case').messages.filter(message => message.role === 'assistant')
  assert.deepEqual(full.map(message => message.serviceCards?.map(card => card.id) || []), [
    ['demo-housing-plan'], ['demo-jsb-housing-loan'], [], [], [], [], [], [],
    ['demo-housing-plan'], ['demo-jsb-housing-loan'],
  ])
  const paged = addOsaServiceCards({ messages: messages.slice(-4) }, 'lin-case', messages.slice(0, -4))
  assert.deepEqual(paged.messages.filter(message => message.role === 'assistant')
    .map(message => message.serviceCards?.map(card => card.id) || []),
    [['demo-housing-plan'], ['demo-jsb-housing-loan']])
})
