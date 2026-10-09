import { el, api, button, field, notice, statusBadge, formatDate, showError, runAction } from './shared.js'

// Only uncertain writes retain an in-memory operation ID. No credentials or
// browser storage are involved; an identical user retry reuses the same key.
const pendingWrites = new Map()
let operationActor
const pageSize = 20
const submissionStatusLabels = {
  draft: '草稿', validating: '校验中', validated: '校验通过', validation_failed: '校验失败', pending_review: '待审核',
  approved: '已批准', changes_requested: '待修订', rejected: '已拒绝', withdrawn: '已撤回',
}
const decisions = { approved: '通过审核', changes_requested: '退回修改', rejected: '拒绝提交' }
const settledStatuses = new Set(['validated', 'validation_failed', 'approved', 'changes_requested', 'rejected', 'withdrawn'])
const test = value => ({ 'data-testid': value })
const members = principal => principal.memberships ?? []
const hasOrgRole = (principal, organizationId, roles) => principal.platformAdmin || members(principal).some(member => member.organizationId === organizationId && member.roles.some(role => roles.includes(role)))
const hasReviewerRole = principal => members(principal).some(member => member.roles.includes('reviewer'))
const reviewScope = (principal, organizationId) => hasReviewerRole(principal) && (principal.reviewScopes ?? []).includes(organizationId)
// Authoring authority is pack-level (owner/maintainer) server-side; the UI
// approximates with authorship plus plain tenant membership.
const canAuthor = (principal, submission) => (submission.authorId === principal.userId || hasOrgRole(principal, submission.ownerOrgId, ['admin'])) && hasOrgRole(principal, submission.ownerOrgId, ['member', 'admin'])
const organizationName = (ctx, id) => ctx.organizations.find(organization => organization.id === id)?.name || id
const detailPath = id => `submissions/${encodeURIComponent(id)}`
const apiPath = id => `/api/submissions/${encodeURIComponent(id)}`
const input = (id, value = '', attrs = {}) => el('input', { id, name: id, type: 'text', value, ...test(id), ...attrs })
const textarea = (id, value = '', attrs = {}) => el('textarea', { id, name: id, value, rows: 4, ...test(id), ...attrs })
const code = value => el('code', {}, String(value ?? '—'))
const paragraph = value => el('p', {}, String(value ?? '—'))
const empty = text => notice(text, 'info')
const invalid = message => Object.assign(new Error(message), { code: 'INVALID_INPUT', clientValidation: true, userMessage: message })

async function withLockedForm(form, action) {
  // Preserve intentionally disabled organization/recipient controls as well as
  // the submit button state owned by runAction. Always restore on local errors,
  // rejected writes, cancellation, and successful navigation.
  const controls = Array.from(form.elements, control => [control, control.disabled])
  for (const [control] of controls) control.disabled = true
  const previousBusy = form.getAttribute('aria-busy')
  form.setAttribute('aria-busy', 'true')
  try { return await action() }
  finally {
    for (const [control, disabled] of controls) control.disabled = disabled
    if (previousBusy === null) form.removeAttribute('aria-busy')
    else form.setAttribute('aria-busy', previousBusy)
  }
}

async function write(ctx, path, body, method = 'POST') {
  if (ctx.signal.aborted) return null
  const fingerprint = JSON.stringify([ctx.principal.userId, method, path, body])
  let key = pendingWrites.get(fingerprint)
  if (!key) { key = crypto.randomUUID(); pendingWrites.set(fingerprint, key) }
  try {
    const result = await api(path, { method, body, key, signal: ctx.signal })
    pendingWrites.delete(fingerprint)
    return result
  } catch (error) {
    // Explicit client failures have a known outcome. Network/parse/5xx results
    // may hide an already committed transaction and must keep the retry key.
    if (error?.status >= 400 && error.status < 500 && error.status !== 408) pendingWrites.delete(fingerprint)
    throw error
  }
}

function shell(ctx, title, description) {
  const body = el('section', { className: 'stack', ...test('submissions-page') })
  ctx.root.replaceChildren(el('header', { className: 'page-heading' }, el('h1', {}, title), paragraph(description)), body)
  return body
}

function card(title, ...children) {
  return el('section', { className: 'card stack' }, el('h2', {}, title), ...children)
}

function keyValues(rows) {
  const list = el('dl', { className: 'detail-grid' })
  for (const [label, value] of rows) list.append(el('dt', {}, label), el('dd', {}, value instanceof Node ? value : String(value ?? '—')))
  return list
}

function jsonBlock(title, value) {
  return el('details', {}, el('summary', {}, title), el('pre', {}, JSON.stringify(value, null, 2)))
}

function routeQuery(route, query) {
  const encoded = query.toString()
  return encoded ? `${route}?${encoded}` : route
}

function organizationPicker(organizations, selected, id, onChange) {
  const select = el('select', { id, name: id, ...test(id), onChange })
  for (const organization of organizations) select.append(el('option', { value: organization.id }, `${organization.name} · ${organization.id}`))
  select.value = selected
  return select
}

