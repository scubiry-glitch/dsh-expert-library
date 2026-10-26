const $ = id => document.getElementById(id)
const notice = message => { $('manageNotice').textContent = message }
const csrf = () => document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('__Host-zhijian-csrf='))?.split('=')[1] ?? ''
const tabIds = ['data', 'packs', 'experts', 'usage']
const selectedTab = () => tabIds.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'data'
let tabsReady = false
let tabRequest = 0
let settings = { writable: false, revision: 0, value: {} }
let centerConnection = null
let installations = null
let selectedSource = 'wind'
let modelCatalog = null
let expertCatalog = []
const sourceNames = { wind: '万得', zyt: '政研通', beike: '贝壳', localdb: '本地数据' }
const usageKinds = [['expert', '专家'], ['skill', 'Skill'], ['pack', '领域包'], ['source', '数据源']]
async function loadUsage() {
  const days = $('usageDays').value === '30' ? 30 : 7
  $('usageAsOf').textContent = '正在读取调用记录…'
  try {
    const value = await api('usage', 'GET', undefined, `?days=${days}`)
    $('usageAsOf').textContent = `截至 ${new Date(value.asOf).toLocaleString('zh-CN')} · ${days} 天${value.firstEventAt ? ` · 本范围首条记录 ${new Date(value.firstEventAt).toLocaleDateString('zh-CN')}` : ''}`
    $('usageCards').replaceChildren()
    for (const [kind, title] of usageKinds) {
      const items = Array.isArray(value.rankings?.[kind]) ? value.rankings[kind] : []
      const card = node('section', undefined, 'manageCard manageUsageCard')
      const heading = node('div', undefined, 'manageUsageHeading')
      heading.append(node('h3', title), node('span', `${items.reduce((total, item) => total + (Number(item.calls) || 0), 0)} 次调用`))
      card.append(heading)
      if (!items.length) card.append(node('p', '这个时间范围内暂无调用记录。', 'manageMuted'))
      const max = Math.max(1, ...items.map(item => Number(item.calls) || 0))
      items.forEach((item, index) => {
        const entry = node('div', undefined, 'manageUsageItem')
        const main = node('div', undefined, 'manageUsageItemMain')
        const name = kind === 'source' ? sourceNames[item.id] ?? item.id : item.id
        main.append(node('span', String(index + 1).padStart(2, '0'), 'manageUsageRank'),
          node('strong', `${name}${item.version ? ` · ${item.version}` : ''}`), node('b', String(item.calls)))
        const track = node('div', undefined, 'manageUsageTrack')
        const bar = node('div', undefined, 'manageUsageBar')
        bar.style.width = `${Math.max(3, Math.round(100 * item.calls / max))}%`
        track.append(bar)
        entry.append(main, track, node('small', `${item.sessions} 个会话`))
        card.append(entry)
      })
      $('usageCards').append(card)
    }
  } catch (error) {
    $('usageAsOf').textContent = '调用记录暂时无法读取，请稍后重试。'
    $('usageCards').replaceChildren()
    throw error
  }
}
$('usageDays').addEventListener('change', () => void loadUsage().catch(() => undefined))
function showTab(id) {
  for (const name of tabIds) {
    const selected = name === id
    $(`tab-${name}`).setAttribute('aria-selected', String(selected))
    $(`tab-${name}`).tabIndex = selected ? 0 : -1
    $(name).hidden = !selected
  }
  requestAnimationFrame(updateSubnav)
}
function updateSubnav() {
  const nav = $(selectedTab()).querySelector('.manageSubnav')
  if (!nav) return
  const buttons = [...nav.querySelectorAll('button[data-scroll-target]')]
  let active = buttons[0]
  for (const button of buttons) {
    const target = $(button.dataset.scrollTarget)
    if (target?.getBoundingClientRect().top <= 140) active = button
  }
  for (const button of buttons) {
    if (button === active) button.setAttribute('aria-current', 'location')
    else button.removeAttribute('aria-current')
  }
}
for (const button of document.querySelectorAll('.manageSubnav button[data-scroll-target]')) {
  button.addEventListener('click', () => {
    const target = $(button.dataset.scrollTarget)
    if (!target) return
    target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    for (const peer of button.closest('.manageSubnav').querySelectorAll('button[data-scroll-target]'))
      peer.removeAttribute('aria-current')
    button.setAttribute('aria-current', 'location')
  })
}
let subnavFrame = 0
window.addEventListener('scroll', () => {
  if (subnavFrame) return
  subnavFrame = requestAnimationFrame(() => { subnavFrame = 0; updateSubnav() })
}, { passive: true })
function settingsWriteEnabled(enabled) {
  for (const id of ['dataForm', 'executionForm', 'policyForm', 'modelForm', 'overrideForm', 'runtimeForm'])
    $(`${id}`).querySelector('button[type=submit]').disabled = !enabled
  $('policyStatus').textContent = enabled ? '当前策略可编辑；修改后点击“保存策略”生效。' : '此实例的设置服务暂不可写。'
  $('settingsStatus').textContent = enabled ? '选择数据源后可修改配置并保存。' : '设置服务暂不可用，当前不能保存数据源配置。'
  refreshModelButtons()
}
function renderPerPackPolicies() {
  $('perPackPolicies').replaceChildren()
  const seen = new Set()
  for (const item of installations?.items ?? []) {
    if (seen.has(item.packId)) continue
    seen.add(item.packId)
    const field = node('label', item.packId)
    const select = node('select')
    select.dataset.packId = item.packId
    for (const [mode, title] of [['', '跟随默认'], ['manual', '手动'], ['download', '自动下载'], ['patch_auto', '补丁自动启用']]) {
      const option = node('option', title); option.value = mode; select.append(option)
    }
    select.value = settings.value?.packCenterUpdatePolicy?.perPack?.[item.packId] ?? ''
    field.append(select); $('perPackPolicies').append(field)
  }
}

