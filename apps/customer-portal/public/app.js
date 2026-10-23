const bootView = document.getElementById('bootView')
const shareMode = location.pathname === '/share'
const shareToken = shareMode ? new URLSearchParams(location.hash.slice(1)).get('token') : null
let sharePermission
let sharedAccessExpired = false
const sharedReadOnly = () => shareMode && sharePermission === 'read'
function expireSharedView() {
  if (!shareMode || sharedAccessExpired) return
  sharedAccessExpired = true
  previewView.hidden = true
  bootView.hidden = false
  bootView.querySelector('.paintLoader').hidden = true
  bootView.querySelector('span:last-child').textContent = '分享链接已到期或已撤销，请联系分享人重新生成。'
}
async function apiFetch(input, options = {}) {
  const { networkRetry = false, ...requestOptions } = options
  const headers = new Headers(options.headers)
  if (shareMode) headers.set('authorization', `Bearer ${shareToken ?? 'invalid'}`)
  const request = () => fetch(input, { ...requestOptions, headers })
  let response
  try { response = await request() }
  catch (error) {
    if (!networkRetry || (requestOptions.method && requestOptions.method !== 'GET') || requestOptions.signal?.aborted) throw error
    await new Promise(resolve => window.setTimeout(resolve, 350))
    response = await request()
  }
  if (shareMode && response.status === 401 && input !== '/api/bootstrap') expireSharedView()
  return response
}
const loginView = document.getElementById('loginView')
const previewView = document.getElementById('previewView')
const loginStatus = document.getElementById('loginStatus')
const menuButton = document.getElementById('menuButton')
const sidebar = document.querySelector('.sessionSidebar')
const scrim = document.getElementById('scrim')
const developerLogin = document.getElementById('developerLogin')
const logoutButton = document.getElementById('logoutButton')
const usageButton = document.getElementById('usageButton')
const usageDialog = document.getElementById('usageDialog')
const usageBody = document.getElementById('usageBody')
const newSessionButton = document.getElementById('newSessionButton')
const sendMessageButton = document.getElementById('sendMessageButton')
const conversationInput = document.getElementById('conversationInput')
const conversationWorkspace = document.getElementById('conversationWorkspace')
const conversationModelSelect = document.getElementById('conversationModelSelect')
const conversationModelTrigger = document.getElementById('conversationModelTrigger')
const conversationModelName = document.getElementById('conversationModelName')
const conversationModelMenu = document.getElementById('conversationModelMenu')
const conversationModelOptions = document.getElementById('conversationModelOptions')
const conversationModelStatus = document.getElementById('conversationModelStatus')
const conversationMessages = document.getElementById('conversationMessages')
const emptyConversation = conversationMessages.firstElementChild.cloneNode(true)
const conversationEarlier = document.createElement('button')
conversationEarlier.type = 'button'
conversationEarlier.className = 'conversationEarlier'
conversationEarlier.textContent = '查看更早消息 ↑'
const conversationActivity = document.getElementById('conversationActivity')
const conversationSendStatus = document.getElementById('conversationSendStatus')
const conversationLatest = document.getElementById('conversationLatest')
const questionCard = document.getElementById('questionCard')
const approvalCard = document.getElementById('approvalCard')
const questionShortcut = document.getElementById('questionShortcut')
const actionCenter = document.getElementById('actionCenter')
const actionItems = document.getElementById('actionItems')
const workspaceExperts = document.getElementById('workspaceExperts')
const mentionMenu = document.getElementById('mentionMenu')
const dataList = document.getElementById('dataList')
const dataListToggle = document.getElementById('dataListToggle')
const dataListToggleLabel = dataListToggle.querySelector('span')
const dataItems = document.getElementById('dataItems')
const dataCount = document.getElementById('dataCount')
const dataEmpty = document.getElementById('dataEmpty')
const dataMore = document.getElementById('dataMore')
const tablePane = document.getElementById('tablePane')
const workspaceStatus = document.getElementById('workspaceStatus')
const workspacePanels = Object.fromEntries(['plan', 'outline', 'team', 'results'].map(tab =>
  [tab, document.getElementById(`workspace${tab[0].toUpperCase()}${tab.slice(1)}Panel`)]))
const workspaceDocumentDialog = document.getElementById('workspaceDocumentDialog')
let currentSessionId
let sessionListFilter = 'all'
let sessionActivityKnown = false
let sessionActivityUnknown = false
let sessionActivityLoading = false
let previewActive = false
let currentAccountName
let currentModelValue = ''
// Private API responses are never placed in the HTTP cache. IndexedDB is only
// a bounded, account-scoped first paint; every view is rechecked with the server.
const sessionCache = (() => {
  const databaseName = 'zhijian-session-preview-v1'
  const ttl = 3 * 24 * 60 * 60 * 1000
  let database
  function openDatabase() {
    if (!('indexedDB' in window)) return Promise.resolve(null)
    if (!database) database = new Promise(resolve => {
      try {
        const request = indexedDB.open(databaseName, 1)
        request.onupgradeneeded = () => request.result.createObjectStore('entries')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
        request.onblocked = () => resolve(null)
      } catch { resolve(null) }
    })
    return database
  }
  const key = (account, kind, id = '') => JSON.stringify([account, kind, id])
  async function read(account, kind, id) {
    if (!account || shareMode) return null
    const db = await openDatabase()
    if (!db) return null
    return new Promise(resolve => {
      try {
        const request = db.transaction('entries', 'readonly').objectStore('entries').get(key(account, kind, id))
        request.onsuccess = () => {
          const entry = request.result
          resolve(entry && entry.expiresAt > Date.now() ? entry.value : null)
        }
        request.onerror = () => resolve(null)
      } catch { resolve(null) }
    })
  }
  async function write(account, kind, id, value) {
    if (!account || shareMode) return
    const db = await openDatabase()
    if (!db) return
    try {
      db.transaction('entries', 'readwrite').objectStore('entries').put(
        { expiresAt: Date.now() + ttl, value }, key(account, kind, id))
    } catch { /* Browser storage can be disabled or full. */ }
  }
  async function clear(account) {
    if (!account) return
    const db = await openDatabase()
    if (!db) return
    await new Promise(resolve => {
      try {
        const transaction = db.transaction('entries', 'readwrite')
        transaction.oncomplete = resolve
        transaction.onerror = resolve
        transaction.onabort = resolve
        const request = transaction.objectStore('entries').openCursor()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return
          try { if (JSON.parse(cursor.key)[0] === account) cursor.delete() } catch { /* Ignore unknown keys. */ }
          cursor.continue()
        }
      } catch { resolve() }
    })
  }
  return { read, write, clear }
})()
const cachedMessagesBySession = new Map()
function validCachedMessages(value) {
  return Array.isArray(value) && value.length <= 30 && value.every(message =>
    Number.isSafeInteger(message?.seq) && message.seq >= 0
    && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string')
}
function cacheMessages(id, messages) {
  if (shareMode || !currentAccountName) return
  const tail = messages.slice(-30)
  // One huge response should never fill browser storage or block a future load.
  if (!validCachedMessages(tail) || JSON.stringify(tail).length > 512_000) return
  cachedMessagesBySession.set(id, tail)
  void sessionCache.write(currentAccountName, 'messages', id, tail)
}
let availableSessions = []
let researchReady = false
let conversationCursor = -1
let conversationEpoch = 0
let conversationLoading = false
let conversationOldestSeq
let conversationHasEarlier = false
let conversationEarlierLoading = false
let sessionReadController = new AbortController()
const sessionPollers = []
let activeApproval = null
let approvalLoading = false
let approvalSubmitting = false
let dataCursor
let dataEpoch = 0
let dataLoading = false
let workspaceEpoch = 0
let workspaceTab = 'plan'
let workspaceState
let workspaceEditing = false
let workspaceDraft
let workspaceBusy = false
let workspacePollingKey = ''
let workspaceModelCatalog = []
let workspaceModelError = ''
let workspaceDocumentUrl
let workspaceDocumentRequest = 0
let workspacePrimaryAction = () => selectView('conversation')
let workspaceActionUncertain = false
let teamView = 'route'
let teamFocusedTaskId
const workspaceRouteView = { teamId: null, zoom: 1, fit: false, left: 0, top: 0, mobileOverview: false }
let workspaceRouteInitObserver
const workspaceDisclosureStates = new Map()
let selectedDatasetId
let selectedDatasetLabel = ''
let activeQuestion
let questionLoading = false
let questionSubmitting = false
const pendingBySession = new Map()
const failuresBySession = new Map()
const draftsBySession = new Map()
const selectedMentionsBySession = new Map()
let composeNotice = ''
let composeNoticeKind = 'info'
let mentionChoices = [
  { name: '智见', kind: '数据源', available: false },
  { name: '数据源', kind: '定向查询', available: false },
  { name: '领域包', kind: '研究能力', available: false },
  { name: '专家', kind: '专家协作', available: false },
]
let mentionCatalogLoaded = false
let mentionCatalogNextLoadAt = 0
let mentionCatalogLoading = false
const mentionGroups = [
  { key: 'data-source', label: '数据源', detail: '查询已接入的数据', unit: '个' },
  { key: 'domain-pack', label: '领域包', detail: '调用已部署的研究方法', unit: '个' },
  { key: 'expert', label: '专家', detail: '按专家档案单独作答', unit: '位' },
]
let activeMentionGroup = null

async function loadMentionChoices() {
  if (!researchReady || sharedReadOnly() || mentionCatalogLoading) return
  mentionCatalogLoading = true
  mentionCatalogNextLoadAt = Date.now() + 15_000
  updateMentionMenu()
  try {
    const response = await apiFetch('/api/mentions', { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error('mention catalog unavailable')
    const { items } = await response.json()
    if (!Array.isArray(items)) throw new Error('invalid mention catalog')
    const sources = items.filter(item => item?.kind === 'data-source' && typeof item.name === 'string'
      && item.name.length > 0 && item.name.length <= 64).map(item => ({ name: item.name, kind: '数据源', available: true }))
    const capabilities = items.filter(item => ['domain-pack', 'expert'].includes(item?.kind)
      && typeof item.id === 'string' && typeof item.version === 'string'
      && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 64)
      .map(item => ({ name: item.name, kind: item.kind === 'domain-pack' ? '领域包' : '专家',
        type: item.kind, id: item.id, version: item.version, description: item.description,
        model: item.model, available: true }))
    mentionChoices = [
      ...sources,
      ...capabilities,
      ...(!sources.some(item => item.name === '智见') ? [{ name: '智见', kind: '数据源', available: false }] : []),
      ...(!capabilities.some(item => item.type === 'domain-pack') ? [{ name: '领域包', kind: '研究能力', available: false }] : []),
      ...(!capabilities.some(item => item.type === 'expert') ? [{ name: '专家', kind: '专家协作', available: false }] : []),
    ]
    mentionCatalogLoaded = true
    mentionCatalogNextLoadAt = Date.now() + 5 * 60_000
  } catch {
    if (!mentionCatalogLoaded) mentionChoices = [
      { name: '智见', kind: '数据源', available: false },
      { name: '领域包', kind: '研究能力', available: false },
      { name: '专家', kind: '专家协作', available: false },
    ]
  }
  mentionCatalogLoading = false
  updateMentionMenu()
}
const panels = {
  conversation: document.getElementById('conversationPanel'),
  workspace: document.getElementById('workspacePanel'),
  data: document.getElementById('dataPanel'),
}

function isCompact() { return window.matchMedia('(max-width: 900px)').matches }

function closeSidebar() {
  sidebar.classList.remove('open')
  scrim.hidden = true
  menuButton.setAttribute('aria-expanded', 'false')
}

function selectView(view, { scrollLatest = false } = {}) {
  if (!Object.hasOwn(panels, view)) return
  const revealLatest = view === 'conversation' && (scrollLatest || panels.conversation.hidden)
  for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== view
  document.querySelector('.main').classList.toggle('conversationWide', view === 'conversation')
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.setAttribute('aria-pressed', String(button.dataset.tab === view))
  }
  if (isCompact()) closeSidebar()
  if (revealLatest) requestAnimationFrame(() => {
    if (!panels.conversation.hidden) scrollToLatest()
  })
  if (view === 'data' && currentSessionId) void loadDatasets()
  if (view === 'workspace' && currentSessionId) void loadWorkspace(currentSessionId)
}

document.addEventListener('toggle', event => {
  const disclosure = event.target?.dataset?.disclosure
  if (disclosure) workspaceDisclosureStates.set(disclosure, event.target.open)
}, true)

function workspaceDetails(key, title, open = false, className = '') {
  const details = wsNode('details', undefined, className)
  details.dataset.disclosure = key
  details.open = workspaceDisclosureStates.get(key) ?? open
  details.append(wsNode('summary', title))
  return details
}

function wsNode(tag, value, className) {
  const node = document.createElement(tag)
  if (value !== undefined) node.textContent = String(value)
  if (className) node.className = className
  return node
}

let manuscriptSequence = 0
function manuscript(content) {
  const root = wsNode('article', undefined, 'manuscript')
  const source = String(content ?? '')
  if (typeof DOMPurify === 'undefined' || typeof marked === 'undefined') {
    root.textContent = source
    root.classList.add('manuscriptPlain')
    return root
  }
  root.innerHTML = DOMPurify.sanitize(marked.parse(source, { gfm: true, breaks: false }), {
    ALLOWED_TAGS: ['p','br','hr','h1','h2','h3','h4','h5','h6','strong','em','del','blockquote','ul','ol','li','pre','code','table','thead','tbody','tr','th','td','a','input'],
    ALLOWED_ATTR: ['href','title','start','type','checked','disabled','align'],
    ALLOW_DATA_ATTR: false,
  })
  for (const input of root.querySelectorAll('input')) { input.type = 'checkbox'; input.disabled = true }
  for (const link of root.querySelectorAll('a')) {
    const href = link.getAttribute('href') || ''
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
      link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer'
    } else if (/^\/api\/residential-v2\/files\/rv2-[0-9a-f]{24}\/(?:price_full|price_external|rent_full|rent_external)-[0-9a-f]{12}$/.test(href)) {
      link.setAttribute('download', '')
    } else if (href.startsWith('/plugins/dsh-expert-library/workspace-file?')) {
      const url = new URL(href, location.origin)
      const keys = [...url.searchParams.keys()].sort()
      const session = url.searchParams.get('sessionId') ?? ''
      const path = url.searchParams.get('path') ?? ''
      if (url.origin === location.origin && url.pathname === '/plugins/dsh-expert-library/workspace-file'
        && keys.join(',') === 'path,sessionId'
        && /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session)
        && path.toLowerCase().endsWith('.docx')) link.setAttribute('download', '')
      else link.removeAttribute('href')
    } else link.removeAttribute('href')
  }
  for (const table of root.querySelectorAll('table')) {
    const wrap = wsNode('div', undefined, 'markdownTable')
    wrap.tabIndex = 0
    wrap.setAttribute('role', 'region')
    wrap.setAttribute('aria-label', '数据表格，可横向滚动')
    table.replaceWith(wrap)
    wrap.append(table)
  }
  for (const pre of root.querySelectorAll('pre')) pre.tabIndex = 0
  const headings = [...root.querySelectorAll('h1,h2,h3')]
  if (headings.length > 2) {
    const toc = wsNode('details', undefined, 'documentOutline')
    toc.append(wsNode('summary', `本文目录 · ${headings.length} 节`))
    const nav = wsNode('nav')
    nav.setAttribute('aria-label', '文档目录')
    const prefix = `manuscript-${++manuscriptSequence}-`
    headings.forEach((heading, index) => {
      heading.id = `${prefix}${index}`
      const button = wsNode('button', heading.textContent)
      button.type = 'button'
      button.addEventListener('click', () => heading.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }))
      nav.append(button)
    })
    toc.append(nav)
    root.prepend(toc)
  }
  return root
}

function wsButton(value, onClick, primary = false) {
  const button = wsNode('button', value, primary ? 'primary' : '')
  button.type = 'button'
  button.addEventListener('click', onClick)
  return button
}

function setWorkspaceStatus(value, kind = 'info') {
  workspaceStatus.textContent = value
  workspaceStatus.dataset.kind = kind
}

const workspaceStatusLabels = {
  staged: '待确认', approved: '已确认', running: '执行中', completed: '已完成', failed: '需要处理',
  pending: '待开始', claimed: '已接手', in_progress: '执行中', blocked: '受阻', stopped: '已暂停',
  awaiting_review: '待评审', reviewing: '评审中', repairing: '修改中', passed: '评审通过',
  integrated: '已验收', escalated: '待处理', cancelled: '已取消',
  pass: '通过', fail: '未通过', revise: '需修改', soft: '建议改进', hard: '必须处理',
}
function workspaceStatusLabel(value) { return workspaceStatusLabels[value] || '状态待确认' }

function selectWorkspaceTab(tab) {
  if (!Object.hasOwn(workspacePanels, tab)) return
  workspaceTab = tab
  document.getElementById('workspacePanel').dataset.activeTab = tab
  for (const [name, panel] of Object.entries(workspacePanels)) panel.hidden = name !== tab
  for (const button of document.querySelectorAll('[data-workspace-tab]')) {
    button.setAttribute('aria-current', String(button.dataset.workspaceTab === tab))
  }
}

function workspaceChoiceTab(task) {
  return /outline|大纲|viewpoints\.md/i.test(`${task.humanChoice?.artifact ?? ''} ${task.subject ?? ''}`) ? 'outline' : 'results'
}

function workspacePendingChoices(state) {
  return (state?.team?.tasks ?? []).filter(task => task.status === 'pending' && task.humanChoice && !task.humanChoice.receipt)
}

function workspaceFormalGroups(documents) {
  const groups = new Map()
  for (const doc of documents.filter(item => item.formal)) {
    const key = doc.resultKey || 'report'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(doc)
  }
  const rank = doc => /\.pdf$/i.test(doc.name) ? 0 : /\.html?$/i.test(doc.name) ? 1 : /\.md$/i.test(doc.name) ? 2 : 3
  return [...groups.values()].map(items => items.sort((a, b) => rank(a) - rank(b) || (b.createdAt ?? 0) - (a.createdAt ?? 0)))
}

function focusWorkspaceAction(tab, taskId) {
  selectView('workspace')
  selectWorkspaceTab(tab)
  requestAnimationFrame(() => {
    const target = taskId ? [...workspacePanels[tab].querySelectorAll('[data-gate-task]')]
      .find(item => item.dataset.gateTask === taskId) : workspacePanels[tab]
    target?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    target?.querySelector('button,summary')?.focus({ preventScroll: true })
  })
}

function renderActionCenter() {
  actionItems.replaceChildren()
  if (!currentSessionId) { actionCenter.hidden = true; return }
  const state = workspaceState
  const items = []
  if (activeQuestion) items.push({ title: '回答智见小秘书的问题', detail: '提交选择后继续当前会话', label: '查看提问', run: () => {
    questionCard.scrollIntoView({ block: 'start', behavior: 'smooth' })
    questionCard.querySelector('input:not([disabled])')?.focus({ preventScroll: true })
  } })
  if (activeApproval) items.push({ title: '确认生成四份 Word 报告', detail: '仅针对当前会话的福州脱敏样例，允许一次或拒绝',
    label: '查看确认', run: () => approvalCard.scrollIntoView({ block: 'start', behavior: 'smooth' }) })
  if (state?.plan?.status === 'staged' && !state.team) items.push({
    title: state.contextReview?.changed ? '复核计划后的新输入' : '确认研究计划',
    detail: state.contextReview?.changed ? '先核对新增要求，再修订或生成新版计划' : `第 ${state.plan.revision} 版 · 先核对目标、路线和交付要求`,
    label: '审阅计划', run: () => focusWorkspaceAction('plan') })
  for (const task of workspacePendingChoices(state)) items.push({ title: task.subject || '确认研究稿件',
    detail: task.humanChoice.sha256 && task.humanChoice.content ? '原稿已就绪，等待你的选择' : '确认材料准备中',
    label: task.humanChoice.sha256 && task.humanChoice.content ? '查看并确认' : '查看状态',
    run: () => focusWorkspaceAction(workspaceChoiceTab(task), task.id) })
  actionCenter.hidden = !items.length
  document.getElementById('actionCount').textContent = String(items.length)
  for (const item of items) {
    const row = wsNode('div', undefined, 'actionItem')
    const copy = wsNode('div')
    copy.append(wsNode('strong', item.title), wsNode('small', item.detail))
    row.append(copy, wsButton(item.label, item.run, true))
    actionItems.append(row)
  }
}