async function renderList(ctx, reviewing) {
  const route = reviewing ? 'reviews' : 'submissions'
  const body = shell(ctx, reviewing ? '待审核队列' : '我的提交', reviewing ? '仅展示已分配审核范围中的待审快照；作者不能审核自己的提交。' : '开发者可查看自己的提交，组织管理员可查看本组织提交。')
  let organizations
  if (reviewing) {
    if (!hasReviewerRole(ctx.principal)) { body.append(notice('无审核权限：需要有效 reviewer 角色和已分配的组织审核范围。', 'warning')); return }
    organizations = (ctx.principal.reviewScopes ?? []).map(id => ({ id, name: organizationName(ctx, id) }))
  } else {
    organizations = ctx.organizations.filter(organization => organization.status === 'active' && hasOrgRole(ctx.principal, organization.id, ['member', 'reviewer', 'admin']))
  }
  if (!organizations.length) { body.append(empty(reviewing ? '尚未分配任何可审核组织。请联系平台管理员配置审核范围。' : '没有可查看提交的有效组织。请联系组织管理员。')); return }
  const organizationId = ctx.query.get('organizationId') || organizations[0].id
  if (!organizations.some(organization => organization.id === organizationId)) { body.append(notice('当前组织不在你的可访问范围内。', 'warning')); return }
  const picker = organizationPicker(organizations, organizationId, reviewing ? 'review-organization' : 'submission-organization', event => ctx.navigate(routeQuery(route, new URLSearchParams({ organizationId: event.target.value }))))
  const toolbar = el('div', { className: 'toolbar' }, field(reviewing ? '审核组织' : '所属组织', picker))
  const activeStatus = ctx.query.get('status') ?? ''
  const activePackId = ctx.query.get('packId') ?? ''
  const statusOptions = [['', '全部状态'], ...Object.entries(submissionStatusLabels).map(([value, label]) => [value, label])]
  const statusSelect = el('select', { id: reviewing ? 'review-status' : 'submission-status', 'data-testid': reviewing ? 'review-status' : 'submission-status' },
    ...statusOptions.map(([value, label]) => el('option', { value, ...(activeStatus === value ? { selected: true } : {}) }, label)))
  const packIdInput = el('input', { id: reviewing ? 'review-pack-id' : 'submission-pack-id', type: 'text', value: activePackId, maxLength: 64, placeholder: '领域包 ID 包含…', 'data-testid': reviewing ? 'review-pack-id' : 'submission-pack-id' })
  const applyFilters = () => {
    const next = new URLSearchParams({ organizationId })
    const status = statusSelect.value
    const packId = packIdInput.value.trim()
    if (status) next.set('status', status)
    if (packId) next.set('packId', packId)
    ctx.navigate(routeQuery(route, next))
  }
  statusSelect.addEventListener('change', applyFilters)
  packIdInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); applyFilters() } })
  toolbar.append(field('状态', statusSelect), field('领域包', packIdInput))
  if (activeStatus || activePackId) toolbar.append(button('清除筛选', () => ctx.navigate(routeQuery(route, new URLSearchParams({ organizationId }))), { ...test('submissions-clear-filters') }))
  toolbar.append(button('筛选', applyFilters, { ...test('submissions-apply-filters') }))
  if (!reviewing && ctx.principal.developer && hasOrgRole(ctx.principal, organizationId, ['member', 'admin'])) toolbar.append(button('新建提交', () => ctx.navigate(routeQuery('submissions/new', new URLSearchParams({ organizationId }))), { kind: 'primary', ...test('new-submission') }))
  const errors = el('div', { role: 'status' })
  toolbar.append(button('刷新列表', event => runAction(event.currentTarget, () => ctx.navigate(routeQuery(route, ctx.query)), errors), { ...test('submissions-refresh') }))
  const contents = el('div', { className: 'stack' }, empty('正在加载提交…'))
  body.append(toolbar, errors, contents)
  const recordsMode = reviewing || ctx.query.has('records')
  const query = new URLSearchParams({ organizationId, limit: String(pageSize) })
  if (!recordsMode) query.set('groupBy', 'pack')
  if (activeStatus) query.set('status', activeStatus)
  if (activePackId) query.set('packId', activePackId)
  if (recordsMode && ctx.query.has('beforeId')) query.set('beforeId', ctx.query.get('beforeId'))
  if (!recordsMode && ctx.query.has('afterPack')) query.set('afterPack', ctx.query.get('afterPack'))
  try {
    const result = await api(`/api/${route}?${query}`, { signal: ctx.signal })
    if (ctx.signal.aborted) return
    contents.replaceChildren()
    const keepFilters = () => { const next = new URLSearchParams({ organizationId }); if (activeStatus) next.set('status', activeStatus); if (activePackId) next.set('packId', activePackId); return next }
    if (!recordsMode) {
      if (!result.items.length) contents.append(empty('没有符合条件的包。可调整筛选条件，或新建提交。'))
      else {
        const upstreamCell = pack => {
          const out = el('div', { role: 'status' })
          out.append(button('检查上游', async event => {
            const control = event.currentTarget
            control.disabled = true
            out.replaceChildren(paragraph('检查中…'))
            try {
              const r = await api(`/api/submissions/${encodeURIComponent(pack.submission.id)}/upstream`, { signal: ctx.signal, timeoutMs: 90000 })
              if (ctx.signal.aborted) return
              const same = r.matches === true
              out.replaceChildren(notice(same ? '一致，无新提交。' : `上游有新提交：HEAD ${r.upstreamHead || '未知'}`, same ? 'info' : 'warning'))
            } catch (error) {
              if (ctx.signal.aborted) return
              const errorCode = error?.code || error?.body?.error?.code || 'UNKNOWN'
              out.replaceChildren(notice(`检查失败（${errorCode}）`, 'warning'))
            } finally { control.disabled = false }
          }, { 'data-testid': 'upstream-check-row' }))
          return out
        }
        const table = el('table', { 'data-testid': 'pack-list' }, el('thead', {}, el('tr', {}, ...['领域包', '最新版本', '最新状态', '提交记录', '发布 Release', '上游', '操作'].map(label => el('th', { scope: 'col' }, label)))))
        const rows = el('tbody')
        for (const pack of result.items) rows.append(el('tr', {},
          el('td', {}, el('strong', {}, pack.name), el('div', { className: 'muted' }, code(pack.packId))),
          el('td', {}, pack.submission.version),
          el('td', {}, statusBadge(pack.submission.status)),
          el('td', {}, String(pack.submissionCount)),
          el('td', {}, pack.release ? el('span', {}, code(pack.release.version), el('div', { className: 'muted' }, code(pack.release.id))) : '—'),
          el('td', {}, upstreamCell(pack)),
          el('td', {},
            button('查看最新详情', () => ctx.navigate(detailPath(pack.submission.id)), { 'aria-label': `查看 ${pack.packId} 最新提交` }),
            ' ',
            button(`提交记录(${pack.submissionCount})`, () => ctx.navigate(routeQuery(route, new URLSearchParams({ organizationId, ...(activeStatus ? { status: activeStatus } : {}), packId: pack.packId, records: '1' }))), { 'aria-label': `查看 ${pack.packId} 全部提交记录` }))))
        table.append(rows); contents.append(el('div', { className: 'table-wrap' }, table))
      }
      const pagination = el('nav', { className: 'toolbar', 'aria-label': '包分页' })
      const next = extra => { const nextQuery = keepFilters(); for (const [key, value] of Object.entries(extra)) nextQuery.set(key, value); return nextQuery }
      if (ctx.query.has('afterPack')) pagination.append(button('返回第一页', () => ctx.navigate(routeQuery(route, next({}))), test('packs-first-page')))
      if (result.nextCursor) pagination.append(button('下一页', () => ctx.navigate(routeQuery(route, next({ afterPack: result.nextCursor }))), test('packs-next-page')))
      contents.append(pagination)
    } else {
      if (activePackId) {
        const back = new URLSearchParams({ organizationId, ...(activeStatus ? { status: activeStatus } : {}) })
        contents.append(el('div', { className: 'toolbar' }, button('返回包列表', () => ctx.navigate(routeQuery(route, back)), { ...test('back-to-packs') }), notice(`领域包 ${activePackId} 的全部提交记录。`, 'info')))
      }
      if (!result.items.length) contents.append(empty(reviewing ? '本页没有待审核提交。' : '该包没有可见提交记录。'))
      else {
        const table = el('table', { ...test(reviewing ? 'review-queue' : 'submission-list') }, el('thead', {}, el('tr', {}, ...['领域包 / 提交', '版本', '状态', '作者', '更新时间', '操作'].map(label => el('th', { scope: 'col' }, label)))))
        const rows = el('tbody')
        for (const submission of result.items) rows.append(el('tr', {},
          el('td', {}, el('strong', {}, submission.packId), el('div', { className: 'muted' }, code(submission.id))),
          el('td', {}, submission.version), el('td', {}, statusBadge(submission.status)), el('td', {}, submission.authorId),
          el('td', {}, formatDate(submission.updatedAt)), el('td', {}, button(reviewing ? '查看并审核' : '查看详情', () => ctx.navigate(detailPath(submission.id)), { 'aria-label': `查看提交 ${submission.id}` }))))
        table.append(rows); contents.append(el('div', { className: 'table-wrap' }, table))
      }
      const pagination = el('nav', { className: 'toolbar', 'aria-label': '提交分页' })
      const paginationQuery = extra => { const next = keepFilters(); if (!next.has('packId') && activePackId) next.set('packId', activePackId); if (recordsMode && !reviewing) next.set('records', '1'); for (const [key, value] of Object.entries(extra)) next.set(key, value); return next }
      if (ctx.query.has('beforeId')) pagination.append(button('返回第一页', () => ctx.navigate(routeQuery(route, paginationQuery({}))), test('submissions-first-page')))
      if (result.nextCursor) pagination.append(button('下一页', () => ctx.navigate(routeQuery(route, paginationQuery({ beforeId: result.nextCursor }))), test('submissions-next-page')))
      contents.append(pagination)
    }
  } catch (error) { if (!ctx.signal.aborted) showError(contents, error) }
}


