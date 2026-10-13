// Curated, versioned information for synthetic OSA sessions only. This module does not
// write to DSH, change the model prompt, or infer a customer's financial eligibility.
const VALID_UNTIL = '2027-03-31'
const cards = {
  timeline: {
    id: 'demo-housing-plan', kind: 'service', title: '置换资金时间轴咨询', provider: '江苏银行（演示）',
    summary: '把新房付款、旧房预计回款、过渡居住和备用金放在同一张时间表。',
    reason: '客户担心新房付款早于旧房回款，需要先算清时间差和资金缺口。',
    checks: '请先确认新房成交价与付款日、旧房成交状态及扣费后的可得金额。',
    alternative: '也可先与经纪人核实成交进度，比较先卖后买、调整付款节点。',
    boundary: '只提供测算框架；不承诺过桥资金、贷款额度或放款日期。',
    source: 'DEMO-JSB-PRODUCT-001 / jsb-replace-timeline', version: 'v1.1', expiresAt: VALID_UNTIL,
    href: '/tenant-studio/#packs',
  },
  housing: {
    id: 'demo-jsb-housing-loan', kind: 'product', title: '个人住房贷款条件核对', provider: '江苏银行（演示）',
    summary: '查看住房贷款需要核验的购房用途、材料、还款安排和正式审批节点。',
    reason: '如时间轴显示存在真实购房融资需求，再核对住房贷款条件。',
    checks: '房价、首付款来源、现有贷款、收入及本地政策均须由银行正式核验。',
    alternative: '可比较其他银行正式住房贷款方案，或调整买卖和付款顺序。',
    boundary: '这是业务说明，不是授信建议；利率、费用、额度以正式披露和审批为准。消费贷不得用于购房付款。',
    source: 'DEMO-JSB-PRODUCT-002', version: 'v1.0', expiresAt: VALID_UNTIL,
    href: '/tenant-studio/#products',
  },
  firstHome: {
    id: 'jsb-first-home-plan', kind: 'service', title: '首套购房资金准备导览', provider: '江苏银行（演示）',
    summary: '按租金、可稳定储蓄额、应急金和目标时间整理购房准备清单。',
    reason: '客户还在租住并准备未来购房，先看资金积累进度更有用。',
    checks: '目标城市、购房时间、可用现金及日常开支仍需确认。',
    alternative: '可先使用清单自行储蓄和调整目标时间。',
    boundary: '不预判购房资格、贷款额度或理财收益。',
    source: 'DEMO-JSB-PRODUCT-002 / jsb-first-home-plan', version: 'v0.1', expiresAt: VALID_UNTIL,
    href: '/tenant-studio/#packs',
  },
  travel: {
    id: 'travel-stay-verify', kind: 'service', title: '异地旅居试住房源核验', provider: '旅居住房与家庭服务（演示）',
    summary: '按目的地、期限、预算、医疗交通和无障碍需求整理试住核验清单。',
    reason: '客户先要判断三个月试住是否可行，需要可核验的住处条件。',
    checks: '实际房源、价格、退订规则和服务可用性须逐项确认。',
    alternative: '也可先自行比较短租房源和当地公共服务。',
    boundary: '无实时库存或报价；查看资料不代表预约。',
    source: 'DEMO-TRAVEL-PRODUCT-001 / travel-stay-verify', version: 'v0.1', expiresAt: VALID_UNTIL,
    href: '/tenant-studio/#packs',
  },
  pension: {
    id: 'jsb-family-pension', kind: 'service', title: '家庭养老资金与居住安排咨询', provider: '江苏银行（演示）',
    summary: '先梳理家庭现金需求、居住选择和照护支出，再看养老金融业务类别。',
    reason: '客户的居住和照护计划影响资金期限，先区分需求才能比较服务。',
    checks: '家庭收支、风险承受能力及办理条件须进一步核实。',
    alternative: '可先做家庭沟通和公共养老服务查询。',
    boundary: '不推荐具体理财、信托或保险产品，不承诺收益或税收优惠。',
    source: 'DEMO-JSB-PRODUCT-003 / jsb-family-pension', version: 'v0.1', expiresAt: VALID_UNTIL,
    href: '/tenant-studio/#packs',
  },
  cardBill: {
    id: 'jsb-card-crosscity-bill', kind: 'service', title: '跨城生活账单与信用卡权益核对', provider: '江苏银行（演示）',
    summary: '对照实际消费、还款日、年费和现有支付方式，核验权益适用城市。',
    reason: '客户主动询问信用卡或账单时，先比较已有支付安排。',
    checks: '需核对费用、还款能力及权益最新条款。',
    alternative: '可继续使用借记卡或现有信用卡。',
    boundary: '不承诺办卡、额度或优惠；不因跨城生活自动推荐办卡。',
    source: 'DEMO-JSB-PRODUCT-004 / jsb-card-crosscity-bill', version: 'v0.1', expiresAt: VALID_UNTIL,
    href: '/tenant-studio/#packs',
  },
  renovation: {
    id: 'jsb-online-consumer-loan-renovation', kind: 'service', title: '交房后装修支出与贷款成本核验', provider: '江苏银行（演示）',
    summary: '对照装修合同、分阶段支出、自有资金与不借款方案的总成本。',
    reason: '仅当客户明确提出独立的交房后装修消费融资需求时提供。',
    checks: '实际用途、报价、已有债务和可承担还款需核实。',
    alternative: '可缩小或分阶段装修，先使用自有资金。',
    boundary: '不得用于购房首付、房款或偿还房贷；不承诺额度和利率。',
    source: 'DEMO-JSB-PRODUCT-008 / jsb-online-consumer-loan-renovation', version: 'v0.1', expiresAt: VALID_UNTIL,
    href: '/tenant-studio/#packs',
  },
}