function renderWorkspace(state) {
  const title = document.getElementById('workspaceTitle')
  const description = document.getElementById('workspaceDescription')
  const planLabel = document.getElementById('workspacePlan')
  const outlineLabel = document.getElementById('workspaceOutline')
  const teamLabel = document.getElementById('workspaceTeam')
  const resultLabel = document.getElementById('workspaceResult')
  const plan = state.plan, team = state.team
  const residentialDemo = !plan && !team && state.residentialDemo?.kind === 'fuzhou-golden-demo'
    ? state.residentialDemo : null
  const count = Array.isArray(state.datasets) ? state.datasets.length : 0
  const documents = Array.isArray(state.documents) ? state.documents : []
  const formal = workspaceFormalGroups(documents)
  const conversationReports = documents.filter(item => item.source === 'conversation')
  const historical = state.preview?.source === 'original-session'
  const choices = workspacePendingChoices(state)
  const reportedStages = state.presentation?.stages ?? (residentialDemo
    ? { plan: 'done', outline: 'done', activity: 'na', results: residentialDemo.status === 'succeeded' ? 'done' : 'pending' }
    : { plan: plan ? 'pending' : 'na', outline: 'na', activity: 'na', results: 'na' })
  const stages = { ...reportedStages }
  if (conversationReports.length && stages.results === 'na') stages.results = 'pending'
  const labels = residentialDemo
    ? { plan: '执行方案', outline: '报告大纲', activity: '团队进展', results: '演示成果' }
    : { ...state.presentation?.labels }
  const planOutline = !!plan?.preview?.reportOutline?.chapters?.length
  if (planOutline && stages.outline === 'na') {
    stages.outline = team && !choices.some(choice => workspaceChoiceTab(choice) === 'outline') ? 'done' : 'pending'
  }
  if (planOutline && labels.outline === '待确认') {
    labels.plan = labels.plan === '任务计划' ? '研究计划' : labels.plan
    labels.outline = '研究大纲'
    labels.results = labels.results === '交付成果' ? '研究成果' : labels.results
  }
  const todo = Number(plan?.status === 'staged' && !team) + choices.length + Number(!!activeQuestion)
  title.textContent = residentialDemo ? '福州住宅价格与租金四报告 · 演示'
    : workspacePlanTitle(plan, team) || conversationReports[0]?.resultLabel
    || (count ? '查询数据已进入工作区' : '等待生成研究方案')
  const primary = document.getElementById('workspacePrimary')
  const phase = document.getElementById('workspacePhase')
  if (residentialDemo) {
    const done = residentialDemo.status === 'succeeded'
    phase.textContent = done ? '演示报告已生成' : '演示流程待完成'
    description.textContent = done
      ? '领域包预置流程已完成，四份 Word 通过机器检查；视觉复核和专业签核仍待完成。'
      : '已列出领域包的执行方案和报告模板；进度以当前对话为准，四份 Word 核验完成后会显示。'
    primary.firstChild.textContent = done ? '查看四份 Word ' : '返回会话 '
    workspacePrimaryAction = () => done ? selectWorkspaceTab('results') : selectView('conversation')
  } else if (formal.length) {
    phase.textContent = historical ? '原始成果已归档' : '报告已交付'
    description.textContent = historical ? '原团队任务与对应成果保留在此会话，可只读查看。' : '正式报告已通过交付检查，可以直接阅读。'
    primary.firstChild.textContent = '阅读报告 '
    workspacePrimaryAction = () => { selectWorkspaceTab('results'); void openWorkspaceDocument(formal[0][0]) }
  } else if (todo) {
    phase.textContent = '等待你的决定'
    description.textContent = `${todo} 项事项需要处理；完成后研究会继续推进。`
    primary.firstChild.textContent = '查看待办 '
    workspacePrimaryAction = () => actionCenter.scrollIntoView({ block: 'start', behavior: 'smooth' })
  } else if (team) {
    phase.textContent = stages.activity === 'done' ? '等待正式交付' : '研究进行中'
    description.textContent = stages.activity === 'done' ? '团队任务已完成，正在整理正式成果。' : '专家正在协作，可查看当前任务和后续步骤。'
    primary.firstChild.textContent = '查看团队进展 '
    workspacePrimaryAction = () => selectWorkspaceTab('team')
  } else if (conversationReports.length) {
    phase.textContent = '会话报告已生成'
    description.textContent = '当前会话的报告已归档，可在研究成果中阅读和下载；正式交付仍需独立质量检查。'
    primary.firstChild.textContent = '查看研究成果 '
    workspacePrimaryAction = () => selectWorkspaceTab('results')
  } else {
    phase.textContent = '当前研究'
    description.textContent = count ? `已保存 ${count} 项数据快照，请继续在会话中确认研究目标。` : '先在会话中确认研究主题和交付目标。'
    primary.firstChild.textContent = '返回会话 '
    workspacePrimaryAction = () => selectView('conversation')
  }
  planLabel.textContent = residentialDemo ? `领域包预置${residentialDemo.status === 'succeeded' ? ' · 已执行' : ''}`
    : plan ? `第 ${plan.revision} 版 · ${workspaceStatusLabel(plan.status)}` : '等待研究方案'
  outlineLabel.textContent = residentialDemo ? `${residentialDemo.chapters.length} 章 · 冻结模板`
    : plan?.preview?.reportOutline?.chapters?.length ? `${plan.preview.reportOutline.chapters.length} 章`
    : stages.outline === 'done' ? '大纲已确认' : stages.outline === 'na' ? '本任务不适用' : '等待研究大纲'
  const tasks = Array.isArray(team?.tasks) ? team.tasks : []
  const taskProgress = `${tasks.filter(task => task.status === 'completed').length}/${tasks.length}`
  teamLabel.textContent = team ? `${taskProgress} 项完成` : '等待启动团队'
  resultLabel.textContent = residentialDemo ? residentialDemo.status === 'succeeded'
    ? `${residentialDemo.files.length} 份 Word · 演示` : '等待四份 Word'
    : historical && formal.length ? '原始成果已归档'
    : formal.length ? '正式报告已交付'
    : conversationReports.length ? `${new Set(conversationReports.map(item => item.resultKey)).size} 份会话产出`
    : documents.length ? `${documents.length} 项档案` : '等待报告成果'
  for (const [tab, stageKey] of [['plan', 'plan'], ['outline', 'outline'], ['team', 'activity'], ['results', 'results']]) {
    const button = document.querySelector(`[data-workspace-tab="${tab}"]`)
    const stage = stages[stageKey] ?? 'na'
    const label = labels[stageKey] || { plan: '研究计划', outline: '研究大纲', activity: '团队进展', results: '研究成果' }[stageKey]
    button.querySelector('b').textContent = tab === 'team' && team ? taskProgress
      : stage === 'done' ? '✓' : stage === 'na' ? '—' : '○'
    button.querySelector('strong').textContent = label
    button.dataset.stage = stage
    const detail = button.querySelector('small')?.textContent?.trim() ?? ''
    button.title = detail ? `${label} · ${detail}` : label
    button.setAttribute('aria-label', `${label}，${stage === 'done' ? '已完成' : stage === 'na' ? '不适用' : '未完成'}${detail ? `，${detail}` : ''}`)
  }
  renderWorkspaceExperts(state)
  if (!workspaceEditing) renderWorkspacePlan(state)
  renderWorkspaceOutline(state)
  renderWorkspaceTeam(state)
  renderWorkspaceResults(state)
  selectWorkspaceTab(workspaceTab)
  renderActionCenter()
  if (historical) setWorkspaceStatus('原始队长会话与团队的只读归档 · 可查看对话、人物路线和对应成果。')
  else if (state.preview?.kind === 'external-read-only') setWorkspaceStatus('98wiki 已完成团队的只读快照 · 可查看路线和正式报告，所有操作均不会影响原团队。')
}

function workspacePlanTitle(plan, team) {
  const raw = plan?.runtime?.teamName || team?.name || ''
  if (/[\p{Script=Han}]/u.test(raw)) return raw
  const reportTask = plan?.preview?.tasks?.find(task => /报告|简报|研究成果/.test(task.subject || ''))
  const named = /《([^》]{2,80})》/.exec(reportTask?.subject || '')?.[1]
  return named || raw
}

async function loadWorkspace(sessionId, force = false) {
  if ((!force && (workspaceEditing || workspaceBusy)) || !sessionId) return
  const epoch = workspaceEpoch
  const requestKey = `${sessionId}:${epoch}`
  if (!force && workspacePollingKey === requestKey) return
  if (!force) workspacePollingKey = requestKey
  try {
    const response = await apiFetch(`/api/sessions/${sessionId}/workspace`, { credentials: 'same-origin', cache: 'no-store', signal: sessionReadController.signal })
    if (!response.ok) throw new Error('workspace unavailable')
    const state = await response.json()
    if (sessionId !== currentSessionId || epoch !== workspaceEpoch || (workspaceEditing && !force)) return
    if (!force && workspaceState && JSON.stringify(state) === JSON.stringify(workspaceState)) return true
    workspaceState = state
    workspaceActionUncertain = false
    renderWorkspace(state)
    if (workspaceStatus.textContent === '研究状态读取失败，请重试。') setWorkspaceStatus('')
    return true
  } catch {
    if (sessionId === currentSessionId && epoch === workspaceEpoch) setWorkspaceStatus('研究状态读取失败，请重试。', 'error')
    return false
  } finally { if (!force && workspacePollingKey === requestKey) workspacePollingKey = '' }
}

function workspaceField(label, value, multiline, onChange) {
  const wrapper = wsNode('label', label)
  const input = wsNode(multiline ? 'textarea' : 'input')
  input.value = value ?? ''
  input.maxLength = multiline ? 4000 : 200
  if (multiline) input.rows = 2
  input.addEventListener('input', () => onChange(input.value))
  wrapper.append(input)
  return wrapper
}

function workspaceActions(...buttons) {
  const actions = wsNode('div', undefined, 'workspaceActions')
  actions.append(...buttons)
  return actions
}

function renderWorkspacePlan(state) {
  const root = workspacePanels.plan
  root.replaceChildren()
  const plan = state.plan
  if (!plan && state.residentialDemo?.kind === 'fuzhou-golden-demo') {
    root.append(wsNode('h3', '领域包预置执行方案'),
      wsNode('p', `zhijian-residential-advisory 0.3.0 的福州脱敏黄金样例流程。${state.residentialDemo.status === 'succeeded' ? '以下步骤已完成。' : '以下是预置步骤，实际进度以对话为准。'}此处不是待审批的研究计划。`))
    const list = wsNode('ol')
    for (const step of state.residentialDemo.steps) list.append(wsNode('li', step))
    root.append(list, wsNode('small', '真实房屋新案尚未启用。'))
    return
  }
  if (!plan) {
    root.append(wsNode('h3', '先形成研究计划'), wsNode('p', '请在会话中说明研究问题、范围和报告要求。已保存的数据快照可用于制定方案。'))
    root.append(workspaceActions(wsButton('去会话说明目标', () => {
      selectView('conversation')
      if (!conversationInput.value.trim()) conversationInput.value = '请根据本会话已保存的数据，制定可供我核对的研究计划和报告大纲，并说明数据来源。'
      resizeConversationInput()
      conversationInput.focus()
    }, true)))
    return
  }
  if (workspaceEditing) { renderPlanEditor(state); return }
  root.append(wsNode('h3', workspacePlanTitle(plan, state.team) || '研究计划'))
  const meta = wsNode('div', undefined, 'workspaceMeta')
  meta.append(wsNode('span', `第 ${plan.revision} 版`), wsNode('span', plan.status === 'staged' ? '待确认' : '已进入执行'),
    wsNode('span', `${plan.preview?.tasks?.length ?? 0} 项任务`))
  root.append(meta)
  if (plan.runtime?.description) root.append(wsNode('p', plan.runtime.description))
  const grid = wsNode('div', undefined, 'workspaceCardGrid')
  for (const [label, value] of [
    ['研究目标', plan.request?.goal], ['研究数据', plan.request?.data],
    ['地区', plan.request?.city], ['时间范围', plan.request?.period],
  ]) {
    if (typeof value !== 'string' || !value.trim()) continue
    const card = wsNode('div', undefined, 'workspaceCard')
    card.append(wsNode('h4', label), wsNode('p', value))
    grid.append(card)
  }
  if (grid.childElementCount) root.append(grid)
  const snapshots = Array.isArray(state.datasets) ? state.datasets : []
  if (snapshots.length) root.append(wsNode('p', `本会话已保存 ${snapshots.length} 项数据快照。确认前请核对来源、口径与报告用途。`))
  if (plan.status === 'staged' && !state.team) {
    const context = state.contextReview
    if (!context || context.unavailable) root.append(wsNode('p', '正在核对计划创建后的用户输入；暂不能确认启动。请稍后刷新状态。', 'workspaceWarning'))
    else if (context.changed) {
      const review = wsNode('section', undefined, 'workspaceContextReview')
      review.append(wsNode('h4', '计划创建后有新的用户输入'),
        wsNode('p', '请逐条核对。要求变化时请队长修订计划；原计划仍适用时可生成包含新增输入的待审新版。两种操作都不会启动团队。'))
      const messages = wsNode('ol')
      for (const message of context.newMessages ?? []) messages.append(wsNode('li', message.text))
      if (messages.childElementCount) review.append(messages)
      else review.append(wsNode('p', '输入快照已变化，请回到会话核对完整内容并修订计划。'))
      const revise = wsButton('请队长修订计划', () => {
        selectView('conversation')
        conversationInput.value = '请核对计划创建后新增的用户输入，判断研究目标或执行要求是否变化；如有变化，请修订并重新提交当前待审计划。现在不要替我确认启动。'
        resizeConversationInput()
        conversationInput.focus()
      })
      const actions = workspaceActions(revise)
      if (messages.childElementCount) actions.append(wsButton('原计划仍适用，生成新版', () => {
        if (!window.confirm('已逐条核对新增输入，并确认原计划仍适用？这只会生成待审新版本，不会启动团队。')) return
        void runWorkspaceAction({ action: 'sync-context', expectedDigest: plan.digest,
          expectedRevision: plan.revision, expectedContextSha256: context.currentSha256 }, '输入已纳入新版计划，请重新核对后确认。')
      }, true))
      review.append(actions)
      root.append(review)
    }
    if (state.delivery && !state.delivery.ready) {
      const missing = ['md', 'html', 'pdf'].filter(extension => !state.delivery.expectedFormats?.includes(extension)).map(extension => extension.toUpperCase())
      const alert = wsNode('p', !state.delivery.finalContract
        ? '这份计划只列出了文件名，尚未给最终报告任务绑定正式交付与质量检查契约。'
        : `这份计划缺少 ${missing.join('、')} 格式的交付任务。`, 'workspaceWarning')
      root.append(alert, workspaceActions(wsButton('请智见补齐交付计划', () => {
        selectView('conversation')
        conversationInput.value = '请修订本会话最新待确认的研究计划：在同一个最终报告任务上设置 reportBundle，明确 md/html/pdf 三个文件名和 craft.version=3 的已启用领域包技能选择，并在该任务 produces 中声明这三份文件及 craft evidence。保留原有证据任务、独立质量评审、章节和数据口径；把最终报告任务关联到 report_outline 的章节。现在只修订并暂存计划，等我确认后再执行。'
        resizeConversationInput()
        conversationInput.focus()
      })))
    }
    const edit = wsButton('编辑计划与大纲', () => {
      workspaceDraft = {
        team_name: String(plan.request?.team_name ?? plan.runtime?.teamName ?? ''),
        goal: String(plan.request?.goal ?? ''), data: String(plan.request?.data ?? ''),
        city: String(plan.request?.city ?? ''), period: String(plan.request?.period ?? ''),
        outline: structuredClone(plan.preview?.reportOutline ?? { chapters: [], attachments: [] }),
        models: Object.fromEntries([
          ...(plan.preview?.captainModel ? [['captain', structuredClone(plan.preview.captainModel)]] : []),
          ...(plan.preview?.members ?? []).filter(member => member.route).map(member => [member.expertId, structuredClone(member.route)]),
        ]),
      }
      workspaceEditing = true
      renderPlanEditor(state)
      void loadWorkspaceModels()
    })
    const approve = wsButton('确认并启动团队', () => void runWorkspaceAction({ action: 'approve', expectedDigest: plan.digest,
      expectedRevision: plan.revision }, '计划已确认，团队正在执行。'), true)
    approve.disabled = state.delivery?.ready === false || !context || context.unavailable || context.changed || workspaceActionUncertain
    root.append(workspaceActions(edit, approve))
    root.append(wsNode('small', '确认会启动真实研究任务；计划和用户输入都核对通过后才能执行。'))
  }
}

function renderPlanEditor(state) {
  const root = workspacePanels.plan
  const plan = state.plan
  if (!plan || !workspaceDraft) return
  root.replaceChildren(wsNode('h3', '编辑研究计划'))
  const form = wsNode('div', undefined, 'workspaceForm')
  const preset = !!plan.request?.compiled_source
  for (const [label, key, multiline] of [
    ['研究名称', 'team_name', false], ['研究目标', 'goal', true], ['使用的数据与口径', 'data', true],
    ['地区', 'city', false], ['时间范围', 'period', false],
  ]) {
    const field = workspaceField(label, workspaceDraft[key], multiline, value => { workspaceDraft[key] = value })
    if (preset) field.querySelector('input,textarea').disabled = true
    form.append(field)
  }
  if (preset) form.append(wsNode('small', '这份方案使用固定研究模板；目标和范围需回到会话重新制定，当前页可调整大纲和执行模型。'))
  form.append(wsNode('h4', '报告章节大纲'))
  const outline = workspaceDraft.outline
  const tasks = Array.isArray(plan.preview?.tasks) ? plan.preview.tasks : []
  outline.chapters.forEach((chapter, index) => {
    const card = wsNode('section', undefined, 'workspaceChapter')
    card.append(wsNode('h4', `第 ${index + 1} 章`),
      workspaceField('章节标题', chapter.title, false, value => { chapter.title = value }),
      workspaceField('核心问题（每行一项）', chapter.questions.join('\n'), true,
        value => { chapter.questions = value.split('\n') }),
      workspaceField('所需证据（每行一项）', chapter.evidence.join('\n'), true,
        value => { chapter.evidence = value.split('\n') }))
    const choices = wsNode('div', undefined, 'workspaceTaskChoices')
    for (const task of tasks) {
      const label = wsNode('label')
      const checkbox = wsNode('input')
      checkbox.type = 'checkbox'
      checkbox.checked = chapter.taskIds.includes(task.id)
      checkbox.addEventListener('change', () => {
        chapter.taskIds = checkbox.checked ? [...chapter.taskIds, task.id] : chapter.taskIds.filter(id => id !== task.id)
      })
      label.append(checkbox, wsNode('span', task.subject || task.id))
      choices.append(label)
    }
    card.append(wsNode('small', '负责本章的任务'), choices)
    card.append(workspaceActions(
      wsButton('上移', () => { if (index > 0) { [outline.chapters[index - 1], outline.chapters[index]] = [outline.chapters[index], outline.chapters[index - 1]]; renderPlanEditor(state) } }),
      wsButton('下移', () => { if (index < outline.chapters.length - 1) { [outline.chapters[index + 1], outline.chapters[index]] = [outline.chapters[index], outline.chapters[index + 1]]; renderPlanEditor(state) } }),
      wsButton('删除', () => { outline.chapters.splice(index, 1); renderPlanEditor(state) }),
    ))
    form.append(card)
  })
  form.append(workspaceActions(wsButton('添加章节', () => {
    outline.chapters.push({ id: `chapter-${crypto.randomUUID()}`, title: '', questions: [''], evidence: [''], taskIds: [] })
    renderPlanEditor(state)
  })))
  form.append(workspaceField('必要附件（每行一项）', outline.attachments.join('\n'), true,
    value => { outline.attachments = value.split('\n').map(row => row.trim()).filter(Boolean) }))
  const routes = wsNode('section', undefined, 'workspaceChapter')
  routes.append(wsNode('h4', '本次执行模型'))
  routes.append(wsNode('small', workspaceModelError || '只调整本计划的模型路由；保存时由服务端再次校验可用性。'))
  const roles = [
    ...(plan.preview?.captainModel ? [{ id: 'captain', label: '队长', route: plan.preview.captainModel }] : []),
    ...(plan.preview?.members ?? []).filter(member => member.route).map(member => ({ id: member.expertId,
      label: member.role || member.expertId, route: member.route })),
  ]
  const choices = [...new Map([...roles.map(role => role.route), ...workspaceModelCatalog]
    .map(route => [JSON.stringify({ provider: route.provider, model: route.model,
      ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) }), route])).values()]
  for (const role of roles) {
    const field = wsNode('label', role.label)
    const select = wsNode('select')
    for (const route of choices) {
      const option = wsNode('option', `${route.provider}/${route.model}${route.reasoningEffort ? ` · ${route.reasoningEffort}` : ''}`)
      option.value = JSON.stringify({ provider: route.provider, model: route.model,
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) })
      select.append(option)
    }
    const selected = workspaceDraft.models[role.id] ?? role.route
    select.value = JSON.stringify({ provider: selected.provider, model: selected.model,
      ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) })
    select.addEventListener('change', () => { workspaceDraft.models[role.id] = JSON.parse(select.value) })
    field.append(select)
    routes.append(field)
  }
  if (roles.length) form.append(routes)
  root.append(form)
  root.append(workspaceActions(
    wsButton('保存修改', () => void saveWorkspacePlan(state), true),
    wsButton('取消', () => { workspaceEditing = false; workspaceDraft = undefined; renderWorkspacePlan(state) }),
  ))
}