// Shared one-click upstream update flow. `api` = center api(), `signal` = page
// abort signal, `step` = progress renderer, `goto` = navigate. Returns a result
// object; throws coded errors for failures.
export async function runUpstreamUpdate(ctx, submission, submissionId, step, goto) {
  const { api } = ctx
  const key = () => crypto.randomUUID()
  step('1/4 正在检查上游 HEAD…')
  const up = await api(`/api/submissions/${encodeURIComponent(submissionId)}/upstream`, { timeoutMs: 90000, signal: ctx.signal })
  if (!up.upstreamHead) throw Object.assign(new Error('NO_UPSTREAM_HEAD'), { code: 'NO_UPSTREAM_HEAD' })
  if (up.matches) return { kind: 'up-to-date' }
  const head = up.upstreamHead
  step(`2/4 正在读取上游 HEAD 的包版本…`)
  // The submission version must equal the pack.json version at the pinned
  // commit, so read it from a real (non-snapshot) pull of HEAD.
  const preview = await api(`/api/submissions/${encodeURIComponent(submissionId)}/preview-fetch`, { method: 'POST', body: { ref: head }, timeoutMs: 180000, signal: ctx.signal })
  if (preview.valid === false) throw Object.assign(new Error('UPSTREAM_INVALID'), { code: 'UPSTREAM_INVALID' })
  const nextVersion = preview.packVersion
  if (!nextVersion) throw Object.assign(new Error('UPSTREAM_VERSION_UNKNOWN'), { code: 'UPSTREAM_VERSION_UNKNOWN' })
  step(`3/5 上游版本 ${nextVersion}，正在创建修订（钉扎 ${head.slice(0, 12)}）…`)
  const created = await api('/api/submissions', { key: key(), method: 'POST', body: {
    organizationId: submission.ownerOrgId, packId: submission.packId, name: submission.packId, version: nextVersion,
    source: { url: submission.source.url, ref: head },
    notes: `一键更新：钉扎上游 ${submission.source.ref} → ${head}（基于提交 ${submissionId} 的修订）`,
    license: submission.license || '', distribution: submission.distribution,
    requiresPlugin: submission.requiresPlugin, dependencyReleaseIds: submission.dependencyReleaseIds,
    builtinDependencies: submission.builtinDependencies, previousSubmissionId: submissionId,
  }, timeoutMs: 60000, signal: ctx.signal })
  const draftId = created.id
  step('4/5 正在启动结构校验…')
  await api(`/api/submissions/${encodeURIComponent(draftId)}/validate`, { key: key(), method: 'POST', body: { expectedVersion: created.stateVersion }, timeoutMs: 60000, signal: ctx.signal })
  let status = 'validating'
  for (let tries = 0; tries < 60 && !ctx.signal.aborted; tries++) {
    await new Promise(resolve => setTimeout(resolve, 3000))
    const detail = await api(`/api/submissions/${encodeURIComponent(draftId)}`, { signal: ctx.signal })
    status = detail.submission.status
    if (status !== 'validating') break
  }
  if (status !== 'validated') return { kind: 'validation_failed', draftId, status }
  step('5/5 正在送审…')
  const detail = await api(`/api/submissions/${encodeURIComponent(draftId)}`, { signal: ctx.signal })
  await api(`/api/submissions/${encodeURIComponent(draftId)}/submit`, { key: key(), method: 'POST', body: { expectedVersion: detail.submission.stateVersion }, timeoutMs: 60000, signal: ctx.signal })
  return { kind: 'submitted', draftId, version: nextVersion }
}

function identifiers(value, label) {
  const values = value.split(/[\s,]+/).filter(Boolean)
  if (values.length > 100 || new Set(values).size !== values.length || values.some(item => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item) || item.includes('..') || ['__proto__', 'prototype', 'constructor'].includes(item))) throw invalid(`${label}应为不重复的有效 ID，最多 100 个。`)
  return values
}

function semver(value, label) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/.test(value)) throw invalid(`${label}必须是严格 SemVer，例如 1.0.0；不能带 v 前缀。`)
  return value
}

function builtinInput(value) {
  let result
  try { result = JSON.parse(value || '[]') } catch { throw invalid('内置依赖必须是有效的 JSON 数组。') }
  if (!Array.isArray(result) || result.length > 100) throw invalid('内置依赖必须是 JSON 数组，最多 100 项。')
  for (const item of result) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['packId', 'minVersion', 'maxVersionExclusive'].includes(key))) throw invalid('每个内置依赖只可包含 packId、minVersion、maxVersionExclusive。')
    if (typeof item.packId !== 'string' || identifiers(item.packId, '内置依赖 ID').length !== 1 || /[\s,]/.test(item.packId)) throw invalid('内置依赖必须指定有效 packId。')
    semver(item.minVersion, '内置依赖最低版本')
    if (item.maxVersionExclusive !== undefined) semver(item.maxVersionExclusive, '内置依赖版本上限')
  }
  if (new Set(result.map(item => item.packId)).size !== result.length) throw invalid('内置依赖 packId 不能重复。')
  return result
}