async function api(name, method = 'GET', body, query = '') {
  const response = await fetch(`/api/capabilities/${name}${query}`, { method, credentials: 'same-origin', cache: 'no-store',
    headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf() }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json().catch(() => ({}))
  if (!response.ok || value.ok === false) throw new Error(value.error?.code || value.error || `HTTP ${response.status}`)
  return value.data ?? value
}
function node(tag, text, className) {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = String(text)
  if (className) element.className = className
  return element
}
function selectDataSource(id) {
  selectedSource = id
  for (const card of $('healthCards').querySelectorAll('[data-source]')) card.setAttribute('aria-pressed', String(card.dataset.source === id))
  const local = id === 'localdb'
  $('localDataNote').hidden = !local
  $('dataForm').hidden = local
  $('executionForm').hidden = local
  if (local) return
  $('dataFormTitle').textContent = `${sourceNames[id]}配置`
  $('executionFormTitle').textContent = `${sourceNames[id]}执行模式`
  for (const formId of ['dataForm', 'executionForm'])
    for (const field of $(`${formId}`).querySelectorAll('label[data-source]')) field.hidden = field.dataset.source !== id
}
function fillOptions(select, options, value) {
  select.replaceChildren()
  for (const [id, label] of options) {
    const option = node('option', label)
    option.value = id
    select.append(option)
  }
  if (value && !options.some(([id]) => id === value)) {
    const unavailable = node('option', `原设置：${value}（当前不可用）`)
    unavailable.value = value
    unavailable.disabled = true
    select.append(unavailable)
  }
  select.value = value || ''
}
function modelFor(provider, model) {
  return modelCatalog?.find(item => item.provider === provider && item.model === model)
}
function fillRouteForm(form, route, emptyProviderLabel) {
  const provider = form.elements.provider, model = form.elements.model, effort = form.elements.reasoningEffort
  const providers = [...new Set((modelCatalog ?? []).map(item => item.provider))].sort()
  fillOptions(provider, [['', emptyProviderLabel], ...providers.map(id => [id, id])], route?.provider ?? '')
  const models = (modelCatalog ?? []).filter(item => item.provider === provider.value)
  fillOptions(model, [['', provider.value ? '选择模型' : '先选择提供方'], ...models.map(item => [item.model, item.name === item.model ? item.model : `${item.name} · ${item.model}`])], route?.model ?? '')
  model.disabled = !provider.value || !models.length
  const entry = modelFor(provider.value, model.value)
  fillOptions(effort, [['', '使用模型默认'], ...(entry?.reasoningEfforts ?? []).map(item => [item.id, item.name])], route?.reasoningEffort ?? '')
  effort.disabled = !entry
  refreshModelButtons()
}
function refreshModelButtons() {
  for (const id of ['modelForm', 'overrideForm']) {
    const form = $(id)
    const provider = form.elements.provider.value, model = form.elements.model.value
    const route = provider && model ? modelFor(provider, model) : null
    const effort = form.elements.reasoningEffort.value
    form.querySelector('button[type=submit]').disabled = !settings.writable || modelCatalog === null
      || (id === 'overrideForm' && !form.elements.id.value)
      || (provider && (!route || effort && !(route.reasoningEfforts ?? []).some(item => item.id === effort)))
  }
}
function showExpertRoute() {
  const form = $('overrideForm')
  const id = form.elements.id.value
  const expert = expertCatalog.find(item => item.id === id)
  const override = settings.value?.expertModelOverrides?.[id]
  fillRouteForm(form, override, '不覆盖，使用专家预设')
  $('overrideCurrent').textContent = !expert ? '请选择要调整的专家。'
    : override ? `当前覆盖：${override.provider} / ${override.model}`
      : expert.effective ? `当前生效：${expert.effective.provider} / ${expert.effective.model}（${expert.source ?? '预设'}）`
        : '当前未指定模型路由。'
}
async function loadModels() {
  try {
    const result = await api('models')
    modelCatalog = Array.isArray(result.models) ? result.models.filter(item => item && typeof item.provider === 'string'
      && typeof item.model === 'string' && typeof item.name === 'string' && Array.isArray(item.reasoningEfforts ?? [])) : []
    $('modelCatalogStatus').textContent = modelCatalog.length ? `可选择 ${modelCatalog.length} 个当前实例可用模型。` : '当前实例没有可用模型。'
  } catch {
    modelCatalog = null
    $('modelCatalogStatus').textContent = '模型目录暂不可用，当前不能保存模型路由。'
  }
  fillRouteForm($('modelForm'), settings.value?.defaultModel, '沿用实例默认')
  showExpertRoute()
}
function row(title, detail, button, action) {
  const wrapper = node('div', undefined, 'manageRow')
  const body = node('div')
  body.append(node('strong', title), node('small', detail))
  wrapper.append(body)
  if (button) {
    const control = node('button', button)
    control.type = 'button'
    control.addEventListener('click', action)
    wrapper.append(control)
  }
  return wrapper
}
async function run(action, success) {
  notice('正在处理…')
  try { await action(); notice(success) }
  catch (error) { notice(`操作失败：${error.message}`) }
}
function formValue(form, key) { return String(new FormData(form).get(key) ?? '').trim() }
function lines(text) { return text.split('\n').map(item => item.trim()).filter(Boolean) }
async function updateSetting(section, value) {
  if (!settings.writable) throw new Error('当前实例的设置服务不可写')
  let response
  try { response = await api('settings', 'PUT', { section, value, revision: settings.revision }) }
  catch (error) {
    if (error.message === 'SETTINGS_CONFLICT') throw new Error('设置已在其他窗口更新，请刷新页面后重试。')
    throw error
  }
  settings.revision = response.revision
  settings.value[section] = response.value
}

async function loadSettings() {
  settings.writable = false
  settingsWriteEnabled(false)
  settings = await api('settings')
  const value = settings.value ?? {}
  const fields = $('dataForm').elements
  fields.windCliPath.value = value.providers?.wind?.cliPath ?? ''
  fields.zytBaseUrl.value = value.providers?.zyt?.baseUrl ?? ''
  fields.beikeBaseUrl.value = value.providers?.beike?.baseUrl ?? ''
  fields.zytPreferCli.value = String(value.providers?.zyt?.preferCli ?? false)
  fields.beikePreferCli.value = String(value.providers?.beike?.preferCli ?? false)
  settingsWriteEnabled(settings.writable)
  $('policyForm').elements.mode.value = value.packCenterUpdatePolicy?.mode ?? 'manual'
  renderPerPackPolicies()
  fillRouteForm($('modelForm'), value.defaultModel, '沿用实例默认')
  showExpertRoute()
  for (const key of ['stateDir', 'knowledgeDir', 'memberProvider', 'maxMembers', 'memberMaxDepth', 'promptSectionOrder', 'announceToAgent'])
    $('runtimeForm').elements[key].value = String(value.runtime?.[key] ?? '')
  $('executionRows').replaceChildren()
  for (const [id, label] of [['wind', '万得'], ['zyt', '政研通'], ['beike', '贝壳']]) {
    const field = node('label', `${label}执行模式`)
    field.dataset.source = id
    field.hidden = id !== selectedSource
    const select = node('select'); select.name = id
    for (const [mode, title] of [['auto', '自动'], ['api', 'API'], ['cli', 'CLI']]) {
      const option = node('option', title); option.value = mode; select.append(option)
    }
    select.value = value.toolExecution?.[id]?.mode ?? 'auto'
    field.append(select)
    $('executionRows').append(field)
  }
}
async function loadHealth() {
  const value = await api('health')
  $('healthCards').replaceChildren()
  for (const [id, label] of Object.entries(sourceNames)) {
    const health = value.providers?.[id] ?? {}
    const card = node('button', undefined, 'manageCard manageSourceCard')
    card.type = 'button'
    card.dataset.source = id
    card.setAttribute('aria-pressed', String(selectedSource === id))
    card.append(node('h3', label), node('p', health.registered ? '已注册' : '未注册'),
      node('small', id === 'localdb' ? `${health.databases?.length ?? 0} 个数据库`
        : `凭据${health.keyPresent ? '已配置' : '未配置'}${health.reachable === undefined ? '' : health.reachable ? ' · 连通' : ' · 暂不可连通'}`))
    card.append(node('span', id === 'localdb' ? '查看来源 →' : '选择并编辑 →', 'manageSourceCue'))
    card.addEventListener('click', () => selectDataSource(id))
    $('healthCards').append(card)
  }
  selectDataSource(selectedSource)
}

async function loadPacks() {
  try {
    const local = await api('packs')
    $('localPacks').replaceChildren()
    $('packDiagnostics').replaceChildren()
    for (const pack of local.packs ?? []) $('localPacks').append(row(`${pack.name} · ${pack.version}`,
      `${pack.id} · ${pack.layer} · ${pack.ok ? '校验通过' : `${pack.errorCount} 项错误`}`, '查看校验', () => {
        void run(async () => {
          const result = await api('pack-preview', 'GET', undefined, `?id=${encodeURIComponent(pack.id)}`)
          $('packDiagnostics').replaceChildren(node('strong', `${pack.name}：${result.ok ? '校验通过' : '校验未通过'}`))
          for (const finding of result.diagnostics ?? []) $('packDiagnostics').append(node('p',
            `${finding.severity} · ${finding.code} · ${finding.path ?? ''} ${finding.message ?? ''}`))
        }, '校验结果已显示。')
      }))
    if (!local.packs?.length) $('localPacks').append(node('p', '当前实例暂无领域包。', 'manageMuted'))
  } catch { $('localPacks').replaceChildren(node('p', '本地领域包暂时无法读取。', 'manageMuted')) }
  const outcomes = await Promise.allSettled(['center-connection', 'center-installations', 'center-updates', 'center-catalog', 'center-operations']
    .map(name => api(name)))
  const [connection, installed, updates, releases, operations] = outcomes.map(item => item.status === 'fulfilled' ? item.value : null)
  centerConnection = connection
  installations = installed
  renderPerPackPolicies()
  $('centerState').replaceChildren(node('h3', '版本中心'),
    node('p', connection?.connection?.bound ? `已绑定 · ${connection.connection.centerId}` : connection?.configured ? '已配置，尚未绑定' : '当前实例未配置版本中心'))
  $('centerBindDetails').hidden = !connection?.configured || !!connection?.connection?.bound
  if (connection?.connection?.bound) {
    const unbind = node('button', '解除绑定', 'secondary')
    unbind.type = 'button'
    unbind.addEventListener('click', () => {
      if (confirm('解除当前版本中心绑定？已安装的领域包会留在本地。'))
        void run(async () => { await api('center-unbind', 'POST', { expectedRevision: centerConnection.revision }); await loadPacks() }, '已解除绑定。')
    })
    $('centerState').append(unbind)
  }
  $('checkUpdates').disabled = !connection?.connection?.bound
  $('catalogStatus').textContent = !releases ? '版本目录暂时无法读取。'
    : '正在整理可安装版本…'
  if (releases?.stale) $('catalogStatus').textContent += ' 目录快照可能过期，安装操作已暂停。'
  const expanded = Object.fromEntries(['installedPacks', 'catalogPacks'].map(id => [id,
    new Set([...$(id).querySelectorAll('details[open][data-pack-id]')].map(details => details.dataset.packId))]))
  $('installedPacks').replaceChildren()
  $('catalogPacks').replaceChildren()
  const installedItems = installed?.items ?? []
  {
    const groups = new Map()
    const groupFor = packId => {
      if (!groups.has(packId)) groups.set(packId, { packId, name: packId, installed: [], available: [] })
      return groups.get(packId)
    }
    const installedIds = new Set(installedItems.map(item => item.releaseId))
    for (const item of installedItems) groupFor(item.packId).installed.push(item)
    for (const release of releases?.items ?? []) {
      const group = groupFor(release.packId)
      if (release.name) group.name = release.name
      if (!installedIds.has(release.releaseId)) group.available.push(release)
    }
    const canSwitch = installed?.mode === 'normal' && connection?.activationAvailable === true && !connection?.errorCode
    const canDownload = installed?.mode === 'normal' && !!connection?.connection?.bound && !connection?.errorCode && releases?.stale === false
    const versionOrder = (a, b) => b.version.localeCompare(a.version, 'en', { numeric: true })
    const downloadable = entry => ['manifestSha256', 'artifactSha256', 'contentTreeSha256']
      .every(key => /^[a-f0-9]{64}$/.test(entry[key] ?? ''))
      && entry.compatibility?.compatible === true && entry.downloadAvailability?.available === true
    const installable = entry => canDownload && downloadable(entry)
    const groupDetails = (group, target) => {
      const active = group.installed.find(item => item.active)
      const details = node('details', undefined, 'managePackGroup')
      details.dataset.packId = group.packId
      details.open = expanded[target].has(group.packId)
      const summary = node('summary')
      const title = node('span', undefined, 'managePackGroupTitle')
      title.append(node('strong', group.name))
      if (group.name !== group.packId) title.append(node('small', group.packId))
      const meta = node('span', undefined, 'managePackGroupMeta')
      meta.append(node('strong', target === 'installedPacks' ? active ? `当前 v${active.version}` : '未启用'
        : group.installed.length ? '已有安装版本' : '新领域包'),
      node('small', target === 'installedPacks' ? `已安装 ${group.installed.length} 个版本`
        : `可安装 ${group.available.filter(installable).length} / ${group.available.length} 个版本`))
      summary.append(title, meta, node('span', '⌄', 'managePackChevron'))
      details.append(summary)
      const versions = node('div', undefined, 'managePackVersionList')
      const entries = (target === 'installedPacks'
        ? group.installed.map(item => ({ ...item, installed: true }))
        : group.available.map(item => ({ ...item, installed: false }))).sort(versionOrder)
      for (const entry of entries) {
        const version = node('div', undefined, 'managePackVersion')
        const info = node('div', undefined, 'managePackVersionInfo')
        const heading = node('strong', `v${entry.version}`)
        heading.append(node('span', entry.active ? '当前启用' : entry.installed ? '已安装' : installable(entry) ? '可安装' : '暂不可安装',
          `manageStatus${entry.active ? '' : ' off'}`))
        info.append(heading, node('small', entry.installed
          ? `${entry.source === 'legacy' ? '本地版本' : '版本中心'} · ${entry.integrity === 'verified' ? '校验通过' : '启用时重新校验'}`
          : !canDownload ? '版本中心当前不可安装，请检查绑定和目录状态'
            : entry.compatibility?.compatible === false ? '与当前实例不兼容'
            : entry.downloadAvailability?.available === false ? '当前不可下载'
              : !downloadable(entry) ? '版本信息不完整，暂不可安装' : '可从版本中心安装'))
        const actions = node('div', undefined, 'managePackVersionActions')
        const addAction = (label, kind, disabled, secondary = false) => {
          const button = node('button', label, secondary ? 'secondary' : undefined)
          button.type = 'button'
          button.disabled = disabled
          button.addEventListener('click', () => void packOperation(kind, entry))
          actions.append(button)
        }
        if (entry.installed) addAction(entry.active ? '停用' : active ? '切换到此版本' : '启用此版本',
          entry.active ? 'disable' : 'enable', !canSwitch, entry.active)
        else {
          const unavailable = !installable(entry)
          addAction('仅安装', 'install', unavailable, true)
          addAction('安装并切换', 'update_enable', unavailable || !canSwitch)
        }
        version.append(info, actions)
        versions.append(version)
      }
      details.append(versions)
      $(target).append(details)
    }
    const sorted = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    for (const group of sorted.filter(group => group.installed.length)) groupDetails(group, 'installedPacks')
    for (const group of sorted.filter(group => group.available.length)) groupDetails(group, 'catalogPacks')
    if (!installed) $('installedPacks').append(node('p', '安装记录暂时无法读取，请刷新版本状态。', 'manageMuted'))
    else if (!installedItems.length) $('installedPacks').append(node('p', '暂无已安装版本。', 'manageMuted'))
    if (!releases) $('catalogPacks').append(node('p', '版本中心目录暂时无法读取，请刷新版本状态。', 'manageMuted'))
    else if (!$('catalogPacks').childElementCount) $('catalogPacks').append(node('p', '目录中的版本均已安装，暂无可安装版本。', 'manageMuted'))
    if (releases) {
      const catalogGroups = sorted.filter(group => group.available.length)
      const availableCount = catalogGroups.reduce((count, group) => count + group.available.filter(installable).length, 0)
      $('catalogStatus').textContent = `可安装 ${availableCount} 个版本，涉及 ${catalogGroups.length} 个领域包。${releases.nextCursor ? '目录还有更多版本，请稍后刷新。' : ''}`
      if (releases.stale) $('catalogStatus').textContent += ' 目录快照可能过期，安装操作已暂停。'
    }
  }
  $('operations').replaceChildren()
  for (const operation of (operations ?? []).slice(0, 8)) $('operations').append(row(
    `${operation.request?.kind ?? '操作'} · ${operation.status}`, operation.errorCode ?? operation.operationId))
  if (!updates?.stale && updates?.generation === installed?.generation
    && updates?.items?.some(item => item.status === 'update_available')) {
    const available = updates.items.filter(item => item.status === 'update_available').length
    $('catalogStatus').textContent += ` · ${available} 个更新可用`
  }
}
async function packOperation(kind, item) {
  if (!installations) return
  const action = { install: '仅安装', update_enable: '安装并切换', enable: '切换到', disable: '停用' }[kind]
  if (!confirm(`${action} ${item.packId}${kind === 'disable' ? '' : ` v${item.version}`}？${kind === 'install' ? '此操作不会改变当前启用版本。' : '后续新任务将使用更新后的版本状态。'}`)) return
  const input = { operationKey: `portal-${crypto.randomUUID()}`, kind, expectedGeneration: installations.generation }
  if (kind === 'disable') input.packId = item.packId
  else input.releaseId = item.releaseId
  if (kind === 'install' || kind === 'update_enable') {
    input.connectionRevision = centerConnection?.revision
    input.target = { manifestSha256: item.manifestSha256, artifactSha256: item.artifactSha256, contentTreeSha256: item.contentTreeSha256 }
  }
  await run(async () => { try { await api('center-operations', 'POST', input) } finally { await loadPacks() } },
    '操作已提交，请在下方查看结果或刷新版本状态。')
}

async function loadExperts() {
  const results = await Promise.allSettled(['managed-experts', 'managed-scenarios', 'experts', 'skills'].map(name => api(name)))
  const [experts, scenarios, routes, skills] = results.map(item => item.status === 'fulfilled' ? item.value : null)
  for (const [target, data, key, name] of [['managedExperts', experts, 'experts', 'managed-experts'], ['managedScenarios', scenarios, 'scenarios', 'managed-scenarios']]) {
    $(target).replaceChildren()
    for (const item of data?.[key] ?? []) $(target).append(row(item.name ?? item.id, item.invalid ? `${item.id} · 配置无效` : item.id,
      '删除', () => { if (confirm(`删除 ${item.id}？`)) void run(async () => { await api(name, 'DELETE', undefined, `?id=${encodeURIComponent(item.id)}`); await loadExperts() }, '已删除。') }))
    if (!data?.[key]?.length) $(target).append(node('p', '暂无自定义内容。', 'manageMuted'))
  }
  $('expertRoutes').replaceChildren()
  for (const item of (routes?.experts ?? []).slice(0, 150)) $('expertRoutes').append(row(item.name ?? item.id,
    `${item.id} · ${item.effective ? `${item.effective.provider}/${item.effective.model}` : '未指定模型'} · ${item.source ?? '默认'}`))
  expertCatalog = (routes?.experts ?? []).filter(item => typeof item.id === 'string')
  const expertSelect = $('overrideForm').elements.id
  const selectedExpert = expertSelect.value
  fillOptions(expertSelect, [['', '选择专家'], ...expertCatalog.map(item => [item.id, `${item.name ?? item.id} · ${item.id}`])], selectedExpert)
  showExpertRoute()
  $('skillsList').replaceChildren()
  for (const item of (skills?.skills ?? []).slice(0, 100)) $('skillsList').append(row(item.name ?? item.id, item.id))
}

$('dataForm').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget
  void run(async () => {
    const source = selectedSource
    if (source === 'localdb') return
    const providers = Object.fromEntries(['wind', 'zyt', 'beike']
      .filter(id => settings.value.providers?.[id])
      .map(id => [id, structuredClone(settings.value.providers[id])]))
    const current = { ...(providers[source] ?? {}) }
    const field = source === 'wind' ? 'cliPath' : 'baseUrl'
    const value = formValue(form, source === 'wind' ? 'windCliPath' : `${source}BaseUrl`)
    if (value) current[field] = value
    else delete current[field]
    if (source !== 'wind') current.preferCli = formValue(form, `${source}PreferCli`) === 'true'
    if (Object.keys(current).length) providers[source] = current
    else delete providers[source]
    await updateSetting('providers', providers); await loadHealth()
  }, `${sourceNames[selectedSource]}配置已保存。`) })