async function loadWorkspaceModels() {
  const sessionId = currentSessionId, epoch = workspaceEpoch
  try {
    const response = await apiFetch(`/api/sessions/${sessionId}/workspace/models`, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error('model catalog unavailable')
    const { models } = await response.json()
    if (!Array.isArray(models)) throw new Error('invalid model catalog')
    if (sessionId !== currentSessionId || epoch !== workspaceEpoch || !workspaceEditing) return
    workspaceModelCatalog = models.filter(route => typeof route.provider === 'string' && typeof route.model === 'string')
    workspaceModelError = ''
  } catch {
    if (sessionId !== currentSessionId || epoch !== workspaceEpoch || !workspaceEditing) return
    workspaceModelError = '模型目录暂不可用，仍可沿用计划中已保存的模型。'
  }
  if (workspaceState) renderPlanEditor(workspaceState)
}

async function saveWorkspacePlan(state) {
  const plan = state.plan
  if (!plan || !workspaceDraft) return
  const patch = {}
  for (const key of ['team_name', 'goal', 'data', 'city', 'period']) {
    const value = workspaceDraft[key].trim()
    const original = String(plan.request?.[key] ?? (key === 'team_name' ? plan.runtime?.teamName : '') ?? '').trim()
    if (value !== original) patch[key] = value
  }
  const outline = workspaceDraft.outline
  if (outline.chapters.length) {
    const clean = { chapters: outline.chapters.map(chapter => ({ id: chapter.id, title: chapter.title.trim(),
      questions: chapter.questions.map(row => row.trim()).filter(Boolean), evidence: chapter.evidence.map(row => row.trim()).filter(Boolean),
      taskIds: [...chapter.taskIds] })), attachments: outline.attachments.map(row => row.trim()).filter(Boolean) }
    if (clean.chapters.some(chapter => !chapter.title || !chapter.questions.length || !chapter.evidence.length || !chapter.taskIds.length)) {
      setWorkspaceStatus('每章需要标题、核心问题、证据和负责的任务。', 'error'); return
    }
    if (JSON.stringify(clean) !== JSON.stringify(plan.preview?.reportOutline)) patch.report_outline = clean
  } else if (plan.preview?.reportOutline) {
    setWorkspaceStatus('至少保留一个报告章节。', 'error'); return
  }
  const originalModels = Object.fromEntries([
    ...(plan.preview?.captainModel ? [['captain', plan.preview.captainModel]] : []),
    ...(plan.preview?.members ?? []).filter(member => member.route).map(member => [member.expertId, member.route]),
  ])
  if (JSON.stringify(workspaceDraft.models) !== JSON.stringify(originalModels)) patch.plan_models = workspaceDraft.models
  if (!Object.keys(patch).length) { setWorkspaceStatus('计划没有修改。'); return }
  await runWorkspaceAction({ action: 'edit', expectedDigest: plan.digest, expectedRevision: plan.revision, patch }, '计划已保存，请核对新版本后确认。')
}

async function runWorkspaceAction(action, successMessage) {
  if (previewActive || sharedReadOnly()) { setWorkspaceStatus('当前会话为只读，不能操作研究工作区。'); return }
  if (!currentSessionId || workspaceBusy || workspaceActionUncertain) return
  const sessionId = currentSessionId, epoch = workspaceEpoch
  workspaceBusy = true
  setWorkspaceStatus(action.action === 'approve' ? '正在确认计划并启动团队…' : '正在保存…')
  try {
    const response = await apiFetch(`/api/sessions/${sessionId}/workspace/action`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() ?? '' }, body: JSON.stringify(action) })
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}))
      throw Object.assign(new Error('workspace action failed'), { status: response.status, code: detail.error })
    }
    const state = await response.json()
    if (sessionId !== currentSessionId || epoch !== workspaceEpoch) return
    workspaceState = state
    workspaceEditing = false
    workspaceDraft = undefined
    renderWorkspace(state)
    setWorkspaceStatus(successMessage)
  } catch (error) {
    if (sessionId !== currentSessionId || epoch !== workspaceEpoch) return
    if (error.status === 409) {
      workspaceEditing = false
      workspaceDraft = undefined
      await loadWorkspace(sessionId, true)
      setWorkspaceStatus('计划或确认材料已变化，请核对最新版本后再操作。', 'error')
    } else if (!error.status || error.status >= 500) {
      workspaceActionUncertain = true
      try {
        await loadWorkspace(sessionId, true)
        const resolved = action.action === 'approve'
          ? !!workspaceState?.team || ['approved', 'running', 'completed'].includes(workspaceState?.plan?.status)
          : action.action === 'choose'
            ? !!workspaceState?.team?.tasks?.find(task => task.id === action.taskId)?.humanChoice?.receipt
            : action.action === 'sync-context'
              ? (workspaceState?.plan?.revision ?? 0) > action.expectedRevision && workspaceState?.contextReview?.changed === false
            : false
        setWorkspaceStatus(resolved ? successMessage : '操作结果待核实，请查看最新状态后再操作。', resolved ? 'info' : 'error')
      } catch {
        setWorkspaceStatus('操作结果待核实，正在重新读取状态；请勿重复提交。', 'error')
      }
    } else {
      const help = {
        PLAN_OUTLINE_REQUIRED: '请补齐报告章节大纲后再确认。',
        PLAN_OUTLINE_UNMAPPED_PRODUCER: '有报告任务尚未关联到章节，请编辑大纲并勾选对应任务。',
        PLAN_OUTLINE_INVALID: '章节大纲格式有误，请检查标题、问题、证据与任务。',
        PLAN_MODELS_INVALID: '执行模型不可用，请重新选择。',
        CUSTOMER_REPORT_DELIVERY_REQUIRED: '最终报告任务需要正式交付契约及 MD、HTML、PDF 三种文件，请先补齐。',
        PRESET_INPUT_FROZEN: '固定模板的目标和范围需回到会话重新制定。',
        REVIEW_SESSION_UNAVAILABLE: '研究会话暂不可用，请稍后重试。',
      }
      setWorkspaceStatus(help[error.code] || '操作未完成，请核对计划后重试。', 'error')
    }
  } finally { workspaceBusy = false }
}

function renderWorkspaceOutline(state) {
  const root = workspacePanels.outline
  root.replaceChildren(wsNode('h3', '研究大纲'))
  if (!state.plan && state.residentialDemo?.kind === 'fuzhou-golden-demo') {
    root.replaceChildren(wsNode('h3', '报告模板大纲'),
      wsNode('p', '价格报告和租金报告均使用冻结 Word 模板的以下六章；完整版与外发版为内容版本。'))
    const list = wsNode('ol')
    for (const chapter of state.residentialDemo.chapters) list.append(wsNode('li', chapter))
    root.append(list)
    return
  }
  const outline = state.plan?.preview?.reportOutline
  if (outline?.chapters?.length) {
    for (const [index, chapter] of outline.chapters.entries()) {
      const details = wsNode('details', undefined, 'workspaceCard')
      details.append(wsNode('summary', `${String(index + 1).padStart(2, '0')} · ${chapter.title}`))
      const body = wsNode('div')
      body.append(wsNode('h4', '核心问题'), wsNode('p', (chapter.questions ?? []).join('；')),
        wsNode('h4', '所需证据'), wsNode('p', (chapter.evidence ?? []).join('；')))
      const tasks = (state.plan.preview?.tasks ?? []).filter(task => chapter.taskIds?.includes(task.id))
      if (tasks.length) body.append(wsNode('small', `负责任务：${tasks.map(task => task.subject || task.id).join('、')}`))
      details.append(body)
      root.append(details)
    }
    if (outline.attachments?.length) root.append(wsNode('p', `必要附件：${outline.attachments.join('、')}`))
  } else root.append(wsNode('p', '研究大纲尚未形成。计划提出或团队发布大纲后会显示在这里。'))
  const documents = (state.documents ?? []).filter(doc => /^outline\.md$/i.test(doc.name))
  if (documents.length) {
    const doc = documents.at(-1)
    root.append(workspaceActions(wsButton('阅读已发布大纲', () => void openWorkspaceDocument(doc))))
  }
  for (const task of state.team?.tasks ?? []) {
    if (!task.humanChoice || !/outline|大纲|viewpoints\.md/i.test(`${task.humanChoice.artifact} ${task.subject}`)) continue
    renderWorkspaceChoice(root, task)
  }
}

function renderWorkspaceChoice(root, task) {
  const choice = task.humanChoice
  const card = wsNode('section', undefined, 'workspaceCard')
  card.dataset.gateTask = task.id
  card.append(wsNode('h4', task.subject || '待确认事项'))
  if (choice.receipt) {
    card.append(wsNode('p', '已确认'), wsNode('small', `确认时间：${new Date(choice.receipt.approvedAt).toLocaleString('zh-CN')}`))
    root.append(card)
    return
  }
  if (task.status !== 'pending') {
    card.append(wsNode('p', `当前状态：${workspaceStatusLabel(task.status)}`))
    root.append(card)
    return
  }
  if (!choice.sha256 || choice.blockedReason) {
    card.append(wsNode('p', '确认材料暂不可读，请稍后刷新。'))
    root.append(card)
    return
  }
  if (choice.content) {
    const source = wsNode('details')
    source.append(wsNode('summary', '阅读待确认原稿'), manuscript(choice.content))
    card.append(source)
  }
  const options = wsNode('div', undefined, 'workspaceTaskChoices')
  const group = `choice-${task.id}`
  for (const option of choice.options ?? []) {
    const label = wsNode('label')
    const input = wsNode('input')
    input.type = choice.multiple ? 'checkbox' : 'radio'
    input.name = group
    input.value = option
    label.append(input, wsNode('span', option))
    options.append(label)
  }
  card.append(options)
  card.append(workspaceActions(wsButton('确认选择', () => {
    const selected = [...options.querySelectorAll('input:checked')].map(input => input.value)
    if (!selected.length) { setWorkspaceStatus('先选择一个选项。', 'error'); return }
    void runWorkspaceAction({ action: 'choose', taskId: task.id, expectedSha256: choice.sha256, choices: selected }, '选择已记录，团队将继续执行。')
  }, true)))
  root.append(card)
}

function workspacePortrait(state, member) {
  const expert = state.presentation?.experts?.[member.id] ?? state.presentation?.experts?.[member.name]
    ?? state.presentation?.experts?.[member.expertId]
  const id = typeof expert?.portrait === 'string' && expert.portrait.startsWith('asset:') ? expert.portrait.slice(6) : ''
  return /^[a-z0-9-]+$/i.test(id) ? `/assets/portraits/${id}-avatar.webp` : '/assets/coordinator-avatar.webp'
}

function workspacePortraitFigure(state, member) {
  const avatar = workspacePortrait(state, member)
  return avatar.startsWith('/assets/portraits/') ? avatar.replace('-avatar.webp', '.webp') : '/assets/coordinator.webp'
}

function workspaceMemberStatus(team, member) {
  const owned = (team?.tasks ?? []).filter(task => task.assignee === member.name || task.assignee === member.id)
  if (team?.halted) return { key: 'blocked', label: '已暂停', task: owned.find(task => task.status !== 'completed') }
  const working = owned.find(task => ['claimed', 'in_progress', 'running', 'active', 'reviewing', 'repairing'].includes(task.status))
  if (working) return { key: 'working', label: '工作中', task: working }
  const blocked = owned.find(task => ['blocked', 'stopped', 'failed', 'escalated'].includes(task.status))
  if (blocked) return { key: 'blocked', label: '需要处理', task: blocked }
  const choice = owned.find(task => task.status === 'pending' && task.humanChoice && !task.humanChoice.receipt)
  if (choice) return { key: 'confirm', label: '待你确认', task: choice }
  if (owned.length && owned.every(task => task.status === 'completed')) return { key: 'done', label: '已完成', task: owned.at(-1) }
  return { key: 'waiting', label: owned.length ? '等待前置任务' : '待分工', task: owned.find(task => task.status !== 'completed') }
}

function renderWorkspaceExperts(state) {
  workspaceExperts.replaceChildren()
  const team = state.team
  const members = Array.isArray(team?.members) ? team.members : []
  const ranked = members.map(member => ({ member, status: workspaceMemberStatus(team, member) }))
    .sort((a, b) => ({ working: 0, confirm: 1, blocked: 2, waiting: 3, done: 4 }[a.status.key] ?? 5)
      - ({ working: 0, confirm: 1, blocked: 2, waiting: 3, done: 4 }[b.status.key] ?? 5))
  const shown = ranked.slice(0, 3)
  if (!shown.length) shown.push({ member: { id: 'captain', name: '智见小秘书' }, status: { key: 'waiting', label: '等待研究计划' } })
  for (const { member, status } of shown) {
    const button = wsNode('button', undefined, 'workspaceExpert')
    button.type = 'button'
    button.dataset.status = status.key
    button.disabled = !status.task
    const image = wsNode('img')
    image.src = workspacePortraitFigure(state, member)
    image.alt = ''
    image.onerror = () => { image.onerror = null; image.src = '/assets/coordinator.webp' }
    const label = state.presentation?.experts?.[member.id]?.label || state.presentation?.experts?.[member.name]?.label || member.name || '研究专家'
    button.append(image, wsNode('strong', label), wsNode('small', status.label))
    if (status.task) button.addEventListener('click', () => focusTeamTask(status.task.id))
    workspaceExperts.append(button)
  }
  document.getElementById('workspaceSceneStatus').textContent = team
    ? `${ranked.filter(item => item.status.key === 'working').length} 位工作中 · ${(team.tasks ?? []).filter(task => task.status === 'completed').length}/${team.tasks?.length ?? 0} 项完成`
    : '确认计划后，专家按分工协作'
}