function submissionForm(ctx, { submission, previous, organizations, onSaved }) {
  const editing = Boolean(submission)
  const initial = submission || previous || {}
  const selected = initial.ownerOrgId || ctx.query.get('organizationId') || organizations[0]?.id || ''
  const organization = organizationPicker(organizations, selected, 'submission-organization', () => {})
  organization.disabled = editing || Boolean(previous)
  const packId = input('submission-pack-id', initial.packId || '', { required: true, maxLength: 64, readOnly: editing || Boolean(previous), placeholder: 'org-slug.my-pack 或 legacy-pack-id' })
  const name = input('submission-name', initial.name || initial.packId || '', { required: !editing, maxLength: 200, readOnly: editing })
  const version = input('submission-version', initial.version || '1.0.0', { required: true, maxLength: 200 })
  const sourceUrl = input('submission-source-url', initial.source?.url || '', { type: 'url', required: true, maxLength: 2048, placeholder: 'https://github.com/organization/domain-pack.git', autoComplete: 'off' })
  const sourceRef = input('submission-source-ref', initial.source?.ref || 'main', { required: true, maxLength: 240 })
  const notes = textarea('submission-notes', initial.notes || '', { maxLength: 20000, rows: 5 })
  const license = input('submission-license', initial.license || '', { maxLength: 1000, placeholder: 'MIT / Apache-2.0 / 授权说明' })
  const scope = el('select', { id: 'submission-scope', name: 'submission-scope', ...test('submission-scope') },
    el('option', { value: 'organization' }, '仅所属组织'), el('option', { value: 'authenticated' }, '所有已认证接收方'), el('option', { value: 'selected' }, '指定组织 / 部署'))
  scope.value = initial.distribution?.kind || 'organization'
  const targetOrganizations = textarea('submission-target-organizations', (initial.distribution?.organizationIds || []).join('\n'), { rows: 3 })
  const targetDeployments = textarea('submission-target-deployments', (initial.distribution?.deploymentIds || []).join('\n'), { rows: 3 })
  const recipients = el('div', { className: 'form-grid' }, field('指定组织 ID', targetOrganizations, '每行一个 ID，或以逗号分隔。'), field('指定部署 ID', targetDeployments, '指定范围至少包含一个有效组织或部署；服务端检查接收方状态。'))
  const syncScope = () => { recipients.hidden = scope.value !== 'selected'; targetOrganizations.disabled = targetDeployments.disabled = recipients.hidden }
  scope.addEventListener('change', syncScope); syncScope()
  const pluginMin = input('submission-plugin-min', initial.requiresPlugin?.minVersion || '0.1.0', { required: true })
  const pluginMax = input('submission-plugin-max', initial.requiresPlugin?.maxVersionExclusive || '')
  const releaseIds = textarea('submission-dependency-release-ids', (initial.dependencyReleaseIds || []).join('\n'), { rows: 4 })
  const builtins = textarea('submission-builtin-dependencies', JSON.stringify(initial.builtinDependencies || [], null, 2), { rows: 6, spellcheck: false })
  const errors = el('div', { role: 'status', ...test('submission-form-error') })
  const save = button(editing ? '保存草稿' : '创建草稿', () => {}, { kind: 'primary', type: 'submit', ...test('submission-save') })
  const form = el('form', { className: 'stack', ...test('submission-form') },
    el('div', { className: 'form-grid' }, field('所属组织', organization), field('领域包 ID', packId, '新包推荐使用所属组织 slug 加英文句点作为前缀；安全的历史裸 ID 可继续使用；创建后不可修改。'), field('领域包名称', name, editing ? '当前详情接口不返回包级名称，此处显示领域包 ID；草稿编辑不会修改包级名称。' : '用于识别领域包的可读名称。'), field('发布版本', version, '使用严格 SemVer。已批准版本不可重用。')),
    el('div', { className: 'form-grid' }, field('Git HTTPS 来源', sourceUrl, '仅接受中心配置允许的公共 HTTPS Git 主机；不可带凭据、查询参数或端口。'), field('Git ref / commit', sourceRef, '分支、标签或固定 commit。校验后审核固定快照，不随分支移动。')),
    field('变更说明', notes), field('许可证 / 授权说明', license), field('分发范围', scope), recipients,
    el('div', { className: 'form-grid' }, field('插件最低版本', pluginMin), field('插件版本上限（不含）', pluginMax, '留空表示无上限，非空必须高于最低版本。')),
    field('固定依赖 Release IDs', releaseIds, '每行一个已发布 release ID，或以逗号分隔。不得用浮动包版本替代固定 ID。'),
    field('内置依赖（JSON）', builtins, '示例：[{"packId":"builtin.core","minVersion":"1.0.0","maxVersionExclusive":"2.0.0"}]。无依赖填 []。'),
    errors, el('div', { className: 'toolbar' }, save))
  form.addEventListener('submit', event => {
    event.preventDefault()
    if (ctx.signal.aborted || save.disabled || !form.reportValidity()) return
    runAction(save, () => withLockedForm(form, async () => {
      const requiresPlugin = { minVersion: semver(pluginMin.value.trim(), '插件最低版本') }
      if (pluginMax.value.trim()) requiresPlugin.maxVersionExclusive = semver(pluginMax.value.trim(), '插件版本上限')
      let distribution = { kind: scope.value }
      if (scope.value === 'selected') {
        distribution = { kind: 'selected', organizationIds: identifiers(targetOrganizations.value, '指定组织 ID'), deploymentIds: identifiers(targetDeployments.value, '指定部署 ID') }
        if (!distribution.organizationIds.length && !distribution.deploymentIds.length) throw invalid('指定范围至少需要一个组织 ID 或部署 ID。')
      }
      let url
      try { url = new URL(sourceUrl.value.trim()) } catch { throw invalid('请填写有效的 Git HTTPS 来源 URL。') }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) throw invalid('Git 来源必须是无凭据、查询参数、片段或自定义端口的 HTTPS URL。')
      const payload = { version: semver(version.value.trim(), '发布版本'), source: { url: sourceUrl.value.trim(), ref: sourceRef.value.trim() }, notes: notes.value, license: license.value, distribution, requiresPlugin, dependencyReleaseIds: identifiers(releaseIds.value, '固定依赖 Release IDs'), builtinDependencies: builtinInput(builtins.value) }
      let result
      if (editing) result = await write(ctx, apiPath(submission.id), { expectedVersion: submission.stateVersion, ...payload }, 'PATCH')
      else {
        if (!name.value.trim()) throw invalid('请填写领域包名称。')
        const selectedOrganization = organizations.find(item => item.id === organization.value)
        const packIdentity = identifiers(packId.value.trim(), '领域包 ID')
        if (packIdentity.length !== 1) throw invalid('领域包 ID 必须是单个有效 ID。')
        if (packIdentity[0].includes('.') && (!selectedOrganization || !packIdentity[0].startsWith(`${selectedOrganization.slug}.`))) throw invalid('带点号的领域包 ID 必须以所属组织的 slug 加英文句点开头。')
        result = await write(ctx, '/api/submissions', { organizationId: organization.value, packId: packIdentity[0], name: name.value.trim(), ...payload, ...(previous ? { previousSubmissionId: previous.id } : {}) })
      }
      if (!ctx.signal.aborted && result) await onSaved(result)
    }), errors)
  })
  return form
}