$('executionForm').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget
  void run(() => {
    const id = selectedSource
    const selected = structuredClone(settings.value.toolExecution ?? {})
    const mode = formValue(form, id), readOnly = settings.value.toolExecution?.[id]?.readOnly ?? false
    if (mode !== 'auto' || readOnly) selected[id] = { ...(mode !== 'auto' ? { mode } : {}), ...(readOnly ? { readOnly: true } : {}) }
    else delete selected[id]
    return updateSetting('toolExecution', selected)
  }, '工具执行模式已保存。') })
$('policyForm').addEventListener('change', () => {
  if (settings.writable) $('policyStatus').textContent = '策略已修改，点击“保存策略”后生效。'
})
$('policyForm').addEventListener('submit', event => { event.preventDefault(); const mode = formValue(event.currentTarget, 'mode')
  const perPack = {}
  for (const select of $('perPackPolicies').querySelectorAll('select[data-pack-id]')) if (select.value) perPack[select.dataset.packId] = select.value
  const button = event.currentTarget.querySelector('button[type=submit]')
  button.disabled = true
  $('policyStatus').textContent = '正在保存策略…'
  void updateSetting('packCenterUpdatePolicy', { mode, perPack }).then(() => {
    $('policyStatus').textContent = '更新策略已保存。'
    notice('更新策略已保存。')
  }).catch(error => {
    $('policyStatus').textContent = `保存失败：${error.message}`
    notice(`操作失败：${error.message}`)
  }).finally(() => { button.disabled = !settings.writable }) })