const planIds = new Set(['lin-case', 'osa-sell-two-buy-one', 'osa-young-rent-save',
  'osa-elder-travel-rent', 'osa-elder-family-transition', 'osa-young-multicity'])
const CARD_COOLDOWN_TURNS = 7
const declined = /(?:不需要|不要|不想|不用|暂不|别)(?:.{0,8})(?:银行|产品|服务|联系|推荐)/

export function osaDemoPlan(messages) {
  const seed = messages?.find(message => message?.role === 'user'
    && typeof message.text === 'string' && message.text.startsWith('【CAgent 场景初始化】'))?.text
  const plan = seed?.match(/只读合成模板\s+([a-z0-9-]+)/)?.[1]
  if (planIds.has(plan)) return plan
  // Early synthetic CAgent sessions predate the explicit plan ID in the init text.
  if (seed && /客户：林女士/.test(seed) && /卖房与买房置换|置换资金/.test(seed)) return 'lin-case'
  return null
}

export function serviceCardsForTurn(planId, userText, now = new Date()) {
  const text = String(userText || '').trim()
  if (!text || declined.test(text) || !planIds.has(planId) || now > new Date(`${VALID_UNTIL}T23:59:59+08:00`)) return []
  const housingPayment = /首付|房款|买房|购房|新房付款|旧房回款/
  const independentRenovation = /(?:交房后|入住后|搬家后).{0,15}(?:装修|家电家具)|(?:装修|家电家具).{0,15}(?:交房后|入住后|搬家后)/
  if (['lin-case', 'osa-sell-two-buy-one'].includes(planId)) {
    if (independentRenovation.test(text) && !housingPayment.test(text)) return [cards.renovation]
    const timingNeed = /置换|先卖后买|先买后卖|首付|房款|资金|房贷|住房贷款|购房贷款|旧房回款|新房付款/.test(text)
    if (!timingNeed) return []
    const declinesLoan = /不贷|不借钱|(?:不想|不要|不需要|不考虑|暂不)(?:.{0,4})贷款/.test(text)
    const financeNeed = /首付|房款|资金|房贷|住房贷款|购房贷款|融资/.test(text)
    return financeNeed && !declinesLoan ? [cards.timeline, cards.housing] : [cards.timeline]
  }
  if (planId === 'osa-young-rent-save') return /租房|租金|攒|首套|购房|买房|房贷|首付|资金/.test(text) ? [cards.firstHome] : []
  if (planId === 'osa-elder-travel-rent') return /旅居|试住|房源|异地|家庭服务|家里服务/.test(text) ? [cards.travel] : []
  if (planId === 'osa-elder-family-transition') return /养老|退休|照护|居住|家庭资金/.test(text) ? [cards.pension] : []
  if (planId === 'osa-young-multicity') return /信用卡|账单|还款|支付权益/.test(text) ? [cards.cardBill] : []
  return []
}

export function addOsaServiceCards(page, planId, precedingMessages = []) {
  if (!planId || !Array.isArray(page?.messages)) return page
  let lastUser = ''
  let assistantTurn = 0
  const shownAt = new Map()
  function decorate(message, includeCards) {
    if (message.role === 'user') {
      if (message.text?.startsWith('【CAgent 场景初始化】')
        || message.text?.startsWith('【CAgent 机构资料更新】')) lastUser = ''
      else lastUser = message.text
      return message
    }
    if (message.role !== 'assistant') return message
    assistantTurn++
    const serviceCards = message.interrupted || message.truncated ? [] : serviceCardsForTurn(planId, lastUser)
      .filter(card => assistantTurn - (shownAt.get(card.id) ?? -Infinity) > CARD_COOLDOWN_TURNS)
    lastUser = ''
    for (const card of serviceCards) shownAt.set(card.id, assistantTurn)
    return includeCards && serviceCards.length ? { ...message, serviceCards } : message
  }
  for (const message of precedingMessages) decorate(message, false)
  return { ...page, messages: page.messages.map(message => decorate(message, true)) }
}