async function renderNew(ctx) {
  const body = shell(ctx, '新建领域包提交', '从公共 Git 仓库提交 V2 领域包。先保存草稿，再由独立 Worker 校验固定内容。')
  if (!ctx.principal.developer) { body.append(notice('无创建权限：当前账号未开通开发者角色，请联系平台管理员。', 'warning')); return }
  const organizations = ctx.organizations.filter(organization => organization.status === 'active' && hasOrgRole(ctx.principal, organization.id, ['member', 'admin']))
  if (!organizations.length) { body.append(notice('无创建权限：需要有效组织中的成员资格（服务端另要求该包的 owner/maintainer 授权）。', 'warning')); return }
  let previous
  if (ctx.query.has('previousSubmissionId')) {
    const loading = empty('正在读取旧提交…'); body.append(loading)
    try {
      const result = await api(apiPath(ctx.query.get('previousSubmissionId')), { signal: ctx.signal })
      if (ctx.signal.aborted) return
      previous = result.submission
      loading.remove()
      if (!settledStatuses.has(previous.status) || !canAuthor(ctx.principal, previous)) { body.append(notice('此提交不能用于创建修订，或你没有修订权限。', 'warning')); return }
      body.append(notice(`本次创建独立修订，关联旧提交 ${previous.id}。旧来源、固定快照和审核记录不会被覆盖。`, 'info'))
      if (previous.status === 'approved') body.append(notice('旧提交已批准，必须为修订指定新的发布版本。', 'warning'))
    } catch (error) { if (!ctx.signal.aborted) showError(body, error); return }
  }
  const requestedOrganization = previous?.ownerOrgId || ctx.query.get('organizationId')
  if (requestedOrganization && !organizations.some(organization => organization.id === requestedOrganization)) { body.append(notice('当前组织不在你的可创建范围内。', 'warning')); return }
  body.append(card(previous ? '独立修订草稿' : '提交内容', submissionForm(ctx, { previous, organizations, onSaved: result => ctx.navigate(detailPath(result.id)) })))
}

function renderReport(snapshot) {
  const report = snapshot.report
  if (!report || typeof report !== 'object') return card('校验报告', notice('快照未附带可读取的校验报告。', 'warning'))
  const contents = [notice(report.valid ? '固定快照校验通过。送审前请核对诊断、权限与内容差异。' : '固定快照校验未通过，不能送审。', report.valid ? 'success' : 'warning')]
  if (report.entityCounts) contents.push(keyValues(Object.entries(report.entityCounts)))
  const diagnostics = Array.isArray(report.diagnostics) ? report.diagnostics : []
  if (!diagnostics.length) contents.push(empty('无诊断项。'))
  else {
    const list = el('ul', { className: 'stack' })
    for (const diagnostic of diagnostics) list.append(el('li', {}, statusBadge(diagnostic.severity), ' ', code(diagnostic.code), ' ', String(diagnostic.message ?? ''), diagnostic.path ? el('div', {}, '路径：', code(diagnostic.path)) : null))
    contents.push(list)
  }
  if (report.permissions) contents.push(jsonBlock('包权限与脚本声明（仅查看，不执行）', report.permissions))
  contents.push(jsonBlock('完整校验报告 JSON', report))
  return card('校验报告', ...contents)
}

function renderPreview(snapshot) {
  const preview = snapshot.preview
  const section = card('固定快照预览', paragraph('所有仓库文本均以纯文本显示；不会执行脚本、渲染仓库 HTML 或加载远程资源。'))
  if (!preview || typeof preview !== 'object') { section.append(empty('没有可用预览。')); return section }
  if (preview.entities) section.append(jsonBlock('实体清单', preview.entities))
  if (preview.normalization) section.append(jsonBlock('规范化规则', preview.normalization))
  if (preview.scriptDeclarations) section.append(jsonBlock('声明的脚本（未执行）', preview.scriptDeclarations))
  const files = Array.isArray(preview.files) ? preview.files : []
  if (!files.length) section.append(empty('没有文件预览。'))
  else {
    const list = el('div', { className: 'stack', ...test('snapshot-files') })
    for (const file of files) {
      const item = el('details', {}, el('summary', {}, `${file.path} · ${file.sizeBytes} 字节`), paragraph(`SHA-256：${file.sha256}`))
      item.append(file.text === undefined ? empty('此文件不提供文本预览。') : el('pre', {}, String(file.text)))
      if (file.truncated) item.append(notice('此文件预览已截断；摘要绑定的是完整文件。', 'warning'))
      list.append(item)
    }
    section.append(list)
  }
  return section
}

function renderDiff(snapshot) {
  const diff = snapshot.diff
  const section = card('相对已发布基线的差异')
  if (!diff || typeof diff !== 'object') { section.append(empty('没有差异数据。')); return section }
  section.append(diff.baseline ? paragraph(`比较基线 Release：${diff.baseline.releaseId}；快照：${diff.baseline.snapshotId}`) : notice('当前没有已发布基线；新增内容按首次发布展示。', 'info'))
  if (diff.files) for (const [key, label] of [['added', '新增文件'], ['removed', '删除文件'], ['changed', '修改文件']]) {
    const values = Array.isArray(diff.files[key]) ? diff.files[key] : []
    section.append(el('details', {}, el('summary', {}, `${label}（${values.length}）`), values.length ? el('ul', {}, ...values.map(path => el('li', {}, code(path)))) : paragraph('无')))
  }
  if (diff.entities) section.append(jsonBlock('实体增删改与无法验证的旧实体', diff.entities))
  if (diff.permissions) section.append(jsonBlock('权限变更（before / after）', diff.permissions))
  section.append(jsonBlock('完整差异 JSON', diff))
  return section
}

function renderTimeline(result) {
  const attempts = Array.isArray(result.attempts) ? result.attempts : []
  const reviews = Array.isArray(result.reviews) ? result.reviews : []
  const entries = [
    ...attempts.map(attempt => ({ date: attempt.started_at, node: el('li', {}, el('strong', {}, `校验尝试 #${attempt.attempt}`), ' ', statusBadge(attempt.status), paragraph(`开始：${formatDate(attempt.started_at)}；结束：${formatDate(attempt.finished_at)}`), attempt.error_code ? paragraph(`错误：${attempt.error_code} · ${attempt.error_message || ''}`) : null) })),
    ...reviews.map(review => ({ date: review.created_at, node: el('li', {}, el('strong', {}, decisions[review.decision] || review.decision), paragraph(`审核员：${review.reviewer_id} · ${formatDate(review.created_at)}`), el('pre', {}, String(review.comment ?? ''))) })),
  ].sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0))
  return card('校验与审核时间线', entries.length ? el('ol', { className: 'timeline stack', ...test('submission-timeline') }, ...entries.map(entry => entry.node)) : empty('暂无校验尝试或审核记录。'))
}