$('modelForm').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget
  const provider = formValue(form, 'provider'), model = formValue(form, 'model')
  if (provider && !modelFor(provider, model)) return notice('请从当前实例的模型目录中选择提供方和模型。')
  const reasoningEffort = formValue(form, 'reasoningEffort')
  void run(() => updateSetting('defaultModel', provider ? { provider, model,
    ...(reasoningEffort ? { reasoningEffort } : {}) } : {}), '默认模型已保存。') })
$('overrideForm').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget
  const id = formValue(form, 'id'), provider = formValue(form, 'provider'), model = formValue(form, 'model')
  if (!expertCatalog.some(item => item.id === id)) return notice('请先选择专家。')
  if (provider && !modelFor(provider, model)) return notice('请从当前实例的模型目录中选择提供方和模型。')
  const overrides = { ...settings.value.expertModelOverrides }
  const reasoningEffort = formValue(form, 'reasoningEffort')
  if (provider) overrides[id] = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
  else delete overrides[id]
  void run(async () => { await updateSetting('expertModelOverrides', overrides); await loadExperts() }, '专家路由覆盖已保存。') })
$('runtimeForm').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget
  const number = key => formValue(form, key) === '' ? null : Number(formValue(form, key))
  void run(() => updateSetting('runtime', { stateDir: formValue(form, 'stateDir'), knowledgeDir: formValue(form, 'knowledgeDir'),
    memberProvider: formValue(form, 'memberProvider'), maxMembers: number('maxMembers'),
    memberMaxDepth: number('memberMaxDepth'), promptSectionOrder: number('promptSectionOrder'),
    announceToAgent: formValue(form, 'announceToAgent') === 'true' }), '运行设置已保存。') })