function workspaceTaskSummary(description) {
  const clean = String(description || '').split(/Approved artifact flow:|\{\s*"(?:artifacts|outputs|reportBundle)"/i)[0]
    .replace(/\s+/g, ' ').trim()
  return clean.length > 115 ? `${clean.slice(0, 112).trimEnd()}…` : clean
}

function workspaceTaskDetail(state, task) {
  const box = wsNode('div', undefined, 'workspaceTaskDetail')
  const team = state.team
  const quality = (team.qualityRuns ?? []).find(run => run.taskId === task.id)
  box.append(wsNode('p', `负责人：${task.assignee || '待分配'} · 状态：${workspaceStatusLabel(task.status)}`))
  if (task.waitReason) box.append(wsNode('p', `阻塞或等待原因：${task.waitReason}`))
  if (quality) box.append(wsNode('p', `质量检查：${workspaceStatusLabel(quality.status)}${quality.reviewRounds ? ` · ${quality.reviewRounds} 轮评审` : ''}`))
  const source = task.description || ''
  if (source) {
    const details = workspaceDetails(`task-requirement:${team.id}:${task.id}`, '完整任务要求', false, 'workspaceTechnical')
    details.append(wsNode('pre', source))
    box.append(details)
  }
  return box
}

function workspaceTaskWaves(state, tasks) {
  const previews = new Map((state.plan?.preview?.tasks ?? []).map(task => [task.id, task]))
  const byId = new Map(tasks.map(task => [task.id, task]))
  const depths = new Map()
  const remaining = new Set(byId.keys())
  while (remaining.size) {
    const ready = tasks.filter(task => remaining.has(task.id) &&
      (task.dependencies ?? task.dependsOn ?? previews.get(task.id)?.dependsOn ?? []).every(id => !byId.has(id) || depths.has(id)))
    if (!ready.length) { for (const id of remaining) depths.set(id, 0); break }
    for (const task of ready) {
      const deps = task.dependencies ?? task.dependsOn ?? previews.get(task.id)?.dependsOn ?? []
      depths.set(task.id, Math.max(0, ...deps.filter(id => depths.has(id)).map(id => depths.get(id) + 1)))
      remaining.delete(task.id)
    }
  }
  const waves = new Map()
  for (const task of tasks) {
    const level = depths.get(task.id) ?? 0
    if (!waves.has(level)) waves.set(level, [])
    waves.get(level).push(task)
  }
  return [...waves].sort((a, b) => a[0] - b[0])
}

function workspaceRouteTone(team, task) {
  if (task.status === 'completed') return 'done'
  if (team.halted || ['blocked', 'stopped', 'failed', 'escalated'].includes(task.status)) return 'blocked'
  if (task.humanChoice && !task.humanChoice.receipt) return 'confirm'
  if (['claimed', 'in_progress', 'running', 'active', 'reviewing', 'repairing'].includes(task.status)) return 'working'
  return 'waiting'
}

function workspaceRouteCaption(team, task) {
  const tone = workspaceRouteTone(team, task)
  if (tone === 'done') return '这一棒，交付了'
  if (tone === 'confirm') return '等你定个方向'
  if (tone === 'blocked') return team.halted ? '暂时停笔' : '需要一起解题'
  if (tone === 'waiting') return '等待前置任务'
  if (/渲染|制图|设计|PDF/i.test(task.subject || '')) return '正在排版制图'
  if (/评审|审核|review/i.test(task.subject || '')) return '正在核查内容'
  if (/撰写|正文|报告|writer/i.test(task.subject || '')) return '正在撰写正文'
  return '正在研究材料'
}

function drawWorkspaceRoute(canvas, state, tasks) {
  if (!canvas.isConnected) return
  const svg = canvas.querySelector('svg')
  if (!svg) return
  const width = canvas.scrollWidth, height = canvas.scrollHeight
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('width', width)
  svg.setAttribute('height', height)
  svg.replaceChildren()
  canvas.querySelectorAll('.workspaceRouteCourier').forEach(item => item.remove())
  const preview = new Map((state.plan?.preview?.tasks ?? []).map(task => [task.id, task]))
  const byId = new Map(tasks.map(task => [task.id, task]))
  const nodes = new Map([...canvas.querySelectorAll('[data-route-task]')].map(node => [node.dataset.routeTask, node]))
  const bounds = canvas.getBoundingClientRect()
  for (const task of tasks) {
    const target = nodes.get(task.id)
    if (!target) continue
    const deps = task.dependencies ?? task.dependsOn ?? preview.get(task.id)?.dependsOn ?? []
    for (const id of deps) {
      const source = nodes.get(id)
      if (!source) continue
      const from = source.getBoundingClientRect(), to = target.getBoundingClientRect()
      const x1 = from.right - bounds.left, y1 = from.top - bounds.top + from.height / 2
      const x2 = to.left - bounds.left, y2 = to.top - bounds.top + to.height / 2
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      const bend = Math.max(22, (x2 - x1) / 2)
      const handoff = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2 - 5} ${y2}`
      path.setAttribute('d', `${handoff} l -5 -4 m 5 4 l -5 4`)
      path.dataset.from = id
      path.dataset.to = task.id
      path.dataset.active = String(teamFocusedTaskId === id || teamFocusedTaskId === task.id)
      svg.append(path)
      if (workspaceRouteTone(state.team, byId.get(id)) === 'done' && workspaceRouteTone(state.team, task) === 'working') {
        const courier = wsNode('span', undefined, 'workspaceRouteCourier')
        courier.style.offsetPath = `path('${handoff}')`
        courier.setAttribute('aria-hidden', 'true')
        canvas.append(courier)
      }
    }
  }
}

function focusTeamTask(id) {
  teamFocusedTaskId = id
  selectView('workspace')
  selectWorkspaceTab('team')
  if (!workspaceState?.team) return
  renderWorkspaceTeam(workspaceState)
  requestAnimationFrame(() => {
    const target = document.querySelector(`[data-focused-task="${CSS.escape(id)}"]`)
    target?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  })
}

function renderWorkspaceTeam(state) {
  workspaceRouteInitObserver?.disconnect()
  workspaceRouteInitObserver = undefined
  const root = workspacePanels.team
  const header = wsNode('div', undefined, 'workspaceTeamHeader')
  header.append(wsNode('h3', '团队进展'))
  root.replaceChildren(header)
  const team = state.team
  if (!team) { root.append(wsNode('p', '确认研究计划后，团队任务和执行进展会出现在这里。')); return }
  const tasks = Array.isArray(team.tasks) ? team.tasks : []
  const switcher = wsNode('div', undefined, 'workspaceTeamSwitch')
  for (const [view, label] of [['route', '人物路线'], ['list', '任务列表']]) {
    const button = wsButton(label, () => { teamView = view; renderWorkspaceTeam(state) })
    button.setAttribute('aria-pressed', String(teamView === view))
    switcher.append(button)
  }
  header.append(switcher)
  if (state.preview?.kind !== 'external-read-only') {
    const actions = team.halted
      ? workspaceActions(wsButton('恢复执行', () => void runWorkspaceAction({ action: 'resume' }, '团队已恢复执行。'), true))
      : workspaceActions(wsButton('暂停执行', () => void runWorkspaceAction({ action: 'halt' }, '团队已暂停。')))
    header.append(actions)
  }
  const list = wsNode('div', undefined, 'workspaceTaskList')
  const current = tasks.filter(task => task.status !== 'completed' && task.status !== 'pending')
  const confirm = tasks.filter(task => task.status === 'pending' && task.humanChoice && !task.humanChoice.receipt)
  const next = tasks.filter(task => task.status === 'pending' && !confirm.includes(task))
  const done = tasks.filter(task => task.status === 'completed')
  for (const [key, label, group] of [['current', '当前进行', current], ['confirm', '待确认', confirm], ['next', '接下来', next], ['done', '已完成', done]]) {
    if (!group.length) continue
    const section = workspaceDetails(`task-group:${team.id}:${key}`, `${label} · ${group.length}`, true, 'workspaceTaskGroup')
    for (const task of group) {
      const card = workspaceDetails(`task:${team.id}:${task.id}`, '', true, 'workspaceTaskRow')
      card.dataset.focusedTask = task.id
      const summary = card.querySelector('summary')
      summary.replaceChildren(wsNode('strong', task.subject || task.id), wsNode('small', `${task.assignee || '待分配'} · ${workspaceStatusLabel(task.status)}`))
      const brief = workspaceTaskSummary(task.description)
      if (brief) summary.append(wsNode('span', brief, 'workspaceTaskBrief'))
      const quality = (team.qualityRuns ?? []).find(run => run.taskId === task.id)
      if (task.waitReason || quality) summary.append(wsNode('span', `${task.waitReason ? `等待：${task.waitReason}` : ''}${quality ? `${task.waitReason ? ' · ' : ''}质量：${workspaceStatusLabel(quality.status)}` : ''}`, 'workspaceTaskSignal'))
      card.append(workspaceTaskDetail(state, task))
      section.append(card)
    }
    list.append(section)
  }
  list.hidden = teamView !== 'list'
  root.append(list)
  const route = wsNode('section', undefined, 'workspaceRoute')
  route.setAttribute('aria-label', '研究路线与任务依赖')
  const routeHead = wsNode('div', undefined, 'workspaceRouteHead')
  const routeIntro = wsNode('div')
  routeIntro.append(wsNode('span', '任务进展', 'eyebrow'), wsNode('h3', '研究路线'),
    wsNode('p', '专家在各自的书桌前接力研究。点选任务，看看谁在忙、下一棒交给谁。'))
  const resetRoute = wsButton('回到起点', () => { routeViewport.scrollTo({ left: 0, top: 0 }); selectRouteTask(undefined) })
  routeHead.append(routeIntro, resetRoute)
  route.append(routeHead)
  const legend = wsNode('div', undefined, 'workspaceRouteLegend')
  for (const [tone, label] of [['done', '已完成'], ['working', '执行中'], ['confirm', '待你确认'],
    ['blocked', '受阻'], ['waiting', '待开始']]) {
    const item = wsNode('span', label)
    item.dataset.tone = tone
    legend.append(item)
  }
  route.append(legend)
  const routeViewport = wsNode('div', undefined, 'workspaceRouteViewport')
  routeViewport.tabIndex = 0
  routeViewport.setAttribute('aria-label', '研究路线画布，可横向滚动查看后续任务')
  const routeCanvas = wsNode('div', undefined, 'workspaceRouteCanvas')
  routeCanvas.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
  const waves = workspaceTaskWaves(state, tasks)
  const maxWaveSize = Math.max(1, ...waves.map(([, group]) => group.length))
  const routeWidth = Math.max(1, waves.length) * 304 + 8
  const routeHeight = maxWaveSize * 230 + 48
  routeCanvas.style.width = `${routeWidth}px`
  routeCanvas.style.height = `${routeHeight}px`
  if (workspaceRouteView.teamId !== team.id) Object.assign(workspaceRouteView,
    { teamId: team.id, zoom: 1, fit: false, left: 0, top: 0, mobileOverview: false })
  for (const [level, group] of waves) {
    const wave = wsNode('div', undefined, 'workspaceRouteWave')
    wave.style.paddingTop = `${44 + (maxWaveSize - group.length) * 115}px`
    wave.append(wsNode('small', `步骤 ${String(level + 1).padStart(2, '0')}`, 'workspaceRouteStage'))
    for (const task of group) {
      const member = (team.members ?? []).find(item => item.name === task.assignee || item.id === task.assignee)
      const node = wsButton('', () => selectRouteTask(teamFocusedTaskId === task.id ? undefined : task.id))
      node.className = 'workspaceRouteNode'
      const tone = workspaceRouteTone(team, task)
      node.dataset.tone = tone
      node.dataset.routeTask = task.id
      node.setAttribute('aria-pressed', String(task.id === teamFocusedTaskId))
      node.setAttribute('aria-label', `${task.subject || task.id} · ${task.assignee || '待分配'} · ${workspaceStatusLabel(task.status)}`)
      const scene = wsNode('span', undefined, 'workspaceRouteScene')
      scene.setAttribute('aria-hidden', 'true')
      const actor = wsNode('span', undefined, 'workspaceRouteActor')
      const image = wsNode('img', undefined, 'workspaceRoutePerson')
      image.src = member ? workspacePortraitFigure(state, member) : '/assets/coordinator.webp'
      image.alt = ''
      image.onerror = () => { image.onerror = null; image.src = '/assets/coordinator.webp' }
      actor.append(image)
      const papers = wsNode('span', undefined, 'workspaceRoutePapers')
      for (let index = 0; index < 3; index++) papers.append(wsNode('i'))
      const gesture = wsNode('span', tone === 'working' ? '' : { done: '✓', confirm: '?', blocked: '!', waiting: '···' }[tone], 'workspaceRouteGesture')
      if (tone === 'working') for (let index = 0; index < 3; index++) gesture.append(wsNode('i'))
      scene.append(wsNode('span', undefined, 'workspaceRouteShadow'), actor, wsNode('span', undefined, 'workspaceRouteDesk'),
        papers, wsNode('span', undefined, 'workspaceRoutePencil'), gesture,
        wsNode('span', workspaceRouteCaption(team, task), 'workspaceRouteCaption'))
      node.append(wsNode('span', `${task.id} · ${workspaceStatusLabel(task.status)}`, 'workspaceRouteMeta'), scene,
        wsNode('strong', task.subject || task.id), wsNode('small', task.assignee || '待分配'))
      wave.append(node)
    }
    routeCanvas.append(wave)
  }
  const routeFrame = wsNode('div', undefined, 'workspaceRouteFrame')
  routeFrame.style.width = `${routeWidth}px`
  routeFrame.style.height = `${routeHeight}px`
  routeFrame.append(routeCanvas)
  routeViewport.append(routeFrame)
  const toolbar = wsNode('div', undefined, 'workspaceRouteToolbar')
  toolbar.setAttribute('aria-label', '研究路线缩放与导航')
  const zoomOut = wsButton('−', () => applyRouteZoom(workspaceRouteView.zoom / 1.3))
  zoomOut.setAttribute('aria-label', '缩小研究路线')
  const zoomLabel = wsNode('output', '100%', 'workspaceRouteZoomLabel')
  zoomLabel.setAttribute('aria-label', '缩放比例')
  const zoomIn = wsButton('＋', () => applyRouteZoom(workspaceRouteView.zoom * 1.3))
  zoomIn.setAttribute('aria-label', '放大研究路线')
  const fit = wsButton('全图', fitRoute)
  fit.setAttribute('aria-pressed', String(workspaceRouteView.fit))
  function fitRoute() {
    applyRouteZoom(Math.min(1, (routeViewport.clientWidth - 4) / routeWidth,
      (window.innerWidth < 621 ? 360 : 540) / routeHeight), { x: 0, y: 0 })
    workspaceRouteView.fit = true
    fit.setAttribute('aria-pressed', 'true')
    routeViewport.scrollTo(0, 0)
  }
  const actual = wsButton('原大小', () => applyRouteZoom(1))
  const currentButton = wsButton('当前任务', () => goToRouteTask(tasks.find(task => task.status !== 'completed')?.id || tasks.at(-1)?.id))
  const picker = wsNode('select', undefined, 'workspaceRoutePicker')
  picker.setAttribute('aria-label', '跳转到研究任务')
  const placeholder = wsNode('option', '选择任务，放大查看')
  placeholder.value = ''
  picker.append(placeholder)
  for (const task of tasks) {
    const option = wsNode('option', `${workspaceStatusLabel(task.status)} · ${task.subject || task.id}`)
    option.value = task.id
    picker.append(option)
  }
  picker.addEventListener('change', () => goToRouteTask(picker.value))
  const previous = wsButton('上一项', () => stepRoute(-1))
  const nextButton = wsButton('下一项', () => stepRoute(1))
  toolbar.append(zoomOut, zoomLabel, zoomIn, fit, actual, currentButton, picker, previous, nextButton)
  route.append(toolbar, routeViewport)
  const previewTasks = new Map((state.plan?.preview?.tasks ?? []).map(task => [task.id, task]))
  const dependencyCount = tasks.reduce((count, task) => count + (task.dependencies ?? task.dependsOn
    ?? previewTasks.get(task.id)?.dependsOn ?? []).length, 0)
  route.append(wsNode('p', `${tasks.length} 个任务 · ${dependencyCount} 条依赖 · 向右滚动查看后续步骤`, 'workspaceRouteHint'))
  const focus = wsNode('section', undefined, 'workspaceRouteFocus')
  focus.setAttribute('aria-live', 'polite')
  route.append(focus)
  function selectRouteTask(id) {
    teamFocusedTaskId = id
    picker.value = id || ''
    const task = tasks.find(item => item.id === id) || tasks.find(item => item.status !== 'completed') || tasks.at(-1)
    for (const node of routeCanvas.querySelectorAll('[data-route-task]')) node.setAttribute('aria-pressed', String(node.dataset.routeTask === id))
    for (const path of routeCanvas.querySelectorAll('svg path')) path.dataset.active = String(!!id && (path.dataset.from === id || path.dataset.to === id))
    if (!task) { focus.replaceChildren(); return }
    focus.dataset.focusedTask = task.id
    const deps = task.dependencies ?? task.dependsOn ?? previewTasks.get(task.id)?.dependsOn ?? []
    const taskNames = ids => ids.map(key => tasks.find(item => item.id === key)?.subject || key).join('、') || '无'
    const nextTasks = tasks.filter(item => (item.dependencies ?? item.dependsOn ?? previewTasks.get(item.id)?.dependsOn ?? []).includes(task.id))
    const detail = workspaceTaskDetail(state, task)
    detail.querySelector('p')?.remove()
    focus.replaceChildren(wsNode('span', workspaceStatusLabel(task.status), 'eyebrow'),
      wsNode('h4', task.subject || task.id),
      wsNode('p', `负责人：${task.assignee || '待分配'}`),
      wsNode('p', `前置任务：${taskNames(deps)}`),
      wsNode('p', `后续任务：${taskNames(nextTasks.map(item => item.id))}`), detail)
  }
  function applyRouteZoom(value, anchor = { x: routeViewport.clientWidth / 2, y: routeViewport.clientHeight / 2 }) {
    const old = workspaceRouteView.zoom
    const x = (routeViewport.scrollLeft + anchor.x) / old
    const y = (routeViewport.scrollTop + anchor.y) / old
    workspaceRouteView.zoom = Math.max(.03, Math.min(1.8, value))
    workspaceRouteView.fit = false
    fit.setAttribute('aria-pressed', 'false')
    routeCanvas.style.transformOrigin = 'top left'
    routeCanvas.style.transform = `scale(${workspaceRouteView.zoom})`
    routeFrame.style.width = `${routeWidth * workspaceRouteView.zoom}px`
    routeFrame.style.height = `${routeHeight * workspaceRouteView.zoom}px`
    zoomLabel.textContent = `${Math.round(workspaceRouteView.zoom * 100)}%`
    routeViewport.scrollLeft = x * workspaceRouteView.zoom - anchor.x
    routeViewport.scrollTop = y * workspaceRouteView.zoom - anchor.y
  }
  function goToRouteTask(id) {
    const node = [...routeCanvas.querySelectorAll('[data-route-task]')].find(item => item.dataset.routeTask === id)
    if (!node) return
    selectRouteTask(id)
    applyRouteZoom(window.innerWidth < 621 ? Math.min(1, (routeViewport.clientWidth - 24) / 244) : 1)
    const x = node.parentElement.offsetLeft + node.offsetLeft + 122
    const y = node.parentElement.offsetTop + node.offsetTop + 101
    routeViewport.scrollLeft = x * workspaceRouteView.zoom - routeViewport.clientWidth / 2
    routeViewport.scrollTop = y * workspaceRouteView.zoom - routeViewport.clientHeight / 2
  }
  function stepRoute(offset) {
    const index = tasks.findIndex(task => task.id === teamFocusedTaskId)
    goToRouteTask(tasks[Math.max(0, Math.min(tasks.length - 1, index < 0 ? 0 : index + offset))]?.id)
  }
  selectRouteTask(teamFocusedTaskId)
  routeViewport.addEventListener('scroll', () => {
    workspaceRouteView.left = routeViewport.scrollLeft
    workspaceRouteView.top = routeViewport.scrollTop
  })
  route.hidden = teamView !== 'route'
  root.append(route)
  function initializeRouteView() {
    if (!route.isConnected || !routeViewport.clientWidth) return false
    drawWorkspaceRoute(routeCanvas, state, tasks)
    const saved = { zoom: workspaceRouteView.zoom, fit: workspaceRouteView.fit,
      left: workspaceRouteView.left, top: workspaceRouteView.top }
    const initialMobileOverview = window.innerWidth < 621 && !workspaceRouteView.mobileOverview
    workspaceRouteView.zoom = 1
    if (initialMobileOverview) fitRoute()
    else {
      applyRouteZoom(saved.zoom, { x: 0, y: 0 })
      workspaceRouteView.fit = saved.fit
      fit.setAttribute('aria-pressed', String(saved.fit))
      routeViewport.scrollLeft = saved.left
      routeViewport.scrollTop = saved.top
    }
    workspaceRouteView.mobileOverview ||= initialMobileOverview
    return true
  }
  if (teamView === 'route') requestAnimationFrame(() => {
    if (!route.isConnected || initializeRouteView()) return
    const observer = new ResizeObserver(() => {
      if (!route.isConnected || initializeRouteView()) {
        observer.disconnect()
        if (workspaceRouteInitObserver === observer) workspaceRouteInitObserver = undefined
      }
    })
    workspaceRouteInitObserver = observer
    observer.observe(routeViewport)
  })
}

function renderWorkspaceResults(state) {
  const root = workspacePanels.results
  const historical = state.preview?.source === 'original-session'
  root.replaceChildren(wsNode('h3', '研究成果'))
  if (state.residentialDemo?.kind === 'fuzhou-golden-demo') {
    root.append(wsNode('p', state.residentialDemo.status === 'succeeded'
      ? '福州脱敏黄金样例的四份原始 Word。机器检查与文件哈希已通过；视觉复核和专业签核仍待完成。'
      : '四份 Word 尚未核验完成；完成后会在这里显示下载入口。'))
    const names = { price_full: '价格完整版', price_external: '价格外发版',
      rent_full: '租金完整版', rent_external: '租金外发版' }
    for (const file of state.residentialDemo.files) {
      const row = wsNode('div', undefined, 'workspaceFileRow')
      const label = wsNode('div')
      label.append(wsNode('strong', names[file.role] || file.role),
        wsNode('small', `${file.name} · ${Math.ceil(file.sizeBytes / 1024)} KB`))
      row.append(label, workspaceActions(wsButton('下载 Word', () => location.assign(file.href), true)))
      root.append(row)
    }
  }
  const documents = Array.isArray(state.documents) ? state.documents : []
  const conversationDocuments = documents.filter(item => item.source === 'conversation')
  for (const task of state.team?.tasks ?? []) if (task.humanChoice && workspaceChoiceTab(task) === 'results') renderWorkspaceChoice(root, task)
  if (!documents.length) {
    if (state.residentialDemo?.kind === 'fuzhou-golden-demo') return
    root.append(wsNode('p', state.delivery?.ready === false && state.plan?.status === 'staged'
      ? '这份计划尚未具备正式交付声明，请回到“研究计划”修订后再启动。'
      : '成果将随团队任务生成，完成质量检查后可在这里预览和下载。'))
    return
  }
  const formalGroups = workspaceFormalGroups(documents)
  if (formalGroups.length) {
    root.append(wsNode('h4', historical ? '原始成果' : '正式交付'))
    for (const files of formalGroups) {
      const card = wsNode('section', undefined, 'workspaceFormalReport')
      card.append(wsNode('span', historical ? '原始页面 · 只读' : '✓ 正式报告已交付', 'workspaceDeliveryTag'),
        wsNode('h4', files[0].resultLabel || '研究报告'))
      if (files[0].createdAt) card.append(wsNode('small', `发布于 ${new Date(files[0].createdAt).toLocaleString('zh-CN')}`))
      const primary = files.find(doc => /\.pdf$/i.test(doc.name)) || files[0]
      const actions = workspaceActions(wsButton(historical ? '阅读原始报告'
        : /\.pdf$/i.test(primary.name) ? '阅读 PDF 报告' : `阅读 ${primary.name}`,
      () => void openWorkspaceDocument(primary), true))
      card.append(actions)
      const formats = workspaceDetails(`report-formats:${files[0].resultKey || 'report'}`, '其他格式与下载', false, 'workspaceReportFormats')
      for (const doc of files) {
        const row = wsNode('div', undefined, 'workspaceFileRow')
        row.append(wsNode('span', doc.name), workspaceActions(wsButton('预览', () => void openWorkspaceDocument(doc)),
          wsButton('下载', () => void downloadWorkspaceDocument(doc))))
        formats.append(row)
      }
      card.append(formats)
      root.append(card)
    }
  } else if (!conversationDocuments.length) root.append(wsNode('p', '正式报告尚未通过全部任务与质量检查；下方可查看已发布的过程材料。'))
  if (conversationDocuments.length) {
    root.append(wsNode('h4', '会话产出'))
    const groups = new Map()
    for (const doc of conversationDocuments) {
      if (!groups.has(doc.resultKey)) groups.set(doc.resultKey, [])
      groups.get(doc.resultKey).push(doc)
    }
    for (const files of groups.values()) {
      files.sort((a, b) => Number(/\.pdf$/i.test(b.name)) - Number(/\.pdf$/i.test(a.name)))
      const card = wsNode('section', undefined, 'workspaceFormalReport')
      card.append(wsNode('span', '会话生成 · 待正式复核', 'workspaceDeliveryTag'),
        wsNode('h4', files[0].resultLabel || '会话报告'))
      if (files[0].createdAt) card.append(wsNode('small', `归档于 ${new Date(files[0].createdAt).toLocaleString('zh-CN')}`))
      card.append(workspaceActions(wsButton(/\.pdf$/i.test(files[0].name) ? '阅读 PDF 报告' : `阅读 ${files[0].name}`,
        () => void openWorkspaceDocument(files[0]), true)))
      const formats = workspaceDetails(`conversation-report:${files[0].resultKey}`, '其他格式与下载', false, 'workspaceReportFormats')
      for (const doc of files) {
        const row = wsNode('div', undefined, 'workspaceFileRow')
        row.append(wsNode('span', doc.name), workspaceActions(wsButton('预览', () => void openWorkspaceDocument(doc)),
          wsButton('下载', () => void downloadWorkspaceDocument(doc))))
        formats.append(row)
      }
      card.append(formats)
      root.append(card)
    }
  }
  const team = state.team
  const latest = new Map()
  const formalIds = new Set(formalGroups.flat().map(doc => `${doc.taskId}:${doc.id}`))
  const formalNames = new Set(formalGroups.flat().map(doc => String(doc.name).toLowerCase()))
  for (const doc of documents.filter(item => !item.formal && item.source !== 'conversation')) {
    if (formalIds.has(`${doc.taskId}:${doc.id}`) || formalNames.has(String(doc.name).toLowerCase())) continue
    if (!doc.draft && !['manuscript', 'evidence', 'outline', 'key'].includes(doc.resultKind)
      && !team?.tasks?.some(task => task.id === doc.taskId && task.status === 'completed')) continue
    const key = doc.resultKey || `${doc.taskId}:${doc.name}`
    if (!latest.has(key) || (doc.createdAt ?? 0) > (latest.get(key).createdAt ?? 0)) latest.set(key, doc)
  }
  if (latest.size) {
    const archive = workspaceDetails(`process-archive:${team?.id || 'none'}`, `过程档案 · ${latest.size} 份`, false, 'workspaceArchive')
    archive.append(wsNode('p', '保留每类当前稿件和必要记录；正式报告已在上方集中展示。'))
    for (const doc of [...latest.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))) {
      const row = wsNode('div', undefined, 'workspaceFileRow')
      const source = team?.tasks?.find(task => task.id === doc.taskId)?.subject
      const copy = wsNode('div')
      copy.append(wsNode('strong', doc.resultLabel || doc.name), wsNode('small', `${doc.draft ? '过程稿' : '研究档案'} · ${doc.name}${source ? ` · ${source}` : ''}`))
      row.append(copy, workspaceActions(wsButton('预览', () => void openWorkspaceDocument(doc)),
        wsButton('下载', () => void downloadWorkspaceDocument(doc))))
      archive.append(row)
    }
    root.append(archive)
  }
}

async function fetchWorkspaceDocument(doc, sessionId) {
  const response = await apiFetch(`/api/sessions/${sessionId}/workspace/documents/${encodeURIComponent(doc.taskId)}/${encodeURIComponent(doc.id)}`,
    { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error('document unavailable')
  const { document: item } = await response.json()
  if (!item || typeof item.content !== 'string' || typeof item.name !== 'string') throw new Error('invalid document')
  return item
}

async function downloadWorkspaceDocument(doc) {
  if (!currentSessionId) return
  const sessionId = currentSessionId, epoch = workspaceEpoch
  try {
    const item = await fetchWorkspaceDocument(doc, sessionId)
    if (sessionId !== currentSessionId || epoch !== workspaceEpoch) return
    const bytes = item.encoding === 'base64' ? Uint8Array.from(atob(item.content), char => char.charCodeAt(0)) : item.content
    const url = URL.createObjectURL(new Blob([bytes], { type: item.mediaType || 'application/octet-stream' }))
    const link = wsNode('a')
    link.href = url
    link.download = item.name
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch { if (sessionId === currentSessionId && epoch === workspaceEpoch) setWorkspaceStatus('下载暂时失败，请重试。', 'error') }
}

async function openWorkspaceDocument(doc) {
  if (!currentSessionId) return
  const sessionId = currentSessionId, epoch = workspaceEpoch
  const request = ++workspaceDocumentRequest
  document.getElementById('workspaceDocumentTitle').textContent = doc.name
  const body = document.getElementById('workspaceDocumentBody')
  body.replaceChildren(wsNode('p', '正在读取档案…'))
  const download = document.getElementById('workspaceDocumentDownload')
  download.hidden = true
  if (!workspaceDocumentDialog.open) workspaceDocumentDialog.showModal()
  try {
    const item = await fetchWorkspaceDocument(doc, sessionId)
    if (sessionId !== currentSessionId || epoch !== workspaceEpoch || !workspaceDocumentDialog.open || request !== workspaceDocumentRequest) return
    const bytes = item.encoding === 'base64' ? Uint8Array.from(atob(item.content), char => char.charCodeAt(0)) : item.content
    if (workspaceDocumentUrl) URL.revokeObjectURL(workspaceDocumentUrl)
    workspaceDocumentUrl = URL.createObjectURL(new Blob([bytes], { type: item.mediaType || 'application/octet-stream' }))
    body.replaceChildren()
    if (item.mediaType === 'text/html' || item.mediaType === 'application/pdf') {
      const frame = wsNode('iframe')
      frame.title = item.name
      if (item.mediaType === 'text/html') {
        const reportScripts = !shareMode && workspaceState?.preview?.source === 'original-session'
          && workspaceState.preview.reportScripts === true && doc.id === 'source-html'
        frame.setAttribute('sandbox', reportScripts ? 'allow-downloads allow-scripts' : 'allow-downloads')
        frame.src = shareMode ? workspaceDocumentUrl
          : `/api/sessions/${sessionId}/workspace/documents/${encodeURIComponent(doc.taskId)}/${encodeURIComponent(doc.id)}/preview`
      } else frame.src = workspaceDocumentUrl
      body.append(frame)
    } else if (item.mediaType?.startsWith('image/')) {
      const image = wsNode('img')
      image.src = workspaceDocumentUrl
      image.alt = item.name
      body.append(image)
    } else if (item.mediaType === 'text/markdown' || /\.md$/i.test(item.name)) {
      body.append(manuscript(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)))
    } else body.append(wsNode('pre', typeof bytes === 'string' ? bytes : '二进制文件，请下载查看。'))
    download.href = workspaceDocumentUrl
    download.download = item.name
    download.hidden = false
  } catch {
    if (workspaceDocumentDialog.open && sessionId === currentSessionId && epoch === workspaceEpoch) body.replaceChildren(wsNode('p', '档案读取失败，请稍后重试。'))
  }
}

document.getElementById('workspaceDocumentClose').addEventListener('click', () => workspaceDocumentDialog.close())
workspaceDocumentDialog.addEventListener('close', () => {
  workspaceDocumentRequest++
  if (workspaceDocumentUrl) URL.revokeObjectURL(workspaceDocumentUrl)
  workspaceDocumentUrl = undefined
  document.getElementById('workspaceDocumentBody').replaceChildren()
  document.getElementById('workspaceDocumentDownload').hidden = true
})

document.getElementById('workspacePrimary').addEventListener('click', () => workspacePrimaryAction())
for (const button of document.querySelectorAll('[data-workspace-tab]')) {
  button.addEventListener('click', () => selectWorkspaceTab(button.dataset.workspaceTab))
}

for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => selectView(button.dataset.tab, { scrollLatest: button.dataset.tab === 'conversation' }))
}
menuButton.addEventListener('click', () => {
  if (isCompact()) {
    const open = !sidebar.classList.contains('open')
    sidebar.classList.toggle('open', open)
    scrim.hidden = !open
    menuButton.setAttribute('aria-expanded', String(open))
  } else {
    const collapsed = previewView.classList.toggle('navCollapsed')
    menuButton.setAttribute('aria-expanded', String(!collapsed))
  }
})
document.getElementById('closeSidebar').addEventListener('click', closeSidebar)
scrim.addEventListener('click', closeSidebar)
window.addEventListener('keydown', event => { if (event.key === 'Escape') closeSidebar() })
developerLogin.addEventListener('click', () => { location.assign('/api/auth/start') })
function csrfToken() {
  return document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('__Host-zhijian-csrf='))?.split('=')[1]
}
logoutButton.addEventListener('click', async () => {
  const csrf = csrfToken()
  if (!csrf) return
  const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrf } })
  if (response.ok) {
    await sessionCache.clear(currentAccountName)
    try { localStorage.removeItem(lastSessionKey(currentAccountName)) } catch { /* storage unavailable */ }
    location.assign('/login')
  }
})
const formatTokens = value => new Intl.NumberFormat('zh-CN').format(value)
async function loadUsage() {
  usageBody.textContent = '正在读取用量…'
  try {
    const response = await fetch('/api/usage', { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error('usage unavailable')
    const item = await response.json()
    const add = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; usageBody.append(node); return node }
    usageBody.replaceChildren()
    add('p', `当前账号：${item.accountName} · ${item.day}（UTC）`, 'usageLead')
    const grid = add('div', '', 'usageGrid')
    for (const [label, value] of [['今日已用', item.chargedTokens], ['每日额度', item.dailyQuota], ['今日剩余', item.remainingTokens]]) {
      const cell = document.createElement('div'); const name = document.createElement('small'); const count = document.createElement('strong')
      name.textContent = label; count.textContent = formatTokens(value); cell.append(name, count); grid.append(cell)
    }
    add('p', `今日 ${formatTokens(item.calls)} 次模型调用。统计按账号汇总，包含专家协作；正在运行或缺少上游用量的调用按预留值计入。单轮所需预留量超过剩余额度时仍会被拦截。每日 00:00 UTC 重置。`, 'usageNote')
    if (item.days.length) {
      add('h3', '最近 7 天')
      const list = add('div', '', 'usageDays')
      for (const day of item.days) {
        const row = document.createElement('div'); const date = document.createElement('span'); const total = document.createElement('strong')
        date.textContent = day.day; total.textContent = `${formatTokens(day.chargedTokens)} token · ${formatTokens(day.calls)} 次`
        row.append(date, total); list.append(row)
      }
    }
  } catch { usageBody.textContent = '暂时无法读取用量，请稍后刷新。' }
}
usageButton.addEventListener('click', () => { usageDialog.showModal(); if (isCompact()) closeSidebar(); void loadUsage() })
document.getElementById('usageClose').addEventListener('click', () => usageDialog.close())
document.getElementById('usageRefresh').addEventListener('click', () => { void loadUsage() })

function showMessage(text) { document.querySelector('.previewNotice').textContent = text }

const sessionRenameDialog = document.getElementById('sessionRenameDialog')
const sessionRenameForm = document.getElementById('sessionRenameForm')
const sessionRenameInput = document.getElementById('sessionRenameInput')
const sessionRenameError = document.getElementById('sessionRenameError')
const currentSessionActions = document.getElementById('currentSessionActions')
const studioSessionTitle = document.getElementById('studioSessionTitle')
const topbarRename = document.getElementById('topbarRename')
const topbarFavorite = document.getElementById('topbarFavorite')
const topbarShare = document.getElementById('topbarShare')
const allSessionsButton = document.getElementById('allSessionsButton')
const favoriteSessionsButton = document.getElementById('favoriteSessionsButton')
const runningSessionsButton = document.getElementById('runningSessionsButton')
const archivedSessionsButton = document.getElementById('archivedSessionsButton')
const sortSessionList = sessions => sessions.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)
  || Number(!!b.favorite) - Number(!!a.favorite) || b.createdAt - a.createdAt)

function currentSession() { return availableSessions.find(session => session.id === currentSessionId) }

function renderCurrentSessionActions() {
  const session = currentSession()
  currentSessionActions.hidden = !session || shareMode
  if (!session) return
  const favoriteLabel = session.favorite ? '取消收藏' : '收藏会话'
  topbarFavorite.setAttribute('aria-pressed', String(!!session.favorite))
  topbarFavorite.setAttribute('aria-label', favoriteLabel)
  topbarFavorite.title = favoriteLabel
  topbarFavorite.querySelector('span').textContent = session.favorite ? '已收藏' : '收藏'
}

function applyAutomaticSessionTitle(sessionId, title) {
  const session = availableSessions.find(item => item.id === sessionId)
  if (!session || session.title !== '新会话' || typeof title !== 'string' || title === '新会话') return
  session.title = title
  renderSessionList(sortSessionList([...availableSessions]))
  if (sessionId === currentSessionId) {
    studioSessionTitle.textContent = title
    studioSessionTitle.title = title
  }
}

async function updateSessionMetadata(session, changes) {
  const response = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'PATCH',
    credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() ?? '' },
    body: JSON.stringify(changes) })
  if (!response.ok) throw new Error('session_metadata_unavailable')
  const updated = (await response.json()).session
  if (!updated || updated.id !== session.id) throw new Error('session_metadata_invalid')
  const item = availableSessions.find(entry => entry.id === session.id)
  if (item) Object.assign(item, updated)
  renderSessionList(sortSessionList([...availableSessions]))
  renderCurrentSessionActions()
  if (currentSessionId === session.id && Object.hasOwn(changes, 'title')) {
    studioSessionTitle.textContent = updated.title
    studioSessionTitle.title = updated.title
  }
  return updated
}

async function toggleSessionArchive(session) {
  const archiving = !session.archived
  await updateSessionMetadata(session, { archived: archiving })
  if (archiving && session.id === currentSessionId) {
    const active = availableSessions.filter(item => !item.archived)
    const next = sessionListFilter === 'favorite' ? active.find(item => item.favorite) ?? active[0]
      : sessionListFilter === 'running' ? active.find(item => item.running) ?? active[0] : active[0]
    if (next) {
      if (sessionListFilter === 'favorite' && !next.favorite || sessionListFilter === 'running' && !next.running)
        sessionListFilter = 'all'
      renderSessionList(availableSessions)
      void selectSession(next, 'replace').catch(() => showMessage('会话已归档，请从左侧打开其他会话。'))
    }
    else { sessionListFilter = 'archive'; renderSessionList(availableSessions) }
  } else if (!archiving && session.id === currentSessionId && sessionListFilter === 'archive') {
    sessionListFilter = 'all'
    renderSessionList(availableSessions)
  }
}

function openSessionRename(session) {
  sessionRenameDialog.dataset.sessionId = session.id
  sessionRenameInput.value = session.title || ''
  sessionRenameError.textContent = ''
  sessionRenameDialog.showModal()
  sessionRenameInput.focus()
  sessionRenameInput.select()
}

document.getElementById('sessionRenameCancel').addEventListener('click', () => sessionRenameDialog.close())
sessionRenameForm.addEventListener('submit', async event => {
  event.preventDefault()
  const session = availableSessions.find(item => item.id === sessionRenameDialog.dataset.sessionId)
  const title = sessionRenameInput.value.trim()
  if (!session || !title) { sessionRenameError.textContent = '请输入会话标题。'; return }
  const saveButton = sessionRenameForm.querySelector('[type="submit"]')
  saveButton.disabled = true
  try {
    await updateSessionMetadata(session, { title })
    sessionRenameDialog.close()
  } catch { sessionRenameError.textContent = '保存失败，请重试。' }
  finally { saveButton.disabled = false }
})

topbarRename.addEventListener('click', () => {
  const session = currentSession()
  if (session) openSessionRename(session)
})
topbarFavorite.addEventListener('click', async () => {
  const session = currentSession()
  if (!session) return
  topbarFavorite.disabled = true
  try { await updateSessionMetadata(session, { favorite: !session.favorite }) }
  catch { showMessage('收藏状态保存失败，请重试。') }
  finally { topbarFavorite.disabled = false }
})
const sessionShareDialog = document.getElementById('sessionShareDialog')
const sessionShareForm = document.getElementById('sessionShareForm')
const sessionShareStatus = document.getElementById('sessionShareStatus')
const sessionShareCreated = document.getElementById('sessionShareCreated')
const sessionShareUrl = document.getElementById('sessionShareUrl')
const sessionShareList = document.getElementById('sessionShareList')
let newlyCreatedShareId

function renderShareLinks(shares) {
  sessionShareList.replaceChildren()
  if (!shares.length) { sessionShareList.textContent = '还没有分享链接。'; return }
  for (const share of shares) {
    const row = document.createElement('div')
    row.className = 'sessionShareItem'
    const text = document.createElement('span')
    const label = document.createElement('strong')
    label.textContent = share.permission === 'collaborate' ? '协作' : '只读'
    const detail = document.createElement('small')
    const expired = share.expiresAt <= Date.now()
    detail.textContent = `${share.revokedAt ? '已撤销' : expired ? '已到期' : '有效至'} · ${new Date(share.expiresAt).toLocaleString('zh-CN')}`
    text.append(label, detail)
    row.append(text)
    if (!share.revokedAt && !expired) {
      const revoke = document.createElement('button')
      revoke.type = 'button'
      revoke.textContent = '撤销'
      revoke.setAttribute('aria-label', `撤销${label.textContent}分享链接`)
      revoke.addEventListener('click', async () => {
        revoke.disabled = true
        try {
          const response = await apiFetch(`/api/shares/${share.id}`, { method: 'DELETE', credentials: 'same-origin',
            headers: { 'x-csrf-token': csrfToken() ?? '' } })
          if (!response.ok) throw new Error('revoke_failed')
          if (newlyCreatedShareId === share.id) { sessionShareCreated.hidden = true; sessionShareUrl.value = '' }
          sessionShareStatus.textContent = '分享链接已撤销。'
          await loadShareLinks()
        } catch { sessionShareStatus.textContent = '撤销失败，请重试。'; revoke.disabled = false }
      })
      row.append(revoke)
    }
    sessionShareList.append(row)
  }
}

async function loadShareLinks() {
  const id = sessionShareDialog.dataset.sessionId
  if (!id) return
  try {
    const response = await apiFetch(`/api/sessions/${id}/shares`, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error('shares_unavailable')
    if (id === sessionShareDialog.dataset.sessionId) renderShareLinks((await response.json()).shares)
  } catch { sessionShareList.textContent = '分享记录暂时无法读取。' }
}

topbarShare.addEventListener('click', () => {
  const session = currentSession()
  if (!session || shareMode) return
  sessionShareDialog.dataset.sessionId = session.id
  document.getElementById('sessionSharePermission').value = 'read'
  document.getElementById('sessionSharePermission').querySelector('[value="collaborate"]').disabled = !!session.preview
  document.getElementById('sessionShareDays').value = '7'
  sessionShareStatus.textContent = session.preview ? '只读预览仅支持只读分享。' : ''
  sessionShareCreated.hidden = true
  sessionShareUrl.value = ''
  newlyCreatedShareId = undefined
  sessionShareList.textContent = '正在读取分享记录…'
  sessionShareDialog.showModal()
  void loadShareLinks()
})
document.getElementById('sessionShareClose').addEventListener('click', () => sessionShareDialog.close())
sessionShareDialog.addEventListener('close', () => { sessionShareUrl.value = ''; newlyCreatedShareId = undefined })
sessionShareForm.addEventListener('submit', async event => {
  event.preventDefault()
  const id = sessionShareDialog.dataset.sessionId
  const permission = document.getElementById('sessionSharePermission').value
  const days = Number(document.getElementById('sessionShareDays').value)
  if (!id || !Number.isSafeInteger(days) || days < 1 || days > 365) {
    sessionShareStatus.textContent = '有效期请输入 1～365 天。'; return
  }
  const create = document.getElementById('sessionShareCreate')
  create.disabled = true
  try {
    const response = await apiFetch(`/api/sessions/${id}/shares`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() ?? '' },
      body: JSON.stringify({ permission, days }) })
    if (!response.ok) throw new Error('share_create_failed')
    const { share, token } = await response.json()
    const url = new URL('/share', location.origin)
    url.hash = new URLSearchParams({ token }).toString()
    sessionShareUrl.value = url.href
    newlyCreatedShareId = share.id
    sessionShareCreated.hidden = false
    sessionShareStatus.textContent = `链接已生成，${days} 天后到期。`
    await loadShareLinks()
  } catch { sessionShareStatus.textContent = '生成链接失败，请重试。' }
  finally { create.disabled = false }
})
document.getElementById('sessionShareCopy').addEventListener('click', async () => {
  if (!sessionShareUrl.value) return
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(sessionShareUrl.value)
    else { sessionShareUrl.select(); if (!document.execCommand('copy')) throw new Error('copy_failed') }
    sessionShareStatus.textContent = '链接已复制。'
  } catch { sessionShareUrl.select(); sessionShareStatus.textContent = '无法自动复制，请手动复制已选中的链接。' }
})

for (const [button, filter] of [[allSessionsButton, 'all'], [favoriteSessionsButton, 'favorite'], [runningSessionsButton, 'running']]) {
  button.addEventListener('click', () => {
    sessionListFilter = filter
    renderSessionList(availableSessions)
    if (filter === 'running') void refreshSessionActivity()
  })
}
archivedSessionsButton.addEventListener('click', () => {
  sessionListFilter = sessionListFilter === 'archive' ? 'all' : 'archive'
  renderSessionList(availableSessions)
})

async function refreshSessionActivity() {
  if (shareMode || !researchReady || !availableSessions.length || sessionActivityLoading) return
  sessionActivityLoading = true
  try {
    const response = await apiFetch('/api/sessions/activity', { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error('activity_unavailable')
    const data = await response.json()
    if (!Array.isArray(data.items)) throw new Error('invalid_activity')
    const byId = new Map(data.items.filter(item => typeof item.id === 'string' && typeof item.running === 'boolean')
      .map(item => [item.id, item.running]))
    let changed = !sessionActivityKnown || sessionActivityUnknown !== !!data.hasUnknown
    sessionActivityKnown = true
    sessionActivityUnknown = !!data.hasUnknown
    for (const session of availableSessions) {
      // A failed lookup must not preserve an old "running" marker indefinitely.
      const running = byId.get(session.id) === true
      if (session.running !== running) { session.running = running; changed = true }
    }
    if (changed) renderSessionList(availableSessions)
    return true
  } catch {
    sessionActivityKnown = true
    sessionActivityUnknown = true
    for (const session of availableSessions) session.running = false
    renderSessionList(availableSessions)
    return false
  } finally { sessionActivityLoading = false }
}

function sessionListLabel(session, current) {
  if (session.archived) return '已归档'
  if (session.previewKind === 'historical-session') return '原始会话 · 只读'
  if (session.preview) return '外部只读预览'
  if (session.running) return '执行中 · 实时更新'
  return current ? '当前会话' : '研究会话'
}

function sessionListDetail(session, current) {
  if (session.archived) return current ? '正在查看 · 可随时恢复' : '可随时恢复到会话列表'
  if (session.previewKind === 'historical-session') return '原团队进展与成果 · 只读'
  if (session.preview) return '已完成团队快照 · 原团队不受影响'
  if (session.running) return current ? '正在执行 · 当前查看' : '团队正在执行任务'
  return current ? '正在查看此会话' : '打开会话查看进度'
}

function sessionAction(session, kind, label, symbol, onClick) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'sessionAction'
  button.title = label
  button.setAttribute('aria-label', `${label}：${session.title || '未命名研究'}`)
  if (kind !== 'rename') button.setAttribute('aria-pressed', String(!!session[kind]))
  button.innerHTML = symbol
  button.addEventListener('click', async () => {
    if (kind === 'rename') { openSessionRename(session); return }
    button.disabled = true
    try { await onClick() }
    catch { showMessage('会话设置保存失败，请重试。'); button.disabled = false }
  })
  return button
}

function renderSessionList(sessions, saveCache = true) {
  availableSessions = sessions
  if (saveCache && !shareMode && currentAccountName && Array.isArray(sessions))
    void sessionCache.write(currentAccountName, 'sessions', '', sessions.slice(0, 200))
  const list = document.querySelector('.sessionList')
  list.replaceChildren()
  allSessionsButton.setAttribute('aria-pressed', String(sessionListFilter === 'all'))
  favoriteSessionsButton.setAttribute('aria-pressed', String(sessionListFilter === 'favorite'))
  runningSessionsButton.setAttribute('aria-pressed', String(sessionListFilter === 'running'))
  archivedSessionsButton.setAttribute('aria-pressed', String(sessionListFilter === 'archive'))
  const activeSessions = sessions.filter(session => !session.archived)
  document.getElementById('favoriteSessionCount').textContent = String(activeSessions.filter(session => session.favorite).length)
  document.getElementById('runningSessionCount').textContent = String(activeSessions.filter(session => session.running).length)
  document.getElementById('archivedSessionCount').textContent = String(sessions.length - activeSessions.length)
  if (!sessions.length) {
    showSessionListState('还没有研究会话', '新建会话后，会从第一问开始留存。')
    return
  }
  const visibleSessions = sessionListFilter === 'archive' ? sessions.filter(session => session.archived)
    : sessionListFilter === 'favorite' ? activeSessions.filter(session => session.favorite)
    : sessionListFilter === 'running' ? activeSessions.filter(session => session.running) : activeSessions
  if (!visibleSessions.length) {
    if (sessionListFilter === 'archive') showSessionListState('归档箱为空', '归档会话后，可在这里恢复。')
    else if (sessionListFilter === 'all') showSessionListState('没有未归档会话', '可从归档箱恢复，或新建一个会话。')
    else if (sessionListFilter === 'running') showSessionListState(
      !sessionActivityKnown ? '正在检查执行状态' : sessionActivityUnknown ? '执行状态未完全确认' : '当前没有执行中的会话',
      !sessionActivityKnown || sessionActivityUnknown ? '稍后会自动更新。' : '有任务开始执行后，会自动出现在这里。')
    else showSessionListState('还没有收藏的会话', '打开会话后，点右上角的收藏按钮即可加入这里。')
    return
  }
  for (const session of visibleSessions) {
    const row = document.createElement('div')
    row.className = 'sessionRow'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'sessionItem'
    button.dataset.sessionId = session.id
    button.dataset.running = String(!!session.running)
    const current = session.id === currentSessionId
    button.setAttribute('aria-current', String(current))
    const head = document.createElement('span')
    head.className = 'sessionItemHead'
    const dot = document.createElement('i')
    dot.setAttribute('aria-hidden', 'true')
    const label = document.createElement('span')
    label.className = 'sessionItemLabel'
    label.textContent = sessionListLabel(session, current)
    const created = new Date(session.createdAt)
    const date = document.createElement('time')
    if (Number.isFinite(created.getTime())) {
      date.dateTime = created.toISOString()
      date.textContent = created.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
    }
    head.append(dot, label, date)
    const title = document.createElement('strong')
    title.textContent = session.title || '未命名研究'
    title.title = title.textContent
    const detail = document.createElement('small')
    detail.className = 'sessionItemDetail'
    detail.textContent = sessionListDetail(session, current)
    button.append(head, title, detail)
    button.addEventListener('click', () => { void selectSession(session) })
    const actions = document.createElement('div')
    actions.className = 'sessionRowActions'
    actions.append(
      sessionAction(session, 'pinned', session.pinned ? '取消置顶' : '置顶', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h8l-1.5 5.5 2.5 2.5v2H7v-2l2.5-2.5L8 3ZM12 13v8"/></svg>', () => updateSessionMetadata(session, { pinned: !session.pinned })),
      sessionAction(session, 'favorite', session.favorite ? '取消收藏' : '收藏', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.5 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9L12 2.5Z"/></svg>', () => updateSessionMetadata(session, { favorite: !session.favorite })),
      sessionAction(session, 'archived', session.archived ? '恢复会话' : '归档会话', session.archived
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v4H4zM6 8v12h12V8M12 16V9m-3 3 3-3 3 3"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v4H4zM6 8v12h12V8M12 10v7m-3-3 3 3 3-3"/></svg>', () => toggleSessionArchive(session)),
      sessionAction(session, 'rename', '修改标题', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11-11a2 2 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4"/></svg>'),
    )
    row.append(button)
    if (!shareMode) row.append(actions)
    list.append(row)
  }
}

function showSessionListState(title, detail) {
  const empty = document.createElement('div')
  empty.className = 'sessionListEmpty'
  const symbol = document.createElement('span')
  symbol.setAttribute('aria-hidden', 'true')
  symbol.textContent = '◌'
  const heading = document.createElement('strong')
  heading.textContent = title
  const description = document.createElement('small')
  description.textContent = detail
  empty.append(symbol, heading, description)
  document.querySelector('.sessionList').replaceChildren(empty)
}

function showConversationLoading(title, detail) {
  const empty = emptyConversation.cloneNode(true)
  empty.classList.add('isLoading')
  const sketch = bootView.querySelector('.paintLoader')?.cloneNode(true)
  if (sketch) empty.prepend(sketch)
  empty.querySelector('h2').textContent = title
  empty.querySelector('p').textContent = detail
  conversationMessages.replaceChildren(empty)
}

function renderConversationEarlier() {
  if (!conversationHasEarlier || conversationOldestSeq === undefined) {
    conversationEarlier.remove()
    return
  }
  conversationEarlier.disabled = conversationEarlierLoading
  conversationEarlier.textContent = conversationEarlierLoading ? '正在读取更早消息…'
    : conversationEarlier.dataset.failed === 'true' ? '读取失败，点击重试 ↑' : '查看更早消息 ↑'
  conversationMessages.prepend(conversationEarlier)
}

function lastSessionKey(accountName) { return `zhijian-last-session-v1:${encodeURIComponent(accountName)}` }
function savedSessionId() {
  if (!currentAccountName || shareMode) return undefined
  try { return localStorage.getItem(lastSessionKey(currentAccountName)) || undefined } catch { return undefined }
}
function rememberSessionId(id) {
  if (!currentAccountName || shareMode) return
  try { localStorage.setItem(lastSessionKey(currentAccountName), id) } catch { /* storage unavailable */ }
}
function sessionIdFromUrl() { return new URLSearchParams(location.search).get('session') }
function syncSessionUrl(id, mode = 'push') {
  if (location.pathname !== '/app' || mode === 'none') return
  const url = new URL(location.href)
  if (id) url.searchParams.set('session', id)
  else url.searchParams.delete('session')
  if (url.href === location.href) return
  history[mode === 'replace' ? 'replaceState' : 'pushState'](null, '', url)
}
function pendingMessages(id = currentSessionId) { return pendingBySession.get(id) ?? [] }
function latestPending() { return pendingMessages().findLast(item => item.state !== 'replied' && item.state !== 'failed') }
function nearBottom() { return conversationMessages.scrollHeight - conversationMessages.scrollTop - conversationMessages.clientHeight < 90 }
function scrollToLatest() { conversationMessages.scrollTop = conversationMessages.scrollHeight; conversationLatest.hidden = true }
conversationLatest.addEventListener('click', scrollToLatest)
conversationMessages.addEventListener('scroll', () => { conversationLatest.hidden = nearBottom() })

async function copyMessage(text, button) {
  try {
    await navigator.clipboard.writeText(text)
    button.textContent = '已复制'
  } catch { button.textContent = '复制失败' }
  window.setTimeout(() => { button.textContent = '复制' }, 1800)
}

function createMessage(message, arriving = false) {
  const item = document.createElement('article')
  const serviceCards = message.role === 'assistant' && !message.interrupted && !message.truncated
    && Array.isArray(message.serviceCards) ? message.serviceCards.slice(0, 3) : []
  item.className = `conversationMessage ${message.role}${arriving ? ' conversationArriving' : ''}${serviceCards.length ? ' hasServiceCards' : ''}`
  if (Number.isSafeInteger(message.seq)) item.dataset.seq = String(message.seq)
  const avatar = document.createElement('span')
  avatar.className = 'conversationAvatar'
  avatar.setAttribute('aria-hidden', 'true')
  if (message.role === 'assistant') {
    const portrait = document.createElement('img')
    portrait.src = '/assets/coordinator-avatar.webp'
    portrait.alt = ''
    avatar.append(portrait)
  } else {
    const initial = document.createElement('span')
    initial.className = 'conversationAvatarInitial'
    initial.textContent = '我'
    avatar.append(initial)
  }
  const bubble = document.createElement('div')
  bubble.className = 'conversationBubble'
  const head = document.createElement('div')
  head.className = 'conversationMessageHead'
  const speaker = document.createElement('strong')
  speaker.textContent = message.role === 'user' ? '你' : '智见小秘书'
  head.append(speaker)
  if (message.time) {
    const time = document.createElement('time')
    const instant = new Date(message.time)
    if (!Number.isNaN(instant.getTime())) {
      time.dateTime = instant.toISOString()
      time.textContent = instant.toLocaleString('zh-CN')
      head.append(time)
    }
  }
  bubble.append(head)
  if (message.role === 'assistant' && message.text.length > 1200) {
    const long = document.createElement('details')
    long.className = 'conversationLong'
    const summary = document.createElement('summary')
    summary.textContent = `${message.text.replace(/\s+/g, ' ').slice(0, 220)}…`
    const content = manuscript(message.text)
    long.append(summary, content)
    bubble.append(long)
  } else {
    const content = message.role === 'assistant' ? manuscript(message.text) : wsNode('p', message.text)
    bubble.append(content)
  }
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'conversationCopy'
  copy.textContent = '复制'
  copy.setAttribute('aria-label', '复制这条消息')
  copy.addEventListener('click', () => { void copyMessage(message.text, copy) })
  bubble.append(copy)
  if (message.interrupted || message.truncated) {
    const note = document.createElement('small')
    note.className = 'conversationReceipt'
    note.textContent = message.interrupted ? '这条回复在中途停止。' : '内容过长，当前只展示部分文字。'
    bubble.append(note)
  }
  if (message.role === 'user') {
    const receipt = document.createElement('small')
    receipt.className = 'conversationReceipt'
    receipt.textContent = Number.isSafeInteger(message.seq) ? '已送达 · 等待回复' : '正在发送…'
    bubble.append(receipt)
  }
  if (serviceCards.length) {
    const stack = document.createElement('div')
    stack.className = 'conversationServiceStack'
    stack.append(bubble)
    const list = document.createElement('section')
    list.className = 'conversationServiceCards'
    list.setAttribute('aria-label', '与本次问题相关的服务资料')
    const label = document.createElement('small')
    label.className = 'conversationServiceLabel'
    label.textContent = '与本次问题相关的资料 · 合成演示'
    list.append(label)
    for (const card of serviceCards) {
      if (!card || typeof card.title !== 'string' || typeof card.summary !== 'string') continue
      const article = document.createElement('article')
      article.className = 'conversationServiceCard'
      const top = document.createElement('div')
      top.className = 'conversationServiceTop'
      const title = document.createElement('strong')
      title.textContent = card.title
      const type = document.createElement('span')
      type.textContent = card.kind === 'product' ? '产品资料' : '服务资料'
      top.append(title, type)
      const reason = document.createElement('p')
      reason.className = 'conversationServiceReason'
      reason.textContent = `为什么提供：${card.reason || '请先核实是否符合当前需求。'}`
      article.append(top, reason)
      const detail = document.createElement('details')
      const detailSummary = document.createElement('summary')
      detailSummary.textContent = '查看核验事项、替代选择与来源'
      detail.append(detailSummary)
      for (const [heading, value] of [['服务内容', card.summary], ['还要核实', card.checks], ['其他选择', card.alternative], ['使用边界', card.boundary]]) {
        if (typeof value !== 'string' || !value) continue
        const line = document.createElement('p')
        line.textContent = `${heading}：${value}`
        detail.append(line)
      }
      const provenance = document.createElement('small')
      provenance.textContent = `${card.provider || ''} · ${card.source || ''} · ${card.version || ''} · 有效期至 ${card.expiresAt || '待核实'}`
      detail.append(provenance)
      if (typeof card.href === 'string' && /^\/tenant-studio\/#(?:packs|products)$/.test(card.href)) {
        const link = document.createElement('a')
        link.href = card.href
        link.textContent = '查看演示资料目录'
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        detail.append(link)
      }
      article.append(detail)
      list.append(article)
    }
    stack.append(list)
    item.append(avatar, stack)
  } else item.append(avatar, bubble)
  return item
}

function setReceipt(node, state) {
  if (!node) return
  const receipt = node.querySelector('.conversationReceipt')
  if (!receipt) return
  node.dataset.state = state
  receipt.textContent = ({ sending: '正在发送…', accepted: '服务已接收 · 正在写入会话',
    recorded: '已送达 · 等待回复', replied: '智见小秘书已回复', uncertain: '尚未确认送达 · 可重试',
    quota_exceeded: '本轮未完成 · 模型额度不足，可在设置与用量查看', failed: '本轮未完成 · 可重试' })[state]
}

function updateComposeStatus() {
  let message = composeNotice
  let kind = composeNoticeKind
  if (!message) {
    const pending = latestPending()
    if (pending) {
      const states = {
        sending: '正在发送…', accepted: '消息已接收 · 正在写入会话',
        recorded: '已送达 · 等待回复', uncertain: '发送状态未确认 · 内容已保留，可重试',
      }
      message = states[pending.state] ?? ''
      kind = pending.state === 'uncertain' ? 'error' : 'progress'
    } else {
      const rows = [...conversationMessages.querySelectorAll('.conversationMessage[data-seq]')]
      const lastUser = rows.findLast(row => row.classList.contains('user'))
      const lastAssistant = rows.findLast(row => row.classList.contains('assistant'))
      if (lastUser) {
        const userSeq = Number(lastUser.dataset.seq)
        if (lastAssistant && Number(lastAssistant.dataset.seq) > userSeq) {
          message = '上一轮已回复'
          kind = 'success'
        } else {
          const failure = failuresBySession.get(currentSessionId)?.get(userSeq)
          message = failure === 'quota_exceeded' ? '上一轮未完成 · 模型额度不足，可在设置与用量查看'
            : failure === 'failed' ? '上一轮未完成 · 可重试' : '已送达 · 等待回复'
          kind = failure ? 'error' : 'progress'
        }
      }
    }
  }
  conversationSendStatus.textContent = message
  conversationSendStatus.dataset.kind = kind
}

function setComposeNotice(message, kind = 'info') {
  composeNotice = message
  composeNoticeKind = kind
  updateComposeStatus()
}

function renderActivity() {
  const pending = latestPending()
  conversationActivity.hidden = !pending
  if (!pending) return
  conversationActivity.dataset.phase = pending.state
  const copy = {
    sending: ['正在传递消息', '正在送往智见小秘书…'],
    accepted: ['消息已接收', '正在写入会话，稍后等待回复…'],
    recorded: ['等待智见小秘书回复', '消息已送达；回复出现后会自动更新。'],
    uncertain: ['尚未确认送达', '内容已保留，可重试；同一条消息不会重复提交。'],
  }[pending.state]
  document.getElementById('activityTitle').textContent = copy[0]
  document.getElementById('activityDetail').textContent = copy[1]
  document.getElementById('activityElapsed').textContent = `${Math.floor((Date.now() - pending.startedAt) / 1000)} 秒`
}

function updateReceipts() {
  const rows = [...conversationMessages.querySelectorAll('.conversationMessage[data-seq]')]
  const failures = failuresBySession.get(currentSessionId)
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].classList.contains('user')) continue
    if (rows.slice(i + 1).some(row => row.classList.contains('assistant'))) setReceipt(rows[i], 'replied')
    else setReceipt(rows[i], failures?.get(Number(rows[i].dataset.seq)) ?? 'recorded')
  }
}

function applyTurnFailures(events) {
  if (!Array.isArray(events) || !events.length) return
  const failures = failuresBySession.get(currentSessionId) ?? new Map()
  failuresBySession.set(currentSessionId, failures)
  const rows = [...conversationMessages.querySelectorAll('.conversationMessage[data-seq]')]
  for (const event of events) {
    if (!Number.isSafeInteger(event?.seq) || !['quota_exceeded', 'failed'].includes(event.kind)) continue
    const user = rows.findLast(row => row.classList.contains('user') && Number(row.dataset.seq) < event.seq)
    if (!user || rows.some(row => row.classList.contains('assistant')
      && Number(row.dataset.seq) > Number(user.dataset.seq) && Number(row.dataset.seq) < event.seq)) continue
    const userSeq = Number(user.dataset.seq)
    failures.set(userSeq, event.kind)
    for (const pending of pendingMessages()) if (pending.userSeq === userSeq) pending.state = 'failed'
  }
  updateReceipts()
  renderActivity()
}

function appendConversationMessage(message, live) {
  if (conversationMessages.querySelector(`.conversationMessage[data-seq="${message.seq}"]`)) return
  const follow = live && nearBottom()
  conversationMessages.querySelector('.conversationEmpty')?.remove()
  if (message.role === 'user') {
    const pending = pendingMessages().find(item => item.userSeq === undefined && message.seq > item.afterSeq && item.text === message.text)
    if (pending) {
      pending.userSeq = message.seq
      pending.state = 'recorded'
      if (pending.node) pending.node.dataset.seq = String(message.seq)
      const head = pending.node?.querySelector('.conversationMessageHead')
      if (message.time && head && !head.querySelector('time')) {
        const time = document.createElement('time')
        const instant = new Date(message.time)
        if (!Number.isNaN(instant.getTime())) { time.dateTime = instant.toISOString(); time.textContent = instant.toLocaleString('zh-CN'); head.append(time) }
      }
      setReceipt(pending.node, 'recorded')
      if (composeNotice.includes('无法确认是否发送成功')) setComposeNotice('')
      if (conversationInput.value.trim() === pending.text) {
        conversationInput.value = ''
        resizeConversationInput()
        draftsBySession.set(currentSessionId, '')
      }
      renderActivity()
      if (pending.node) return
    }
  }
  const node = createMessage(message, live)
  conversationMessages.append(node)
  if (live && !follow) conversationLatest.hidden = false
  if (message.role === 'assistant') {
    for (const pending of pendingMessages()) {
      if (pending.userSeq !== undefined && message.seq > pending.userSeq && pending.state !== 'replied') pending.state = 'replied'
    }
    setComposeNotice('')
    renderActivity()
  }
  updateReceipts()
  if (follow) scrollToLatest()
}

async function loadConversation(id = currentSessionId, epoch = conversationEpoch) {
  if (!id || conversationLoading || id !== currentSessionId || epoch !== conversationEpoch) return
  conversationLoading = true
  const initialLoad = conversationCursor === -1
  try {
    for (let pageCount = 0; pageCount < 20; pageCount++) {
      const after = conversationCursor
      const response = await apiFetch(`/api/sessions/${id}/messages?${initialLoad ? 'latest=1' : `after=${after}`}`, { credentials: 'same-origin', cache: 'no-store', signal: sessionReadController.signal })
      if (!response.ok) throw new Error('read failed')
      const page = await response.json()
      if (id !== currentSessionId || epoch !== conversationEpoch) return
      if (!Array.isArray(page.messages) || !Number.isSafeInteger(page.nextCursor) || page.nextCursor < after) throw new Error('invalid conversation page')
      for (const message of page.messages)
        if (!Number.isSafeInteger(message?.seq) || message.seq < 0 || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string')
          throw new Error('invalid conversation message')
      applyAutomaticSessionTitle(id, page.sessionTitle)
      if (initialLoad && after === -1) {
        // Replace the provisional cache only after an authoritative page arrives.
        conversationMessages.replaceChildren()
        cachedMessagesBySession.delete(id)
      }
      for (const message of page.messages) appendConversationMessage(message, !initialLoad)
      if (initialLoad) {
        conversationOldestSeq = page.messages[0]?.seq
        conversationHasEarlier = page.hasEarlier === true
        renderConversationEarlier()
      }
      applyTurnFailures(page.turnFailures)
      conversationCursor = page.nextCursor
      cacheMessages(id, [...(cachedMessagesBySession.get(id) ?? []), ...page.messages]
        .filter((message, index, all) => all.findLastIndex(item => item.seq === message.seq) === index))
      updateReceipts()
      if (initialLoad || !page.hasMore || page.nextCursor === after) break
    }
    if (!conversationMessages.querySelector('.conversationMessage')) conversationMessages.replaceChildren(emptyConversation.cloneNode(true))
    else if (initialLoad) scrollToLatest()
    if (composeNotice === '读取对话暂时失败，稍后会自动重试。') setComposeNotice('')
    updateComposeStatus()
    return true
  } catch {
    if (id === currentSessionId && epoch === conversationEpoch) {
      setComposeNotice('读取对话暂时失败，稍后会自动重试。', 'error')
      if (initialLoad && !conversationMessages.querySelector('.conversationMessage'))
        showConversationLoading('对话暂时未载入', '正在自动重试，当前会话和草稿已保留。')
    }
    return false
  } finally { if (epoch === conversationEpoch) conversationLoading = false }
}

async function loadEarlierConversation() {
  const id = currentSessionId, epoch = conversationEpoch, before = conversationOldestSeq
  if (!id || !conversationHasEarlier || conversationEarlierLoading || before === undefined) return
  conversationEarlierLoading = true
  delete conversationEarlier.dataset.failed
  renderConversationEarlier()
  try {
    const response = await apiFetch(`/api/sessions/${id}/messages?latest=1&before=${before}`,
      { credentials: 'same-origin', cache: 'no-store', signal: sessionReadController.signal })
    if (!response.ok) throw new Error('read failed')
    const page = await response.json()
    if (id !== currentSessionId || epoch !== conversationEpoch) return
    if (!Array.isArray(page.messages) || page.messages.some(message => !Number.isSafeInteger(message?.seq)
      || message.seq < 0 || message.seq >= before || !['user', 'assistant'].includes(message.role)
      || typeof message.text !== 'string')) throw new Error('invalid earlier page')
    const anchor = conversationMessages.querySelector('.conversationMessage')
    const anchorTop = anchor?.getBoundingClientRect().top
    const fragment = document.createDocumentFragment()
    for (const message of page.messages) {
      if (!conversationMessages.querySelector(`.conversationMessage[data-seq="${message.seq}"]`))
        fragment.append(createMessage(message, false))
    }
    conversationMessages.insertBefore(fragment, conversationMessages.querySelector('.conversationMessage'))
    conversationOldestSeq = page.messages[0]?.seq ?? before
    conversationHasEarlier = page.hasEarlier === true && conversationOldestSeq < before
    updateReceipts()
    if (anchor && anchorTop !== undefined)
      conversationMessages.scrollTop += anchor.getBoundingClientRect().top - anchorTop
  } catch {
    if (id === currentSessionId && epoch === conversationEpoch) {
      conversationEarlier.dataset.failed = 'true'
    }
  } finally {
    if (id === currentSessionId && epoch === conversationEpoch) {
      conversationEarlierLoading = false
      renderConversationEarlier()
    }
  }
}
conversationEarlier.addEventListener('click', () => { void loadEarlierConversation() })

function showQuestion(question) {
  if (sharedReadOnly()) question = null
  activeQuestion = question
  questionCard.replaceChildren()
  questionCard.hidden = !question
  questionShortcut.hidden = !question
  renderActionCenter()
  if (workspaceState) renderWorkspace(workspaceState)
  if (!question) {
    conversationInput.disabled = !researchReady || previewActive || sharedReadOnly()
    sendMessageButton.disabled = !researchReady || previewActive || sharedReadOnly()
    return
  }
  conversationInput.disabled = true
  sendMessageButton.disabled = true
  const eyebrow = document.createElement('span')
  eyebrow.className = 'eyebrow'
  eyebrow.textContent = '智见小秘书想确认'
  questionCard.append(eyebrow)
  question.questions.forEach((item, index) => {
    const fieldset = document.createElement('fieldset')
    fieldset.dataset.questionId = item.id
    const legend = document.createElement('legend')
    legend.textContent = item.question
    fieldset.append(legend)
    if (item.detail) {
      const detail = document.createElement('p')
      detail.className = 'questionDetail'
      detail.textContent = item.detail
      fieldset.append(detail)
    }
    item.options.forEach(option => {
      const label = document.createElement('label')
      label.className = 'questionOption'
      const input = document.createElement('input')
      input.type = item.multiSelect ? 'checkbox' : 'radio'
      input.name = `question-${index}`
      input.value = option.label
      const title = document.createElement('span')
      title.textContent = option.label
      label.append(input, title)
      if (option.description) {
        const description = document.createElement('small')
        description.textContent = option.description
        label.append(description)
      }
      fieldset.append(label)
    })
    const customLabel = document.createElement('label')
    customLabel.textContent = '其他 / 补充：'
    const customInput = document.createElement('input')
    customInput.type = 'text'
    customInput.className = 'questionCustom'
    customInput.placeholder = '输入你的要求（可选）'
    customInput.maxLength = 2000
    customLabel.append(customInput)
    fieldset.append(customLabel)
    questionCard.append(fieldset)
  })
  const actions = document.createElement('div')
  actions.className = 'questionActions'
  const status = document.createElement('span')
  status.className = 'questionStatus'
  status.setAttribute('role', 'status')
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.textContent = '提交选择，继续对话'
  actions.append(status, submit)
  questionCard.append(actions)
}

questionShortcut.addEventListener('click', () => {
  actionCenter.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  questionCard.querySelector('input:not([disabled])')?.focus({ preventScroll: true })
})

async function loadQuestion(id = currentSessionId, epoch = conversationEpoch) {
  if (!id || !researchReady || sharedReadOnly() || questionLoading || id !== currentSessionId || epoch !== conversationEpoch || questionSubmitting) return
  questionLoading = true
  try {
    const response = await apiFetch(`/api/sessions/${id}/question`, { credentials: 'same-origin', cache: 'no-store', signal: sessionReadController.signal })
    if (!response.ok) throw new Error('question unavailable')
    const { question } = await response.json()
    if (id !== currentSessionId || epoch !== conversationEpoch) return
    if (question?.requestId !== activeQuestion?.requestId) showQuestion(question ?? null)
    return true
  } catch {
    if (id === currentSessionId && epoch === conversationEpoch && activeQuestion) questionCard.querySelector('.questionStatus').textContent = '暂时无法确认提问状态，稍后会自动重试。'
    return false
  } finally { if (epoch === conversationEpoch) questionLoading = false }
}

function showApproval(approval) {
  activeApproval = approval
  approvalCard.replaceChildren()
  approvalCard.hidden = !approval
  if (!approval) { renderActionCenter(); return }
  const title = wsNode('strong', '生成报告需要确认')
  const detail = wsNode('p', approval.reason || '是否允许本次生成四份 Word 报告？')
  const actions = wsNode('div', undefined, 'approvalCardActions')
  for (const [decision, label] of [['rejected', '拒绝'], ['allowed-once', '允许本次生成']]) {
    const button = wsButton(label, () => void answerApproval(decision), decision === 'rejected')
    button.dataset.decision = decision
    actions.append(button)
  }
  actions.append(wsNode('small', '', 'approvalStatus'))
  approvalCard.append(title, detail, actions)
  renderActionCenter()
}

async function loadApproval(id = currentSessionId, epoch = conversationEpoch) {
  if (!id || !researchReady || approvalLoading || approvalSubmitting || id !== currentSessionId || epoch !== conversationEpoch) return
  approvalLoading = true
  try {
    const response = await apiFetch(`/api/sessions/${id}/approval`, { credentials: 'same-origin', cache: 'no-store', signal: sessionReadController.signal })
    if (response.status === 404) { if (id === currentSessionId && epoch === conversationEpoch) showApproval(null); return true }
    if (!response.ok) throw new Error('unavailable')
    const { approval } = await response.json()
    if (id === currentSessionId && epoch === conversationEpoch && approval?.id !== activeApproval?.id) showApproval(approval ?? null)
    return true
  } catch {
    if (id === currentSessionId && epoch === conversationEpoch && activeApproval) approvalCard.querySelector('.approvalStatus').textContent = '暂时无法确认状态，稍后重试。'
    return false
  } finally { if (epoch === conversationEpoch) approvalLoading = false }
}

async function answerApproval(decision) {
  if (!activeApproval || !currentSessionId || approvalSubmitting || sharedReadOnly()) return
  const sessionId = currentSessionId, id = activeApproval.id
  approvalSubmitting = true
  approvalCard.querySelectorAll('button').forEach(button => { button.disabled = true })
  approvalCard.querySelector('.approvalStatus').textContent = '正在提交…'
  try {
    const response = await apiFetch(`/api/sessions/${sessionId}/approval`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() ?? '' },
      body: JSON.stringify({ id, decision }) })
    if (!response.ok || (await response.json()).accepted !== true) throw new Error('submit failed')
    if (sessionId === currentSessionId && activeApproval?.id === id) showApproval(null)
    setComposeNotice(decision === 'allowed-once' ? '已允许本次生成，正在继续。' : '已拒绝本次生成。', 'progress')
  } catch {
    if (sessionId === currentSessionId && activeApproval?.id === id) {
      approvalCard.querySelector('.approvalStatus').textContent = '提交失败，请重试。'
      approvalCard.querySelectorAll('button').forEach(button => { button.disabled = false })
    }
  } finally { approvalSubmitting = false }
}

questionCard.addEventListener('submit', async event => {
  event.preventDefault()
  if (!activeQuestion || !currentSessionId || questionSubmitting || sharedReadOnly()) return
  const sessionId = currentSessionId
  const requestId = activeQuestion.requestId
  const answers = activeQuestion.questions.map((item, index) => {
    const fieldset = questionCard.querySelectorAll('fieldset')[index]
    return { id: item.id,
      selected: [...fieldset.querySelectorAll('input:checked')].map(input => input.value),
      custom: fieldset.querySelector('.questionCustom').value.trim() }
  })
  const status = questionCard.querySelector('.questionStatus')
  if (!answers.some(answer => answer.selected.length || answer.custom)) {
    status.textContent = '请至少选择一项或填写补充内容。'
    return
  }
  questionSubmitting = true
  const submit = questionCard.querySelector('button[type=submit]')
  submit.disabled = true
  status.textContent = '正在提交…'
  try {
    const response = await apiFetch(`/api/sessions/${sessionId}/question`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() ?? '' },
      body: JSON.stringify({ requestId, answers }) })
    if (!response.ok || (await response.json()).accepted !== true) throw new Error(response.status === 409 ? 'stale' : 'failed')
    if (sessionId === currentSessionId && activeQuestion?.requestId === requestId) {
      showQuestion(null)
      setComposeNotice('选择已提交，智见小秘书正在继续回复。', 'progress')
      await loadConversation(sessionId)
    }
  } catch (error) {
    if (sessionId === currentSessionId && activeQuestion?.requestId === requestId) {
      status.textContent = error.message === 'stale' ? '这张提问卡已失效，正在更新。' : '提交失败，请重试。'
      if (error.message === 'stale') showQuestion(null)
      else submit.disabled = false
    }
  } finally { questionSubmitting = false }
})

function modelValue(selection) {
  return JSON.stringify([selection.provider, selection.model])
}

function closeModelPicker() {
  conversationModelMenu.hidden = true
  conversationModelTrigger.setAttribute('aria-expanded', 'false')
}

function renderModelPicker() {
  const selected = conversationModelSelect.selectedOptions[0]
  conversationModelName.textContent = selected?.dataset.name || selected?.textContent || '选择模型'
  conversationModelTrigger.setAttribute('aria-label', `当前会话模型：${conversationModelName.textContent}`)
  conversationModelTrigger.disabled = conversationModelSelect.disabled
  if (conversationModelTrigger.disabled) closeModelPicker()
  const items = [...conversationModelSelect.options].filter(option => option.value)
  const fragment = document.createDocumentFragment()
  for (const option of items) {
    const button = document.createElement('button')
    const name = option.dataset.name || option.textContent
    const provider = option.dataset.provider || ''
    button.type = 'button'
    button.className = 'modelPickerOption'
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', String(option.value === conversationModelSelect.value))
    button.setAttribute('aria-label', provider ? `${name}，${provider}` : name)
    button.dataset.value = option.value
    const copy = document.createElement('span')
    copy.className = 'modelPickerOptionCopy'
    const title = document.createElement('strong')
    title.textContent = name
    const source = document.createElement('small')
    source.textContent = provider || '当前会话'
    copy.append(title, source)
    const check = document.createElement('span')
    check.className = 'modelPickerCheck'
    check.setAttribute('aria-hidden', 'true')
    check.textContent = '✓'
    button.append(copy, check)
    fragment.append(button)
  }
  conversationModelOptions.replaceChildren(fragment)
}

function openModelPicker(focusSelected = false) {
  if (conversationModelTrigger.disabled) return
  conversationModelMenu.hidden = false
  conversationModelTrigger.setAttribute('aria-expanded', 'true')
  conversationModelMenu.style.left = '0px'
  const bounds = conversationModelMenu.getBoundingClientRect()
  const offset = Math.max(12 - bounds.left, Math.min(0, window.innerWidth - 12 - bounds.right))
  conversationModelMenu.style.left = `${offset}px`
  if (focusSelected) {
    const items = [...conversationModelOptions.querySelectorAll('.modelPickerOption')]
    ;(items.find(item => item.getAttribute('aria-selected') === 'true') || items[0])?.focus()
  }
}

conversationModelTrigger.addEventListener('click', () => {
  if (conversationModelMenu.hidden) openModelPicker()
  else closeModelPicker()
})
conversationModelTrigger.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeModelPicker()
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  openModelPicker(true)
})
conversationModelMenu.addEventListener('click', event => {
  const option = event.target.closest('.modelPickerOption')
  if (!option || !conversationModelMenu.contains(option)) return
  closeModelPicker()
  conversationModelTrigger.focus()
  if (option.dataset.value === conversationModelSelect.value) return
  conversationModelSelect.value = option.dataset.value
  conversationModelSelect.dispatchEvent(new Event('change'))
})
conversationModelMenu.addEventListener('keydown', event => {
  const items = [...conversationModelOptions.querySelectorAll('.modelPickerOption')]
  const index = items.indexOf(document.activeElement)
  if (event.key === 'Escape') {
    event.preventDefault()
    closeModelPicker()
    conversationModelTrigger.focus()
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }
})
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.conversationModelPicker')) closeModelPicker()
})
conversationModelTrigger.closest('.conversationModelPicker').addEventListener('focusout', event => {
  if (!event.currentTarget.contains(event.relatedTarget)) closeModelPicker()
})

async function loadConversationModel(sessionId) {
  try {
    const response = await apiFetch(`/api/sessions/${sessionId}/model`, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error('unavailable')
    const data = await response.json()
    if (currentSessionId !== sessionId) return
    const models = Array.isArray(data.models) ? data.models.filter(item =>
      typeof item?.provider === 'string' && typeof item?.model === 'string') : []
    const selected = data.selected && typeof data.selected.provider === 'string'
      && typeof data.selected.model === 'string' ? data.selected : null
    const options = models.map(item => {
      const option = new Option(`${item.name || item.model} · ${item.provider}`, modelValue(item))
      option.dataset.name = item.name || item.model
      option.dataset.provider = item.provider
      return option
    })
    if (selected && !models.some(item => modelValue(item) === modelValue(selected))) {
      const current = new Option(`${selected.model} · ${selected.provider}（当前）`, modelValue(selected))
      current.dataset.name = `${selected.model}（当前）`
      current.dataset.provider = selected.provider
      options.unshift(current)
    }
    if (!options.length) options.push(new Option('当前没有可选模型', ''))
    conversationModelSelect.replaceChildren(...options)
    currentModelValue = selected ? modelValue(selected) : options[0].value
    conversationModelSelect.value = currentModelValue
    conversationModelSelect.disabled = !models.length || previewActive || sharedReadOnly()
    conversationModelStatus.textContent = ''
    renderModelPicker()
  } catch {
    if (currentSessionId !== sessionId) return
    conversationModelSelect.replaceChildren(new Option('模型信息暂不可用', ''))
    conversationModelSelect.disabled = true
    conversationModelStatus.textContent = '读取模型失败，请刷新重试'
    renderModelPicker()
  }
}

conversationModelSelect.addEventListener('change', async () => {
  if (!currentSessionId || previewActive || sharedReadOnly()) return
  const sessionId = currentSessionId
  let provider, model
  try { [provider, model] = JSON.parse(conversationModelSelect.value) } catch { return }
  conversationModelSelect.disabled = true
  conversationModelStatus.textContent = '切换中…'
  renderModelPicker()
  try {
    const response = await apiFetch(`/api/sessions/${sessionId}/model`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() ?? '' },
      body: JSON.stringify({ provider, model }) })
    if (!response.ok) throw new Error('unavailable')
    const data = await response.json()
    if (currentSessionId !== sessionId) return
    currentModelValue = modelValue(data.selected)
    conversationModelSelect.value = currentModelValue
    conversationModelStatus.textContent = '已用于当前会话'
  } catch {
    if (currentSessionId !== sessionId) return
    conversationModelSelect.value = currentModelValue
    conversationModelStatus.textContent = '切换失败，请重试'
  } finally {
    if (currentSessionId === sessionId) {
      conversationModelSelect.disabled = previewActive || sharedReadOnly()
      renderModelPicker()
    }
  }
})

async function selectSession(session, urlMode = 'push') {
  if (currentSessionId) draftsBySession.set(currentSessionId, conversationInput.value)
  sessionReadController.abort()
  sessionReadController = new AbortController()
  currentSessionId = session.id
  for (const reset of sessionPollers) reset(false)
  conversationWorkspace.textContent = `工作空间 · ${currentAccountName ?? '当前账号'}`
  conversationModelStatus.textContent = ''
  conversationModelSelect.replaceChildren(new Option('读取中…', ''))
  conversationModelSelect.disabled = true
  currentModelValue = ''
  renderModelPicker()
  renderCurrentSessionActions()
  previewActive = session.preview === true
  if (previewActive) {
    conversationModelSelect.replaceChildren(new Option('只读预览', ''))
    renderModelPicker()
  }
  rememberSessionId(session.id)
  syncSessionUrl(session.id, urlMode)
  workspaceEpoch++
  workspaceState = undefined
  workspaceActionUncertain = false
  workspaceEditing = false
  workspaceDraft = undefined
  teamFocusedTaskId = undefined
  teamView = 'route'
  Object.assign(workspaceRouteView, { teamId: null, zoom: 1, fit: false, left: 0, top: 0, mobileOverview: false })
  workspaceDisclosureStates.clear()
  workspaceModelCatalog = []
  workspaceModelError = ''
  setWorkspaceStatus('')
  if (workspaceDocumentDialog.open) workspaceDocumentDialog.close()
  showQuestion(null)
  showApproval(null)
  renderWorkspace({ plan: null, team: null, documents: [], datasets: [], presentation: null })
  conversationInput.value = draftsBySession.get(session.id) ?? ''
  resizeConversationInput()
  conversationEpoch++
  conversationCursor = -1
  conversationLoading = false
  conversationOldestSeq = undefined
  conversationHasEarlier = false
  conversationEarlierLoading = false
  delete conversationEarlier.dataset.failed
  questionLoading = false
  approvalLoading = false
  dataEpoch++
  dataLoading = false
  dataCursor = undefined
  selectedDatasetId = undefined
  selectedDatasetLabel = ''
  setDataListExpanded(false)
  dataItems.replaceChildren()
  dataCount.textContent = '0 项结果'
  dataListToggle.hidden = true
  dataListToggleLabel.textContent = '选择一项结果查看'
  dataListToggle.title = ''
  dataEmpty.hidden = false
  dataEmpty.querySelector('small').textContent = '会话中完成已授权数据集查询后，结果会自动留在这里。'
  dataMore.hidden = true
  dataMore.disabled = false
  dataMore.textContent = '加载更多结果'
  tablePane.replaceChildren()
  tablePane.classList.remove('hasTable')
  const emptyTable = document.createElement('h2')
  emptyTable.textContent = '选择一项结果查看'
  tablePane.append(emptyTable)
  for (const pending of pendingMessages(session.id)) pending.node = null
  showConversationLoading('正在恢复会话', '先读取最近消息；较早内容可按需查看。')
  conversationLatest.hidden = true
  setComposeNotice('')
  closeMentionMenu()
  studioSessionTitle.textContent = session.title
  studioSessionTitle.title = session.title
  document.querySelectorAll('.sessionItem').forEach(button => {
    const current = button.dataset.sessionId === session.id
    button.setAttribute('aria-current', String(current))
    const item = availableSessions.find(entry => entry.id === button.dataset.sessionId)
    button.querySelector('.sessionItemLabel').textContent = sessionListLabel(item, current)
    button.querySelector('.sessionItemDetail').textContent = sessionListDetail(item, current)
  })
  conversationInput.disabled = !researchReady || previewActive || sharedReadOnly()
  sendMessageButton.disabled = true
  selectView('conversation')
  renderActivity()
  updateComposeStatus()
  const epoch = conversationEpoch
  if (!shareMode && currentAccountName) {
    const cached = await sessionCache.read(currentAccountName, 'messages', session.id)
    if (epoch !== conversationEpoch || session.id !== currentSessionId) return
    if (validCachedMessages(cached) && cached.length) {
      cachedMessagesBySession.set(session.id, cached)
      conversationMessages.replaceChildren()
      for (const message of cached) appendConversationMessage(message, false)
      scrollToLatest()
      await new Promise(resolve => requestAnimationFrame(resolve))
      if (epoch !== conversationEpoch || session.id !== currentSessionId) return
    }
  }
  await Promise.all([
    loadConversation(session.id, epoch),
    loadQuestion(session.id, epoch),
    loadApproval(session.id, epoch),
  ])
  if (epoch !== conversationEpoch) return
  sendMessageButton.disabled = !researchReady || !!activeQuestion || previewActive || sharedReadOnly()
  if (previewActive) { selectWorkspaceTab('team'); selectView('workspace') }
  for (const pending of pendingMessages(session.id)) {
    if (pending.userSeq !== undefined || pending.state === 'replied') continue
    pending.node = createMessage({ role: 'user', text: pending.text }, false)
    setReceipt(pending.node, pending.state)
    conversationMessages.querySelector('.conversationEmpty')?.remove()
    conversationMessages.append(pending.node)
  }
  renderActivity()
  // A cold workspace or model catalog can occupy the DSH runtime for seconds.
  // Let the recovered conversation paint before starting those reads.
  requestAnimationFrame(() => window.setTimeout(() => {
    if (epoch !== conversationEpoch || session.id !== currentSessionId) return
    if (!previewActive) void loadConversationModel(session.id)
    void loadWorkspace(session.id)
  }, 0))
}

function displayCell(value) {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function datasetLabel(dataset) {
  const name = String(dataset ?? '')
  if (!name) return '未命名数据'
  const labels = {
    'localdb.bank-industry.query': '银行行业数据',
    'localdb.bank-industry.schema': '银行行业字段目录',
    'realestate.rent.market': '租赁市场数据',
    'realestate.city.market': '城市市场数据',
  }
  return labels[name] ?? name.split('.').at(-1)?.replaceAll('_', ' ') ?? '未命名数据'
}

function datasetTime(value) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '时间未记录'
}

function draftReportRequest(page, id) {
  const request = `请使用 customer-report-generator 技能，结合我当前的问题和本会话的数据快照（ID：${id}，数据集：${page.dataset}）判断能回答什么。数据不足时先说明；适合时生成篇幅与证据相称、可下载的简报或报告。`
  const existing = conversationInput.value.trim()
  conversationInput.value = existing ? `${existing}\n\n${request}` : request
  resizeConversationInput()
  draftsBySession.set(currentSessionId, conversationInput.value)
  selectView('conversation')
  setComposeNotice('已把所选数据加入报告请求草稿，确认内容后发送。')
  conversationInput.focus()
  conversationInput.setSelectionRange(conversationInput.value.length, conversationInput.value.length)
}

function setDataListExpanded(expanded) {
  dataList.classList.toggle('isCollapsed', !expanded)
  dataListToggle.setAttribute('aria-expanded', String(expanded))
}

function syncDataListSelection() {
  dataItems.querySelectorAll('.dataItem').forEach(button => {
    const selected = button.dataset.id === selectedDatasetId
    button.setAttribute('aria-current', String(selected))
    if (selected) selectedDatasetLabel = button.querySelector('strong')?.textContent || ''
  })
  const label = selectedDatasetLabel ? `切换结果 · ${selectedDatasetLabel}` : '选择一项结果查看'
  dataListToggleLabel.textContent = label
  dataListToggle.title = label
}

dataListToggle.addEventListener('click', () => {
  setDataListExpanded(dataListToggle.getAttribute('aria-expanded') !== 'true')
})

async function selectDataset(id, offset = 0) {
  if (!currentSessionId) return
  selectedDatasetId = id
  syncDataListSelection()
  const sessionId = currentSessionId
  const epoch = dataEpoch
  tablePane.replaceChildren()
  tablePane.classList.remove('hasTable')
  const loading = document.createElement('p')
  loading.textContent = '正在读取表格…'
  tablePane.append(loading)
  try {
    const response = await apiFetch(`/api/sessions/${sessionId}/datasets/${id}?offset=${offset}`, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error('dataset unavailable')
    const page = await response.json()
    if (epoch !== dataEpoch || id !== selectedDatasetId) return
    if (!Array.isArray(page.columns) || !Array.isArray(page.rows)) throw new Error('invalid table')
    tablePane.replaceChildren()
    tablePane.classList.add('hasTable')
    const header = document.createElement('div')
    header.className = 'tableHeader'
    const heading = document.createElement('div')
    const eyebrow = document.createElement('span')
    eyebrow.className = 'eyebrow'
    eyebrow.textContent = '查询快照'
    const title = document.createElement('h2')
    title.textContent = datasetLabel(page.dataset)
    const code = document.createElement('small')
    code.className = 'dataCode'
    code.textContent = page.dataset
    heading.append(eyebrow, title, code)
    const reportButton = document.createElement('button')
    reportButton.type = 'button'
    reportButton.className = 'dataReportButton'
    reportButton.textContent = '以此生成报告 ↗'
    reportButton.addEventListener('click', () => draftReportRequest(page, id))
    header.append(heading, reportButton)
    const provenance = document.createElement('div')
    provenance.className = 'dataProvenance'
    for (const [label, value] of [
      ['来源', page.provider], ['口径', page.caliber], ['单位', page.unit], ['查询时间', datasetTime(page.at)],
    ]) {
      if (!value) continue
      const item = document.createElement('span')
      const name = document.createElement('small')
      name.textContent = label
      const detail = document.createElement('strong')
      detail.textContent = String(value)
      item.append(name, detail)
      provenance.append(item)
    }
    const tableLead = document.createElement('div')
    tableLead.className = 'dataTableLead'
    const tableTitle = document.createElement('strong')
    tableTitle.textContent = '结果明细'
    const tableCount = document.createElement('small')
    tableCount.textContent = `${Number.isFinite(page.totalRows) ? page.totalRows : page.rows.length} 行 · ${page.columns.length} 列`
    const swipeHint = document.createElement('small')
    swipeHint.className = 'dataSwipeHint'
    swipeHint.textContent = '左右滑动查看全部字段'
    tableLead.append(tableTitle, tableCount, swipeHint)
    const frame = document.createElement('div')
    frame.className = 'dataTableFrame'
    frame.tabIndex = 0
    frame.setAttribute('aria-label', `${datasetLabel(page.dataset)}结果表格，可横向滚动`)
    const table = document.createElement('table')
    const caption = document.createElement('caption')
    caption.textContent = `${datasetLabel(page.dataset)}，${datasetTime(page.at)}`
    table.append(caption)
    const head = document.createElement('thead')
    const headRow = document.createElement('tr')
    for (const column of page.columns) { const th = document.createElement('th'); th.textContent = String(column); headRow.append(th) }
    head.append(headRow)
    const body = document.createElement('tbody')
    for (const row of page.rows) {
      const tr = document.createElement('tr')
      for (const value of row) { const td = document.createElement('td'); td.textContent = displayCell(value); td.title = td.textContent; tr.append(td) }
      body.append(tr)
    }
    table.append(head, body)
    frame.append(table)
    const pager = document.createElement('div')
    pager.className = 'dataPager'
    const count = document.createElement('small')
    count.textContent = `${page.totalRows} 行 · 第 ${Math.floor(offset / 100) + 1} 页`
    const previous = document.createElement('button')
    previous.type = 'button'; previous.textContent = '上一页'; previous.disabled = offset === 0
    previous.addEventListener('click', () => { void selectDataset(id, Math.max(0, offset - 100)) })
    const next = document.createElement('button')
    next.type = 'button'; next.textContent = '下一页'; next.disabled = page.nextOffset === undefined
    next.addEventListener('click', () => { void selectDataset(id, page.nextOffset) })
    pager.append(count, previous, next)
    tablePane.append(header, provenance, tableLead, frame, pager)
  } catch {
    if (epoch === dataEpoch) loading.textContent = '表格暂时无法读取，请稍后重试。'
  }
}

async function loadDatasets(more = false) {
  if (!currentSessionId || dataLoading) return
  const sessionId = currentSessionId
  const epoch = dataEpoch
  dataLoading = true
  dataMore.disabled = true
  dataMore.textContent = '正在加载…'
  try {
    const url = `/api/sessions/${sessionId}/datasets${more && dataCursor ? `?before=${encodeURIComponent(dataCursor)}` : ''}`
    const response = await apiFetch(url, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error('data unavailable')
    const page = await response.json()
    if (epoch !== dataEpoch) return
    if (!Array.isArray(page.items)) throw new Error('invalid data list')
    if (!more) dataItems.replaceChildren()
    for (const item of page.items) {
      if ([...dataItems.children].some(node => node.dataset.id === item.id)) continue
      const button = document.createElement('button')
      button.type = 'button'; button.className = 'dataItem'; button.dataset.id = item.id
      const top = document.createElement('span')
      top.className = 'dataItemTop'
      const category = document.createElement('span')
      category.textContent = '已保存快照'
      const arrow = document.createElement('span')
      arrow.setAttribute('aria-hidden', 'true')
      arrow.textContent = '↗'
      top.append(category, arrow)
      const name = document.createElement('strong')
      name.textContent = datasetLabel(item.dataset)
      const code = document.createElement('span')
      code.className = 'dataItemCode'
      code.textContent = item.dataset
      const context = document.createElement('small')
      context.textContent = `${item.provider || '来源未记录'} · ${datasetTime(item.at)}`
      button.append(top, name, code, context)
      button.addEventListener('click', () => {
        void selectDataset(item.id)
        if (window.matchMedia('(max-width: 620px)').matches) {
          setDataListExpanded(false)
          requestAnimationFrame(() => {
            tablePane.focus({ preventScroll: true })
            tablePane.scrollIntoView({ block: 'start' })
          })
        }
      })
      dataItems.append(button)
    }
    dataCursor = page.nextCursor
    dataCount.textContent = page.hasMore ? `已加载 ${dataItems.children.length} 项` : `${dataItems.children.length} 项结果`
    syncDataListSelection()
    dataListToggle.hidden = dataItems.children.length === 0
    dataEmpty.hidden = dataItems.children.length > 0
    dataMore.hidden = !page.hasMore
    dataMore.textContent = '加载更多结果'
  } catch {
    if (epoch === dataEpoch) {
      dataEmpty.hidden = dataItems.children.length > 0
      if (!dataEmpty.hidden) dataEmpty.querySelector('small').textContent = '查询结果暂时无法读取，请稍后再试。'
      if (!dataItems.children.length) setDataListExpanded(true)
      dataMore.hidden = false
      dataMore.textContent = dataItems.children.length ? '加载失败，点击重试' : '重试加载结果'
    }
  } finally {
    if (epoch === dataEpoch) {
      dataLoading = false
      dataMore.disabled = false
    }
  }
}
dataMore.addEventListener('click', () => { void loadDatasets(dataItems.children.length > 0) })

newSessionButton.addEventListener('click', async () => {
  if (!researchReady || shareMode) return
  newSessionButton.disabled = true
  try {
    const response = await apiFetch('/api/sessions', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() ?? '' },
      body: JSON.stringify({ requestId: crypto.randomUUID() }) })
    if (!response.ok) throw new Error('create failed')
    const { session } = await response.json()
    const listing = await apiFetch('/api/sessions', { credentials: 'same-origin', cache: 'no-store' })
    sessionListFilter = 'all'
    if (listing.ok) renderSessionList((await listing.json()).sessions)
    await selectSession(session)
    showMessage('')
    conversationInput.focus()
  } catch { showMessage('新建会话暂时失败，请稍后重试。') }
  finally { newSessionButton.disabled = !researchReady }
})

function mentionAtCursor() {
  const before = conversationInput.value.slice(0, conversationInput.selectionStart)
  const match = /(^|\s)@([^\s@]*)$/.exec(before)
  return match ? { start: before.length - match[2].length - 1, end: conversationInput.selectionStart, query: match[2].toLowerCase() } : undefined
}

function closeMentionMenu() {
  mentionMenu.hidden = true
  activeMentionGroup = null
  conversationInput.setAttribute('aria-expanded', 'false')
  conversationInput.removeAttribute('aria-activedescendant')
}

function chooseMention(choice) {
  if (!choice?.available) return
  const mention = mentionAtCursor()
  if (!mention) return
  const insertion = `@${choice.name} `
  conversationInput.setRangeText(insertion, mention.start, mention.end, 'end')
  resizeConversationInput()
  if (choice.type && currentSessionId) {
    const selected = selectedMentionsBySession.get(currentSessionId) ?? []
    if (!selected.some(item => item.kind === choice.type && item.id === choice.id))
      selected.push({ kind: choice.type, id: choice.id, version: choice.version, name: choice.name })
    selectedMentionsBySession.set(currentSessionId, selected)
  }
  closeMentionMenu()
  conversationInput.focus()
}

function mentionGroupKey(choice) {
  if (choice.type === 'domain-pack' || choice.name === '领域包') return 'domain-pack'
  if (choice.type === 'expert' || choice.name === '专家') return 'expert'
  return 'data-source'
}

function mentionItems(group, query) {
  const items = mentionChoices.filter(choice => mentionGroupKey(choice) === group.key)
  if (!query || group.label.toLowerCase().includes(query)) return items
  return items.filter(choice => [choice.name, choice.description, mentionItemDetail(choice)]
    .some(value => typeof value === 'string' && value.toLowerCase().includes(query)))
}

function mentionItemDetail(choice) {
  if (!choice.available) return '暂未接入'
  if (choice.type !== 'expert') return choice.description || choice.kind
  const labels = {
    'realestate.services': '居住服务',
    'realestate.policy': '政策制度',
    'realestate.city': '城市市场',
    'realestate.macro': '宏观经济',
    'realestate.research': '行业研究',
  }
  return (choice.description || '').split(/[、,]/).map(value => labels[value.trim()] || value.trim())
    .filter(Boolean).join(' · ') || '专家档案'
}

function appendMentionOption({ label, detail, aside, disabled, category, onClick }) {
  const button = document.createElement('button')
  button.type = 'button'
  button.id = `mention-option-${mentionMenu.querySelectorAll('.mentionOption').length}`
  button.className = `mentionOption${category ? ' mentionCategory' : ''}`
  button.setAttribute('role', 'option')
  button.setAttribute('aria-selected', 'false')
  button.disabled = disabled
  const text = document.createElement('span')
  text.className = 'mentionOptionText'
  const name = document.createElement('strong')
  name.textContent = label
  const subtitle = document.createElement('span')
  subtitle.className = 'mentionOptionDetail'
  subtitle.textContent = detail
  text.append(name, subtitle)
  const trailing = document.createElement('span')
  trailing.className = 'mentionOptionAside'
  trailing.textContent = aside
  if (category) {
    const arrow = document.createElement('span')
    arrow.className = 'mentionOptionArrow'
    arrow.setAttribute('aria-hidden', 'true')
    arrow.textContent = '›'
    trailing.append(arrow)
  }
  button.append(text, trailing)
  button.addEventListener('mousedown', event => event.preventDefault())
  button.addEventListener('click', onClick)
  mentionMenu.append(button)
}

function updateMentionMenu() {
  const mention = mentionAtCursor()
  if (!mention || conversationInput.disabled) return closeMentionMenu()
  const group = mentionGroups.find(item => item.key === activeMentionGroup)
  mentionMenu.replaceChildren()
  if (mentionCatalogLoading && !mentionCatalogLoaded) {
    const loading = document.createElement('div')
    loading.className = 'mentionEmpty'
    loading.textContent = '正在读取可用对象…'
    mentionMenu.append(loading)
    mentionMenu.hidden = false
    mentionMenu.setAttribute('aria-label', '正在读取可提及的对象')
    conversationInput.setAttribute('aria-expanded', 'true')
    conversationInput.removeAttribute('aria-activedescendant')
    return
  }
  if (group) {
    const header = document.createElement('div')
    header.className = 'mentionMenuHeader'
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'mentionBack'
    back.setAttribute('aria-label', '返回对象分类')
    back.textContent = '‹'
    back.addEventListener('mousedown', event => event.preventDefault())
    back.addEventListener('click', () => { activeMentionGroup = null; updateMentionMenu() })
    const title = document.createElement('span')
    title.textContent = group.label
    header.append(back, title)
    mentionMenu.append(header)
    const items = mentionItems(group, mention.query)
    for (const choice of items) appendMentionOption({
      label: `@${choice.name}`,
      detail: mentionItemDetail(choice),
      aside: choice.available && choice.version ? `v${choice.version}` : '',
      disabled: !choice.available,
      onClick: () => chooseMention(choice),
    })
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'mentionEmpty'
      empty.textContent = `该分类中没有匹配“${mention.query}”的对象。`
      mentionMenu.append(empty)
    }
  } else {
    const heading = document.createElement('div')
    heading.className = 'mentionMenuHeading'
    heading.textContent = '选择对象类型'
    mentionMenu.append(heading)
    let shown = 0
    for (const item of mentionGroups) {
      const items = mentionItems(item, mention.query)
      if (!items.length) continue
      shown++
      const count = items.filter(choice => choice.available).length
      appendMentionOption({
        label: item.label,
        detail: item.detail,
        aside: count ? `${count} ${item.unit}` : '待接入',
        disabled: count === 0,
        category: true,
        onClick: () => { activeMentionGroup = item.key; updateMentionMenu(); mentionMenu.scrollTop = 0 },
      })
    }
    if (!shown) {
      const empty = document.createElement('div')
      empty.className = 'mentionEmpty'
      empty.textContent = '未找到已接入对象；可以继续输入普通文本。'
      mentionMenu.append(empty)
    }
  }
  mentionMenu.hidden = false
  mentionMenu.setAttribute('aria-label', group ? `可提及的${group.label}` : '可提及的对象类别')
  conversationInput.setAttribute('aria-expanded', 'true')
  const first = mentionMenu.querySelector('.mentionOption:not(:disabled)')
  if (first) {
    first.setAttribute('aria-selected', 'true')
    conversationInput.setAttribute('aria-activedescendant', first.id)
  } else conversationInput.removeAttribute('aria-activedescendant')
}

function refreshMentionChoicesIfStale() {
  if (mentionAtCursor() && Date.now() >= mentionCatalogNextLoadAt) void loadMentionChoices()
}

function resizeConversationInput() {
  conversationInput.style.height = '42px'
  conversationInput.style.height = `${Math.max(42, conversationInput.scrollHeight)}px`
}

conversationInput.addEventListener('input', () => {
  resizeConversationInput()
  if (currentSessionId) {
    draftsBySession.set(currentSessionId, conversationInput.value)
    selectedMentionsBySession.set(currentSessionId,
      (selectedMentionsBySession.get(currentSessionId) ?? []).filter(item => conversationInput.value.includes(`@${item.name}`)))
  }
  updateMentionMenu()
  refreshMentionChoicesIfStale()
})
conversationInput.addEventListener('click', () => { updateMentionMenu(); refreshMentionChoicesIfStale() })
conversationInput.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) {
    event.preventDefault(); void sendConversationMessage(); return
  }
  if (mentionMenu.hidden) return
  const enabled = [...mentionMenu.querySelectorAll('.mentionOption:not(:disabled)')]
  if (event.key === 'Escape') {
    event.preventDefault()
    if (activeMentionGroup) { activeMentionGroup = null; updateMentionMenu() }
    else closeMentionMenu()
    return
  }
  if (!enabled.length) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const current = enabled.findIndex(button => button.getAttribute('aria-selected') === 'true')
    const next = (current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
    mentionMenu.querySelectorAll('.mentionOption').forEach(button => button.setAttribute('aria-selected', 'false'))
    enabled[next].setAttribute('aria-selected', 'true')
    conversationInput.setAttribute('aria-activedescendant', enabled[next].id)
  } else if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault()
    const chosen = enabled.find(button => button.getAttribute('aria-selected') === 'true') ?? enabled[0]
    chosen.click()
  }
})
conversationInput.addEventListener('blur', () => window.setTimeout(closeMentionMenu, 120))

async function sendConversationMessage() {
  const text = conversationInput.value.trim()
  if (!researchReady || !currentSessionId || !text || sendMessageButton.disabled || previewActive || sharedReadOnly()) return
  const sessionId = currentSessionId
  const mentions = (selectedMentionsBySession.get(sessionId) ?? []).filter(item => text.includes(`@${item.name}`))
  const existing = pendingMessages(sessionId).find(item => item.state === 'uncertain' && item.text === text && item.userSeq === undefined)
  const pending = existing ?? { text, requestId: crypto.randomUUID(), afterSeq: conversationCursor, startedAt: Date.now() }
  pending.state = 'sending'
  if (!existing) {
    const queue = pendingMessages(sessionId)
    queue.push(pending)
    pendingBySession.set(sessionId, queue)
    pending.node = createMessage({ role: 'user', text }, true)
    conversationMessages.querySelector('.conversationEmpty')?.remove()
    conversationMessages.append(pending.node)
    scrollToLatest()
  }
  setReceipt(pending.node, 'sending')
  renderActivity()
  closeMentionMenu()
  setComposeNotice('')
  sendMessageButton.disabled = true
  sendMessageButton.textContent = '送达中…'
  conversationInput.disabled = true
  document.getElementById('conversationCompose').setAttribute('aria-busy', 'true')
  try {
    const response = await apiFetch(`/api/sessions/${sessionId}/messages`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() ?? '' },
      body: JSON.stringify({ text, requestId: pending.requestId, mentions }) })
    const result = await response.json()
    if (response.status === 400 && result.error === 'MENTION_UNAVAILABLE') throw new Error('mention_unavailable')
    if (!response.ok || result.accepted !== true) throw new Error('send failed')
    applyAutomaticSessionTitle(sessionId, result.sessionTitle)
    selectedMentionsBySession.delete(sessionId)
    if (pending.state !== 'replied') pending.state = pending.userSeq === undefined ? 'accepted' : 'recorded'
    setReceipt(pending.node, pending.state)
    if (currentSessionId === sessionId) {
      if (conversationInput.value.trim() === text) conversationInput.value = ''
      resizeConversationInput()
      draftsBySession.set(sessionId, conversationInput.value)
      renderActivity()
      updateComposeStatus()
      await loadConversation(sessionId)
    } else if ((draftsBySession.get(sessionId) ?? '').trim() === text) draftsBySession.set(sessionId, '')
  } catch (error) {
    if (error?.message === 'mention_unavailable') {
      const queue = pendingMessages(sessionId)
      const index = queue.indexOf(pending)
      if (index !== -1) queue.splice(index, 1)
      pending.node?.remove()
      if (currentSessionId === sessionId) setComposeNotice('该 @ 对象未开通或版本已变化，请从菜单重新选择。', 'error')
      void loadMentionChoices()
      return
    }
    if (pending.state !== 'replied') pending.state = pending.userSeq === undefined ? 'uncertain' : 'recorded'
    setReceipt(pending.node, pending.state)
    if (currentSessionId === sessionId) {
      renderActivity()
      setComposeNotice(pending.state === 'uncertain' ? '无法确认是否发送成功 · 内容已保留，可重试' : '', 'error')
    }
  } finally {
    if (currentSessionId === sessionId) {
      sendMessageButton.disabled = !researchReady || !!activeQuestion || previewActive || sharedReadOnly()
      sendMessageButton.textContent = '发送'
      conversationInput.disabled = !researchReady || !!activeQuestion || previewActive || sharedReadOnly()
      document.getElementById('conversationCompose').setAttribute('aria-busy', 'false')
    }
  }
}
sendMessageButton.addEventListener('click', () => { void sendConversationMessage() })
function needsLiveUpdates() {
  if (!currentSessionId) return false
  if (latestPending() || activeQuestion || activeApproval
    || availableSessions.find(session => session.id === currentSessionId)?.running) return true
  const rows = [...conversationMessages.querySelectorAll('.conversationMessage[data-seq]')]
  const lastUser = rows.findLast(row => row.classList.contains('user'))
  if (!lastUser) return false
  const userSeq = Number(lastUser.dataset.seq)
  const lastAssistant = rows.findLast(row => row.classList.contains('assistant'))
  return (!lastAssistant || Number(lastAssistant.dataset.seq) < userSeq)
    && !failuresBySession.get(currentSessionId)?.has(userSeq)
}
function startPoll(period, shouldRun, task) {
  let timer, running = false, immediate = false, failures = 0
  const interval = () => typeof period === 'function' ? period() : period
  const schedule = delay => { clearTimeout(timer); timer = window.setTimeout(tick, delay) }
  const tick = async () => {
    running = true
    if (document.visibilityState === 'visible' && shouldRun()) {
      try { failures = await task() === false ? Math.min(failures + 1, 4) : 0 }
      catch { failures = Math.min(failures + 1, 4) }
    }
    running = false
    schedule(immediate ? 0 : Math.min(interval() * 2 ** failures, 30000))
    immediate = false
  }
  const reset = (runNow = true) => {
    failures = 0
    if (running) immediate = runNow
    else schedule(runNow ? 0 : interval())
  }
  sessionPollers.push(reset)
  schedule(interval())
}
startPoll(() => needsLiveUpdates() ? 3000 : 6000, () => !!currentSessionId, () => loadConversation(currentSessionId))
startPoll(() => needsLiveUpdates() ? 3000 : 6000, () => !!currentSessionId, () => loadQuestion(currentSessionId))
startPoll(() => needsLiveUpdates() ? 3000 : 6000, () => !!currentSessionId, () => loadApproval(currentSessionId))
startPoll(() => needsLiveUpdates() || workspaceState?.plan?.status === 'staged' ? 10000 : 20000,
  () => !!currentSessionId, () => loadWorkspace(currentSessionId))
startPoll(15000, () => !!availableSessions.length, refreshSessionActivity)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') for (const reset of sessionPollers) reset()
})
window.setInterval(() => { if (currentSessionId && !conversationActivity.hidden) renderActivity() }, 1000)
window.addEventListener('popstate', () => {
  if (location.pathname !== '/app' || !availableSessions.length) return
  const requested = sessionIdFromUrl()
  const target = availableSessions.find(session => session.id === requested)
    ?? availableSessions.find(session => session.id === currentSessionId)
    ?? availableSessions[0]
  if (target.archived || sessionListFilter === 'archive' && !target.archived) {
    sessionListFilter = target.archived ? 'archive' : 'all'
    renderSessionList(availableSessions)
  }
  if (target.id === currentSessionId) {
    if (requested !== target.id) syncSessionUrl(target.id, 'replace')
  } else {
    void selectSession(target, requested === target.id ? 'none' : 'replace')
  }
})

async function showAuthenticatedApp(data) {
  sharePermission = data.share?.permission
  loginView.hidden = true
  previewView.hidden = false
  previewView.classList.toggle('sharedView', shareMode)
  bootView.hidden = true
  logoutButton.hidden = shareMode
  usageButton.disabled = shareMode
  menuButton.setAttribute('aria-expanded', String(!isCompact()))
  document.querySelector('.phaseBadge').textContent = shareMode
    ? sharePermission === 'collaborate' ? '协作分享' : '只读分享' : data.user.accountName
  currentAccountName = data.user.accountName
  researchReady = data.researchReady === true
  showMessage(shareMode ? `当前为${sharePermission === 'collaborate' ? '协作' : '只读'}分享链接 · 到期时间：${new Date(data.share.expiresAt).toLocaleString('zh-CN')}`
    : researchReady ? '' : '研究会话正在开通。')
  document.querySelector('.sessionSidebarHint').textContent = shareMode ? '通过分享链接访问的会话'
    : `${data.user.displayName} · ${data.user.accountName} 下的研究会话`
  newSessionButton.disabled = !researchReady || shareMode
  document.getElementById('newSessionHint').textContent = researchReady ? '点击创建空白研究会话' : '隔离研究环境开通后可新建'
  document.querySelector('.questionPreview:not(.questionCard)').hidden = true
  conversationInput.placeholder = '描述研究议题，或输入 @ 选择可用对象…'
  document.getElementById('mentionHint').textContent = '输入 @ 先选类别，再选对象 · Ctrl/⌘ + Enter 发送'
  studioSessionTitle.textContent = '正在载入研究会话'
  studioSessionTitle.title = ''
  showConversationLoading('正在读取会话列表', '会话列表出现后，将恢复上次打开的研究会话。')
  selectView('conversation')
  const requested = sessionIdFromUrl()
  const saved = savedSessionId()
  const preferredSession = sessions => sessions.find(session => session.id === requested)
    ?? sessions.find(session => session.id === saved && !session.archived)
    ?? sessions.find(session => !session.archived)
    ?? sessions[0]
  // Start the authoritative read immediately, while IndexedDB supplies a first paint.
  const serverList = (async () => {
    const response = await apiFetch('/api/sessions', { credentials: 'same-origin', cache: 'no-store', networkRetry: true })
    if (!response.ok) throw new Error('session_list_unavailable')
    const body = await response.json()
    if (!Array.isArray(body.sessions)) throw new Error('invalid_session_list')
    return body.sessions
  })().then(sessions => ({ sessions }), error => ({ error }))
  if (!shareMode) {
    const cached = await sessionCache.read(currentAccountName, 'sessions', '')
    if (Array.isArray(cached) && cached.every(session => typeof session?.id === 'string' && typeof session.title === 'string')) {
      const provisional = cached.map(session => ({ ...session, running: false }))
      renderSessionList(provisional, false)
      const target = preferredSession(provisional)
      if (target) void selectSession(target, 'replace').catch(() => undefined)
    }
  }
  let sessions
  try {
    const result = await serverList
    if (result.error) throw result.error
    sessions = result.sessions
    renderSessionList(sessions)
  } catch {
    if (availableSessions.length) {
      showMessage('服务器暂时无法校正会话列表，正在显示本机缓存；请刷新页面重试。')
      return
    }
    showSessionListState('会话列表暂不可用', '请刷新页面重试。')
    studioSessionTitle.textContent = '会话暂时无法恢复'
    showConversationLoading('会话列表读取失败', '请刷新页面重试；登录状态不会因此清除。')
    showMessage('会话列表读取失败，请刷新页面重试。')
    return
  }
  const target = sessions.find(session => session.id === currentSessionId) ?? preferredSession(sessions)
  if (target?.archived) { sessionListFilter = 'archive'; renderSessionList(sessions) }
  if (requested && !sessions.some(session => session.id === requested)) showMessage('链接中的会话不可用，已恢复当前账号可用的会话。')
  if (target && target.id !== currentSessionId) void selectSession(target, 'replace')
    .catch(() => { showConversationLoading('会话恢复失败', '请从左侧重新打开会话。') })
    .finally(() => { window.setTimeout(() => {
      if (document.visibilityState === 'visible') void refreshSessionActivity()
    }, 5_000) })
  if (!target) {
    sessionReadController.abort()
    conversationEpoch++
    currentSessionId = undefined
    syncSessionUrl(null, 'replace')
    studioSessionTitle.textContent = '从一个问题开始'
    studioSessionTitle.title = '从一个问题开始'
    conversationMessages.replaceChildren(emptyConversation.cloneNode(true))
  }
}

try {
  const response = await apiFetch('/api/bootstrap', { credentials: 'same-origin', cache: 'no-store', networkRetry: true })
  if (!response.ok) throw new Error('service_unavailable')
  const data = await response.json()
  if (data.phase === 'S0') loginStatus.textContent = '客户账号接入正在建设。完成身份与权限验证后开放登录。'
  if (new URLSearchParams(location.search).get('status') === 'pending') loginStatus.textContent = '身份验证成功，账号待管理员开通。'
  if (data.loginProviders.includes('developer-center')) {
    developerLogin.disabled = false
    document.getElementById('developerLoginState').textContent = '可用'
    if (new URLSearchParams(location.search).get('status') !== 'pending') loginStatus.textContent = '使用已开通的账号登录。'
  }
  if ((location.pathname === '/app' || shareMode) && data.authenticated) await showAuthenticatedApp(data)
  else if (shareMode) {
    bootView.hidden = false
    loginView.hidden = true
    bootView.querySelector('.paintLoader').hidden = true
    bootView.querySelector('span:last-child').textContent = '分享链接无效、已到期或已撤销，请联系分享人重新生成。'
  }
  else if (location.pathname === '/preview') {
    bootView.hidden = true
    loginView.hidden = true
    previewView.hidden = false
    menuButton.setAttribute('aria-expanded', String(!isCompact()))
    const requestedView = new URLSearchParams(location.search).get('view')
    selectView(Object.hasOwn(panels, requestedView) ? requestedView : 'conversation')
  } else {
    bootView.hidden = true
    loginView.hidden = false
  }
} catch {
  previewView.hidden = true
  loginView.hidden = true
  bootView.hidden = false
  bootView.querySelector('.paintLoader').hidden = true
  bootView.querySelector('span:last-child').textContent = '暂时无法确认登录状态，请刷新页面重试。'
}