// 免审核配置：包 owner 或组织审核人可设置；开启后该包每次新提交送审即自动通过。
function autoReviewSection(ctx, submission, reload) {
  const enabled = submission.autoApprove === true
  const section = card('免审核配置', notice('仅对此提交所属的包生效：开启后，该包每次新提交送审时将自动审核通过并直接进入发布流程，不再等待人工审核。', 'info'))
  section.setAttribute('data-testid', 'auto-review-config')
  section.append(keyValues([['当前状态', enabled ? '已开启（新提交自动通过）' : '未开启（需人工审核)']]))
  const checkbox = el('input', { type: 'checkbox', ...test('auto-review-toggle') })
  checkbox.checked = enabled
  const errors = el('div', { role: 'status' })
  const save = button('提交该配置', () => runAction(save, async () => {
    if (!window.confirm(`确认${checkbox.checked ? '开启' : '关闭'}免审核？\n包：${submission.packId}\n${checkbox.checked ? '开启后该包每次新提交送审将自动通过并直接发布。' : '关闭后该包新提交恢复人工审核。'}`)) return
    await write(ctx, `${apiPath(submission.id)}/review-config`, { enabled: checkbox.checked })
    if (!ctx.signal.aborted) await reload()
  }, errors), { kind: 'primary', ...test('auto-review-save') })
  section.append(field('免审核（新提交自动通过）', checkbox), errors, save)
  return section
}

function reviewPanel(ctx, result, reload) {
  const { submission, snapshot } = result
  const self = submission.authorId === ctx.principal.userId
  // 与服务端 requireReviewAccess 一致：组织 admin / 平台管理员拥有完整审核权
  // （含自审豁免），无需分配 reviewer 审核范围。
  const adminReview = ctx.principal.platformAdmin || hasOrgRole(ctx.principal, submission.ownerOrgId, ['admin'])
  const permitted = adminReview || (reviewScope(ctx.principal, submission.ownerOrgId) && !self)
  const section = card('审核决定', notice('决定将绑定下方 contentTreeSha256 与当前提交状态版本；所有决定均须填写意见并再次确认。通过审核只进入发布任务，不代表已经发布。', 'info'))
  section.setAttribute('data-testid', 'submission-review-form')
  section.append(keyValues([['绑定内容摘要', code(snapshot?.contentTreeSha256)], ['提交状态版本', submission.stateVersion]]))
  if (!permitted) section.append(notice(self ? '作者不能审核自己的提交。服务端同样拒绝自审。' : '你没有此组织的有效审核角色和范围，审核操作不可用。', 'warning'))
  if (!snapshot) section.append(notice('没有固定快照，不能审核。', 'warning'))
  const comment = textarea('review-comment', '', { required: true, maxLength: 20000, disabled: !permitted || !snapshot })
  const errors = el('div', { role: 'status' })
  const controls = el('div', { className: 'toolbar' })
  for (const [decision, label] of Object.entries(decisions)) {
    const control = button(label, () => runAction(control, async () => {
      if (!comment.value.trim()) throw invalid('请填写审核意见，不能只输入空白。')
      if (!window.confirm(`确认${label}？\n提交：${submission.id}\n内容摘要：${snapshot.contentTreeSha256}\n状态版本：${submission.stateVersion}${decision === 'approved' ? '\n通过后进入独立发布流程，并非立即发布。' : ''}`)) return
      await write(ctx, `${apiPath(submission.id)}/review`, { expectedVersion: submission.stateVersion, contentTreeSha256: snapshot.contentTreeSha256, decision, comment: comment.value.trim() })
      if (!ctx.signal.aborted) await reload()
    }, errors), { kind: decision === 'approved' ? 'primary' : decision === 'rejected' ? 'danger' : 'secondary', disabled: !permitted || !snapshot, ...test(`review-${decision}`) })
    controls.append(control)
  }
  section.append(field('审核意见（必填）', comment), errors, controls, autoReviewSection(ctx, submission, reload))
  return section
}


// Creation-axis management: pack owners/maintainers are configured per pack,
// independent of any tenant membership. The server re-checks ownership on
// every mutation; the form is simply hidden behind that enforcement.
async function collaboratorsSection(ctx, submission, reload) {
  const enc = encodeURIComponent
  const node = card('协作成员（包权限）', paragraph('owner 可授予/撤销协作成员并管理包；maintainer 可创建修订。此授权独立于任何组织成员身份，可跨租户协作。'))
  let owners
  try { owners = (await api(`/api/packs/${enc(submission.packId)}/owners`, { signal: ctx.signal })).items }
  catch (error) { node.append(paragraph('协作成员列表读取失败。')); showError(node, error); return node }
  const rows = owners.map(owner => {
    const actions = el('div')
    actions.append(button('移除', async event => {
      await runAction(event.currentTarget, async () => {
        await write(ctx, `/api/packs/${enc(submission.packId)}/owners/${enc(owner.userId)}`, {}, 'DELETE')
        if (!ctx.signal.aborted) reload()
      })
    }, { kind: 'danger', ...test(`pack-collaborator-revoke-${owner.userId}`) }))
    return [owner.displayName, owner.role === 'owner' ? 'owner（可管理授权）' : 'maintainer（可创建修订）', formatDate(owner.createdAt), actions]
  })
  node.append(el('div', { className: 'table-wrap' }, el('table', { 'data-testid': 'pack-collaborators' },
    el('thead', {}, el('tr', {}, ...['成员', '角色', '授权时间', '操作'].map(label => el('th', { scope: 'col' }, label)))),
    el('tbody', {}, ...rows.map(row => el('tr', {}, ...row.map(value => el('td', {}, value))))))))
  const userId = el('input', { name: 'collaborator-user-id', id: 'collaborator-user-id', type: 'text', required: true, placeholder: '用户标识（可在组织与成员页查看）' })
  const role = el('select', { name: 'collaborator-role', id: 'collaborator-role' },
    el('option', { value: 'maintainer' }, 'maintainer（可创建修订）'), el('option', { value: 'owner' }, 'owner（可管理授权）'))
  const grantErrors = el('div', { role: 'alert' })
  node.append(el('form', { className: 'stack' },
    field('新增协作成员', el('div', { className: 'form-grid' }, field('用户标识', userId), field('包角色', role))),
    grantErrors,
    button('授予包角色', event => {
      event.preventDefault()
      if (!userId.value.trim()) { grantErrors.replaceChildren(notice('请填写用户标识。', 'warning')); return }
      void runAction(event.currentTarget, async () => {
        await write(ctx, `/api/packs/${enc(submission.packId)}/owners`, { userId: userId.value.trim(), role: role.value })
        if (!ctx.signal.aborted) reload()
      }, grantErrors)
    }, { kind: 'primary', type: 'button', ...test('pack-collaborator-grant') })))
  return node
}