$('expertForm').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget
  void run(async () => { await api('managed-experts', 'PUT', { id: formValue(form, 'id'), name: formValue(form, 'name'),
    role: formValue(form, 'role'), background: formValue(form, 'background'),
    principles: lines(formValue(form, 'principles')), deliverables: lines(formValue(form, 'deliverables')) });
  form.reset(); await loadExperts() }, '专家已保存。') })
$('scenarioForm').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget
  void run(async () => { await api('managed-scenarios', 'PUT', { id: formValue(form, 'id'), name: formValue(form, 'name'),
    description: formValue(form, 'description'), experts: lines(formValue(form, 'experts')),
    tasks: lines(formValue(form, 'tasks')).map(line => { const [subject, ...rest] = line.split('|'); return { subject: subject.trim(), description: rest.join('|').trim() } }),
    deliverable: formValue(form, 'deliverable') }); form.reset(); await loadExperts() }, '场景已保存。') })
$('skillForm').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget
  const file = form.elements.zip.files?.[0]
  if (!file || file.size > 16 * 1024 * 1024) return notice('请选择不超过 16 MB 的 zip 文件。')
  void run(async () => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
    await api('skills-install', 'POST', { id: formValue(form, 'id'), data: btoa(binary) })
    form.reset(); await loadExperts()
  }, '技能已安装。') })
