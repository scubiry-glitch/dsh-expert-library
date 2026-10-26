const requestIdPattern = /^[A-Za-z0-9_-]{8,128}$/
const clean = (value, max) => typeof value === 'string' && value.trim().length > 0
  && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : undefined

export function taskRequest(body) {
  if (!body || !requestIdPattern.test(body.requestId ?? '')) return undefined
  if (body.kind === 'custom') {
    if (Object.keys(body).some(key => !['requestId', 'kind', 'goal'].includes(key))) return undefined
    const goal = clean(body.goal, 4000)
    if (!goal) return undefined
    return { requestId: body.requestId, kind: 'custom', title: goal.slice(0, 80),
      prompt: `请把以下目标作为当前会话的一项独立任务处理。任务编号：${body.requestId}。\n\n${goal}\n\n请在当前会话直接推进；需要信息时只问影响执行的关键问题。完成后给出结果。若生成 DOCX、PDF 或 Markdown 文件，请调用 customer_publish_document 登记真实文件，resultKey 使用任务编号 ${body.requestId}，再提供返回的 downloadUrl。` }
  }
  if (body.kind === 'bank-property-value') {
    if (Object.keys(body).some(key => !['requestId', 'kind', 'city', 'community', 'area', 'branch', 'firm'].includes(key))) return undefined
    const city = clean(body.city, 80), community = clean(body.community, 120)
    const branch = body.branch === '' || body.branch === undefined ? '' : clean(body.branch, 120)
    const firm = body.firm === '' || body.firm === undefined ? '' : clean(body.firm, 120)
    const area = Number(body.area)
    if (!city || !community || branch === undefined || firm === undefined
      || !Number.isFinite(area) || area < 10 || area > 10000) return undefined
    return { requestId: body.requestId, kind: 'bank-property-value',
      title: `${community} ${area}㎡房产价值报告`,
      prompt: `请在当前会话完成银行房产价值评估报告任务。任务编号：${body.requestId}。\n城市：${city}\n小区：${community}\n建筑面积：${area} 平方米\n支行名称：${branch || '留空'}\n评估公司名称：${firm || '留空'}\n\n使用当前账号已授权的银行房产价值评估领域包及其 Word 模板，查询贝壳和中银通（zyt）可用数据，记录来源、时间和口径。严格按模板生成真实 DOCX，校验文件可打开及关键字段无遗漏。无法核实的字段留空或明确写“未取得”，不得编造数字、案例或小区评价；报告正文不要出现“待审核”“待调研”等内部过程标签。生成后必须调用 customer_publish_document，file 指向工作空间内的成品 DOCX，resultKey 使用任务编号 ${body.requestId}，resultLabel 使用“${community}房产价值报告”；只有工具成功返回后才能告诉用户“下载 Word”，并提供返回的 downloadUrl。若工具或数据源失败，说明具体阻碍，不声称已交付。` }
  }
  return undefined
}

export function hasTaskReply(row, messages) {
  const sent = messages.find(message => message.role === 'user'
    && typeof message.text === 'string' && message.text.includes(`任务编号：${row.requestId}`))
  return !!sent && messages.some(message => message.role === 'assistant' && message.seq > sent.seq)
}

export function taskView(row, documents, messages, running) {
  const files = documents.filter(item => item.resultKey === `conversation:${row.requestId}`)
  const hasRequiredFile = row.kind === 'bank-property-value'
    ? files.some(item => /\.docx$/i.test(item.name) && item.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    : files.length > 0
  const answered = !!row.replySeen || hasTaskReply(row, messages)
  const status = hasRequiredFile ? 'delivered'
    : row.dispatchState !== 'accepted' ? row.dispatchState
    : running ? 'running' : answered && row.kind === 'bank-property-value' ? 'needs_file'
    : answered ? 'responded' : 'running'
  return { id: row.id, requestId: row.requestId, kind: row.kind, title: row.title,
    createdAt: row.createdAt, status,
    files: files.map(item => ({ id: item.id, name: item.name, mediaType: item.mediaType,
      href: `/api/sessions/${row.sessionId}/workspace/documents/conversation/${item.id}/download` })) }
}