async function renderDetail(ctx, id) {
  const body = shell(ctx, '提交详情', '提交状态与发布状态分别显示；所有写操作由服务端重新检查权限和版本。')
  const errors = el('div', { role: 'status' })
  const toolbar = el('div', { className: 'toolbar' }, button('返回我的提交', () => ctx.navigate('submissions')))
  toolbar.append(button('刷新状态', event => runAction(event.currentTarget, () => ctx.navigate(detailPath(id)), errors), test('submission-refresh')))
  if (hasReviewerRole(ctx.principal)) toolbar.append(button('返回审核队列', () => ctx.navigate('reviews')))
  const contents = el('div', { className: 'stack' }, empty('正在加载固定快照与提交状态…'))
  body.append(toolbar, errors, contents)
  let result
  try { result = await api(apiPath(id), { signal: ctx.signal }) } catch (error) { if (!ctx.signal.aborted) showError(contents, error); return }
  if (ctx.signal.aborted) return
  const { submission, snapshot, release } = result
  const author = canAuthor(ctx.principal, submission)
  const reload = () => { if (!ctx.signal.aborted) ctx.navigate(detailPath(id)) }
  const actions = el('div', { className: 'toolbar' })
  const actionErrors = el('div', { role: 'status', ...test('submission-action-error') })
  const action = (label, suffix, prompt, kind = 'primary') => {
    const control = button(label, () => runAction(control, async () => {
      if (prompt && !window.confirm(prompt)) return
      await write(ctx, `${apiPath(id)}/${suffix}`, { expectedVersion: submission.stateVersion })
      if (!ctx.signal.aborted) await reload()
    }, actionErrors), { kind, ...test(`submission-${suffix}`) })
    actions.append(control)
  }
  if (author && submission.status === 'draft') action('启动校验', 'validate', '确认校验当前已保存的草稿？未保存的表单修改不会进入本次校验。')
  if (author && submission.status === 'validated') action('提交审核', 'submit', '确认将当前固定快照送审？送审后不能直接编辑。')
  if (author && submission.status === 'pending_review') action('撤回提交', 'withdraw', '确认撤回此待审提交？之后修改需要创建独立修订。', 'danger')
  if (author && settledStatuses.has(submission.status)) actions.append(button('创建独立修订', () => ctx.navigate(routeQuery('submissions/new', new URLSearchParams({ organizationId: submission.ownerOrgId, previousSubmissionId: id }))), { ...test('submission-revise') }))
  if (author && settledStatuses.has(submission.status) && snapshot) actions.append(button('一键更新到上游', async event => {
    const control = event.currentTarget
    const out = el('div', { role: 'status' })
    control.replaceWith(out)
    try {
      const result = await runUpstreamUpdate(ctx, submission, id, text => out.replaceChildren(paragraph(text)), ctx.navigate)
      if (result.kind === 'up-to-date') out.replaceChildren(notice('上游与当前快照一致，无需更新。', 'info'))
      else if (result.kind === 'validation_failed') out.replaceChildren(notice(`校验未通过（${result.status}）。打开新提交查看报告：`, 'warning'), button('查看新提交', () => ctx.navigate(detailPath(result.draftId))))
      else out.replaceChildren(notice(`已完成：新提交 ${result.draftId}（v${result.version}）已进入待审核队列，等待审核员批准后自动发布。`, 'info'), button('查看新提交', () => ctx.navigate(detailPath(result.draftId))))
    } catch (error) {
      if (ctx.signal.aborted) return
      const errorCode = error?.code || error?.body?.error?.code || 'UNKNOWN'
      out.replaceChildren(notice(`一键更新失败（${errorCode}）。已审内容不受影响。`, 'warning'))
    }
  }, { ...test('one-click-update') }))
  const submissionStatus = statusBadge(submission.status)
  submissionStatus.setAttribute('data-testid', 'submission-status')
  contents.replaceChildren(card(`${submission.packId} · ${submission.version}`, submissionStatus, keyValues([
    ['提交 ID', code(submission.id)], ['所属组织', organizationName(ctx, submission.ownerOrgId)], ['作者', submission.authorId], ['状态版本', submission.stateVersion],
    ['Git 来源', code(submission.source.url)], ['请求 ref', code(submission.source.ref)], ['创建时间', formatDate(submission.createdAt)], ['更新时间', formatDate(submission.updatedAt)], ['许可证 / 授权', submission.license || '未填写'],
  ]), el('h3', {}, '变更说明'), el('pre', {}, submission.notes || '未填写'), jsonBlock('分发范围与兼容性 / 固定依赖', { distribution: submission.distribution, requiresPlugin: submission.requiresPlugin, dependencyReleaseIds: submission.dependencyReleaseIds, builtinDependencies: submission.builtinDependencies }), actionErrors, actions))
  if (submission.previousSubmissionId) contents.append(card('修订关联', paragraph(`此提交是 ${submission.previousSubmissionId} 的独立修订；旧提交不会被覆盖。`), button('查看旧提交', () => ctx.navigate(detailPath(submission.previousSubmissionId)))))
  contents.append(await collaboratorsSection(ctx, submission, reload))
  if (submission.status === 'validating') contents.append(notice('校验任务正在排队或运行中。请手动刷新状态；此页面不会重发校验任务。', 'info'))
  if (submission.status === 'validation_failed') contents.append(notice('校验失败。请查看报告或时间线，修正来源后创建独立修订；失败提交与旧记录保留。', 'warning'))
  if (submission.status === 'changes_requested') contents.append(notice('审核员已退回修改。请查看审核意见并创建独立修订；不能覆盖这次已审内容。', 'warning'))
  if (submission.status === 'draft' && author) contents.append(card('编辑草稿', notice('保存和启动校验是两个独立操作。请先保存草稿；启动校验只读取已保存内容。', 'info'), submissionForm(ctx, { submission, organizations: ctx.organizations.filter(organization => organization.id === submission.ownerOrgId), onSaved: reload })))
  if (snapshot) contents.append(el('section', { className: 'card stack', ...test('submission-snapshot') }, el('h2', {}, '固定快照摘要'), keyValues([
    ['快照 ID', code(snapshot.id)], ['固定 source commit', code(snapshot.sourceCommit)], ['contentTreeSha256', code(snapshot.contentTreeSha256)], ['artifactSha256', code(snapshot.artifactSha256)], ['reportSha256', code(snapshot.reportSha256)], ['校验器版本', snapshot.validatorVersion], ['文件数', snapshot.fileCount], ['归档字节数', snapshot.sizeBytes],
  ])), renderReport(snapshot), renderPreview(snapshot), renderDiff(snapshot))
  else contents.append(card('固定快照', empty('尚未生成固定快照。通过校验后这里会显示报告、预览和差异。')))
  const advanced = el('details', { className: 'card stack', 'data-testid': 'upstream-advanced' }, el('summary', {}, '高级：手动上游检查与拉取预览（通常无需使用，一键更新已包含）'))
  if (snapshot && submission.source?.url) {
    const refInput = el('input', { value: submission.source?.ref || '', 'data-testid': 'preview-ref' })
    const previewOut = el('div', { role: 'status' })
    advanced.append(card('拉取预览（真实拉取，不生成快照）', notice('输入 ref（分支或 commit），中心真实拉取并校验结构；不生成快照、不影响已审内容。', 'info'), refInput,
      button('拉取预览', async () => {
        previewOut.replaceChildren(paragraph('正在从上游真实拉取并校验…（最长 2 分钟）'))
        try {
          const r = await ctx.api(`/api/submissions/${encodeURIComponent(submission.id)}/preview-fetch`, { method: 'POST', body: { ref: refInput.value.trim() }, timeoutMs: 180000 })
          previewOut.replaceChildren(keyValues([
            ['解析 commit', code(r.resolvedCommit)], ['包结构有效', r.valid ? '是' : '否'],
            ['文件数', String(r.fileCount)], ['字节数', String(r.sizeBytes)], ['contentTreeSha256', code(r.contentTreeSha256)],
            ['与当前快照一致', r.sameAsCurrentSnapshot ? '是' : '否'],
          ]), notice(r.sameAsCurrentSnapshot ? '与当前快照内容一致。' : '内容与当前快照不同。如需发布请创建独立修订或新版本提交。', r.sameAsCurrentSnapshot ? 'info' : 'warning'))
        } catch (error) {
          previewOut.replaceChildren(notice(`拉取失败（${error?.code || error?.body?.error?.code || 'UNKNOWN'}）。已审内容不受影响。`, 'warning'))
        }
      }, { 'data-testid': 'preview-fetch' }), previewOut))
  }
  if (snapshot && submission.source?.url) {
    const upstreamOut = el('div', { role: 'status' })
    advanced.append(card('上游检查（手动）', notice('中心不轮询上游。此按钮手动对比上游当前 HEAD 与本快照固定 commit；不会改动任何已审内容。', 'info'),
      button('检查上游更新', async () => {
        upstreamOut.replaceChildren(paragraph('正在检查上游…'))
        try {
          const r = await ctx.api(`/api/submissions/${encodeURIComponent(submission.id)}/upstream`, { timeoutMs: 90000 })
          const same = r.matches === true
          upstreamOut.replaceChildren(keyValues([
            ['上游 HEAD', code(r.upstreamHead || '（ref 无返回）')],
            ['快照固定 commit', code(r.snapshotCommit || '—')],
            ['结论', same ? '一致：上游没有超过本快照的新提交。' : '不一致：上游有新提交；如需发布请创建独立修订或新版本提交。'],
          ]), notice(same ? '上游与本快照一致。' : '上游领先于本快照。', same ? 'info' : 'warning'))
        } catch (error) {
          const code = error?.code || error?.body?.error?.code || 'UNKNOWN'
          upstreamOut.replaceChildren(notice(`上游检查失败（${code}）。常见原因：网络受限、上游仓库不可达。已审内容不受影响。`, 'warning'))
        }
      }, { 'data-testid': 'upstream-check' }), upstreamOut))
  }
  if (advanced.childNodes.length > 1) contents.append(advanced)
  if (submission.status === 'pending_review') contents.append(reviewPanel(ctx, result, reload))
  else contents.append(autoReviewSection(ctx, submission, reload))
  if (release) {
    const releaseSection = card('独立发布状态', statusBadge(release.status), keyValues([['Release ID', code(release.id)], ['发布状态版本', release.stateVersion], ['发布时间', formatDate(release.publishedAt)], ['发布错误码', release.errorCode || '—'], ['下架时间', formatDate(release.yankedAt)], ['下架原因', release.yankReason || '—']]))
    if (release.status !== 'published') releaseSection.append(notice(release.status === 'publish_failed' ? '审核已通过，但发布失败；尚不可作为成功发布使用。重试仅使用原批准快照。' : release.status === 'publishing' ? '审核已通过，正在独立发布流程中；请刷新查看结果。' : '此 Release 当前不是已发布状态。', release.status === 'publish_failed' ? 'warning' : 'info'))
    if (release.status === 'publish_failed') {
      const retryErrors = el('div', { role: 'status' })
      const permitted = hasOrgRole(ctx.principal, submission.ownerOrgId, ['admin']) || (reviewScope(ctx.principal, submission.ownerOrgId) && submission.authorId !== ctx.principal.userId)
      const retry = button('重试发布原批准快照', () => runAction(retry, async () => {
        if (!window.confirm(`确认重试发布 Release ${release.id}？将使用原批准快照，发布状态版本 ${release.stateVersion}。`)) return
        await write(ctx, `${apiPath(id)}/retry-publication`, { expectedReleaseVersion: release.stateVersion })
        if (!ctx.signal.aborted) await reload()
      }, retryErrors), { kind: 'primary', disabled: !permitted, ...test('retry-publication') })
      releaseSection.append(retryErrors, retry)
      if (!permitted) releaseSection.append(notice('仅有权组织管理员或独立审核员可以重试发布。', 'info'))
    }
    contents.append(releaseSection)
  } else if (submission.status === 'approved') contents.append(card('独立发布状态', notice('审核状态为通过，但尚无可读取的 Release；不能据此判定已经发布，请刷新确认。', 'warning')))
  contents.append(renderTimeline(result))
}

export async function renderSubmissions(ctx) {
  if (ctx.signal.aborted) return
  if (!ctx.principal || ctx.principal.kind !== 'human') { ctx.root.replaceChildren(notice('请先登录真实人类账号。', 'warning')); return }
  if (operationActor !== ctx.principal.userId) { pendingWrites.clear(); operationActor = ctx.principal.userId }
  if (ctx.route === 'submissions') return renderList(ctx, false)
  if (ctx.route === 'reviews') return renderList(ctx, true)
  if (ctx.route === 'submissions/new') return renderNew(ctx)
  const match = /^submissions\/([^/]+)$/.exec(ctx.route)
  if (match) return renderDetail(ctx, decodeURIComponent(match[1]))
  ctx.root.replaceChildren(notice('找不到此提交页面。', 'warning'))
}