$('centerBindForm').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget
  void run(async () => { await api('center-bind', 'POST', { expectedRevision: centerConnection?.revision ?? 0,
    expectedCenterId: formValue(form, 'centerId'), bindingCode: formValue(form, 'bindingCode'),
    trustedSigningKeys: { [formValue(form, 'keyId')]: formValue(form, 'pem') } });
  form.reset(); await loadPacks() }, '版本中心已绑定。') })
$('checkUpdates').addEventListener('click', () => void run(async () => { await api('center-check-updates', 'POST', {}); await loadPacks() }, '更新检查完成。'))
$('refreshPacks').addEventListener('click', () => void run(loadPacks, '领域包列表已刷新。'))
for (const [id, emptyLabel] of [['modelForm', '沿用实例默认'], ['overrideForm', '不覆盖，使用专家预设']]) {
  const form = $(id)
  form.elements.provider.addEventListener('change', () => fillRouteForm(form, { provider: form.elements.provider.value }, emptyLabel))
  form.elements.model.addEventListener('change', () => fillRouteForm(form,
    { provider: form.elements.provider.value, model: form.elements.model.value }, emptyLabel))
  form.elements.reasoningEffort.addEventListener('change', refreshModelButtons)
}
$('overrideForm').elements.id.addEventListener('change', showExpertRoute)

let settingsLoad
async function activateTab() {
  const id = selectedTab()
  const request = ++tabRequest
  showTab(id)
  notice('')
  requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  const loader = { data: loadHealth, packs: loadPacks,
    experts: () => Promise.all([loadExperts(), loadModels()]), usage: loadUsage }[id]
  const results = await Promise.allSettled([settingsLoad, loader()])
  if (request === tabRequest && (results[1].status === 'rejected' || (id !== 'usage' && results[0].status === 'rejected')))
    notice('当前分区有部分内容暂时无法读取，请稍后刷新页面。')
}
window.addEventListener('hashchange', () => { if (tabsReady) void activateTab() })
for (const [index, id] of tabIds.entries()) $(`tab-${id}`).addEventListener('keydown', event => {
  const target = event.key === 'ArrowRight' ? tabIds[(index + 1) % tabIds.length]
    : event.key === 'ArrowLeft' ? tabIds[(index + tabIds.length - 1) % tabIds.length]
      : event.key === 'Home' ? tabIds[0] : event.key === 'End' ? tabIds[tabIds.length - 1] : null
  if (!target) return
  event.preventDefault()
  $(`tab-${target}`).focus()
  if (location.hash === `#${target}`) showTab(target)
  else location.hash = target
})

try {
  const response = await fetch('/api/bootstrap', { credentials: 'same-origin', cache: 'no-store' })
  const bootstrap = await response.json()
  if (!bootstrap.authenticated) { $('accessState').textContent = '请先登录。'; }
  else if (bootstrap.user?.role !== 'admin') { $('accessState').textContent = '当前账号没有能力管理权限。'; }
  else if (!bootstrap.researchReady) { $('accessState').textContent = '当前账号的研究实例尚未开通。'; }
  else {
    $('accountLabel').textContent = bootstrap.user.accountName
    $('accessState').hidden = true
    $('manageContent').hidden = false
    tabsReady = true
    settingsLoad = loadSettings().catch(error => {
      settingsWriteEnabled(false)
      $('settingsStatus').textContent = '当前实例的设置接口尚未就绪，数据源与模型路由暂不能保存。'
      throw error
    })
    await activateTab()
  }
} catch { $('accessState').textContent = '服务暂时不可用，请刷新页面重试。' }
