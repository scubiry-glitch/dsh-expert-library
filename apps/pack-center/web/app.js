import { el, api, button, field, notice, setSession, showError, runAction } from './shared.js'
import { renderSubmissions } from './submissions.js'
import { renderAdmin } from './admin.js'

const mount = document.getElementById('app')
let session, organizations = [], pageController, identityController, initialization = 0
function navigate(path) {
  const hash = `#/${path.replace(/^\/+/, '')}`
  if (location.hash === hash) void render()
  else location.hash = hash
}
function brand() { return el('div', { className: 'brand' }, el('span', { className: 'brand-mark', 'aria-hidden': 'true' }, '智'), el('div', {}, el('strong', {}, '智见合作伙伴中心'), el('small', {}, 'DSH · Expert Library'))) }
function login(reason) {
  identityController?.abort(); pageController?.abort(); pageController = new AbortController()
  const signal = pageController.signal
  session = undefined; organizations = []; setSession(undefined)
  const errorBox = el('div', { className: 'stack', 'data-testid': 'login-error' })
  const invitation = el('input', { type: 'password', autoComplete: 'off', spellcheck: false, maxLength: 256, 'data-testid': 'login-invitation' })
  const submit = button('使用组织账号登录', null, { kind: 'primary', type: 'submit', 'data-testid': 'login-submit' })
  const form = el('form', { className: 'stack', onSubmit: event => {
    event.preventDefault()
    void runAction(submit, async () => {
      const token = invitation.value.trim(); invitation.value = ''
      const result = await api('/api/auth/login', { method: 'POST', body: token ? { invitationToken: token } : {}, signal })
      const target = new URL(result.authorizationUrl)
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
      if (target.username || target.password || !['https:'].includes(target.protocol) && !(location.protocol === 'http:' && local && target.protocol === 'http:')) throw Object.assign(new Error('RESPONSE_INVALID'), { code: 'RESPONSE_INVALID' })
      location.assign(target.href)
    }, errorBox)
  } }, field('邀请代码（首次加入组织时填写）', invitation, '已有成员直接登录。邀请代码不会保存到浏览器存储。'), submit)
  const card = el('section', { className: 'login-card' }, brand(), el('div', { className: 'login-heading' }, el('span', { className: 'eyebrow' }, '独立中心 · 受控分发'),
    el('h1', {}, '让领域经验，\n可靠地抵达每个部署点。'), el('p', { className: 'muted' }, '提交固定内容，由独立审核员批准。每个部署点自主选择安装与启用，发布不会触发自动升级。')),
    reason ? notice(reason, 'warning') : null, errorBox, form, el('p', { className: 'fine-print' }, '通过组织身份服务认证 · 邀请制加入 · 不使用 Harness 会话'))
  mount.replaceChildren(el('main', { id: 'main', className: 'login-layout' }, card,
    el('aside', { className: 'login-aside', 'aria-label': '工作流程' }, el('span', { className: 'eyebrow' }, '从提交到分发'), el('h2', {}, '内容固定。\n权限明确。'),
      el('ol', { className: 'process-list' }, ...[['01', '提交与校验', '从 Git 固定 commit，生成结构报告和差异。'], ['02', '独立审核', '审核员确认同一快照，发布签名归档。'], ['03', '按授权分发', '每个部署点使用独立凭据，下载前重新验权。']].map(([n, title, text]) => el('li', {}, el('span', { className: 'process-number' }, n), el('div', {}, el('strong', {}, title), el('p', {}, text))))),
      el('p', { className: 'fine-print' }, '首版管理 V2 领域包，不执行提交仓库中的代码。'))))
  if (location.search) history.replaceState(null, '', `/${location.hash}`)
}
async function refreshSession() {
  const attempt = ++initialization
  identityController?.abort(); pageController?.abort()
  identityController = new AbortController()
  const signal = identityController.signal
  session = undefined; organizations = []; setSession(undefined)
  mount.replaceChildren(el('main', { id: 'main', className: 'boot', role: 'status' }, '正在重新验证会话…'))
  try {
    const me = await api('/api/me', { signal })
    const data = await api('/api/organizations', { signal })
    if (attempt !== initialization || signal.aborted) return
    session = me; organizations = data.items; setSession(me)
    await render()
    return { principal: me.principal, organizations }
  } catch (error) {
    if (attempt !== initialization || signal.aborted) return
    if ([401, 403].includes(error?.status)) login(error.status === 403 ? '账号没有有效组织资格，请联系管理员或使用新的邀请。' : undefined)
    else {
      const errorBox = el('div'); showError(errorBox, error)
      mount.replaceChildren(el('main', { id: 'main', className: 'boot stack' }, brand(), el('h1', {}, '暂时无法连接中心'), errorBox,
        button('重新连接', () => refreshSession(), { kind: 'primary' })))
    }
  }
}
async function render() {
  if (!session) return
  pageController?.abort(); pageController = new AbortController()
  const signal = pageController.signal
  let route, query
  try {
    const raw = location.hash.replace(/^#\/?/, '') || 'submissions'
    const url = new URL(`/${raw}`, location.origin)
    route = url.pathname.slice(1); query = url.searchParams
  } catch { route = 'not-found'; query = new URLSearchParams() }
  const p = session.principal, hasAdmin = p.platformAdmin || p.memberships.some(m => m.roles.includes('admin'))
  const hasReviewer = p.memberships.some(m => m.roles.includes('reviewer'))
  // Navigation follows the three axes of the center: creation (developer ×
  // pack), publication (review-gated releases), and distribution (tenant ×
  // visibility). A link appears only when the identity can reach the page.
  // Role-facing guides served by this center (fixed assets in src/web.ts):
  // the developer open-capability devdoc for partners, and the tenant
  // onboarding wizard for tenant admins. Same-origin, opened in a new tab.
  const externalLinks = { 'partner-devdoc': '/guides/partner-devdoc', 'tenant-setup': '/guides/tenant-setup' }
  const groups = [
    { caption: '系统设置 · 平台', links: hasAdmin ? [['accounts', '账号与角色', '账'], ['organizations', '组织与成员', '组'], ['visibility', '可见性授权', '权'], ...(p.platformAdmin ? [['audit', '审计日志', '志']] : [])] : [] },
    { caption: '创作 · 开发者 × 包', links: [['submissions', '我的提交', '文'], ['partner-devdoc', '伙伴开发文档', '册'], ...(hasReviewer ? [['reviews', '审核队列', '审']] : [])] },
    { caption: '发布 · 审核门', links: hasAdmin || hasReviewer ? [['releases', '发布管理', '包']] : [] },
    { caption: '分发 · 租户', links: hasAdmin ? [['tenant-setup', '租户接入向导', '引'], ['deployments', '部署点', '点']] : [] },
  ]
  if (hasReviewer) groups[2].links.push(['distribution-reviews', '分发审核', '核'])
  const links = groups.flatMap(group => group.links)
  const current = links.find(([path]) => route === path || route.startsWith(`${path}/`))
  document.title = `${current?.[1] ?? '智见合作伙伴中心'} · DSH`
  const content = el('div', { className: 'page-content', 'aria-live': 'polite', 'data-testid': 'page-content' })
  const errorBox = el('div', { id: 'global-error' })
  const nav = el('nav', { 'aria-label': '主要导航' }, ...groups.map(group => el('div', { className: 'nav-group' },
    el('div', { className: 'nav-caption' }, group.caption),
    ...group.links.map(([path, title, icon]) => externalLinks[path]
      ? el('a', { href: externalLinks[path], target: '_blank', rel: 'noopener', className: 'nav-link' },
          el('span', { className: 'nav-symbol', 'aria-hidden': 'true' }, icon), title)
      : el('a', { href: `#/${path}`, className: current?.[0] === path ? 'nav-link active' : 'nav-link',
          ...(current?.[0] === path ? { 'aria-current': 'page' } : {}) }, el('span', { className: 'nav-symbol', 'aria-hidden': 'true' }, icon), title)))))
  const logout = button('退出登录', async event => runAction(event.currentTarget, async () => {
    await api('/api/auth/logout', { method: 'POST', body: {}, signal })
    ++initialization; login('已安全退出。')
  }, errorBox), { kind: 'quiet', 'data-testid': 'logout' })
  mount.replaceChildren(el('div', { className: 'app-shell' }, el('aside', { className: 'sidebar' }, brand(), el('div', { className: 'nav-caption' }, '领域包管理'), nav,
    el('div', { className: 'sidebar-note' }, el('strong', {}, '三条轴线'), el('p', {}, '创作归属开发者本人；发布须经独立审核；分发给租户的可见范围单独授权。部署点的安装、启用始终由本地决定。'))),
    el('main', { id: 'main', className: 'workspace' }, el('header', { className: 'topbar' }, el('span', {}, current?.[1] ?? '智见合作伙伴中心'),
      el('div', { className: 'session-info' }, el('span', { className: 'session-dot', 'aria-hidden': 'true' }), el('strong', {}, p.displayName), el('span', { className: 'role-label' }, [p.platformAdmin ? '平台管理员' : null, p.developer ? '开发者' : null, !p.platformAdmin && !p.developer ? '组织成员' : null].filter(Boolean).join(' · ')), logout)), errorBox, content)))
  content.append(notice('正在读取最新记录…'))
  const ctx = { root: content, principal: p, organizations, route, query, navigate, signal, refreshSession, api }
  try {
    if (route === 'submissions' || route.startsWith('submissions/') || route === 'reviews') await renderSubmissions(ctx)
    else if (['organizations', 'deployments', 'releases', 'distribution-reviews', 'visibility', 'accounts'].some(path => route === path || route.startsWith(`${path}/`))) await renderAdmin(ctx)
    else content.replaceChildren(el('section', { className: 'card empty-state' }, el('h1', {}, '页面不存在'), el('p', {}, '请从左侧选择一个工作区。')))
  } catch (error) { if (!signal.aborted) showError(content, error) }
}
window.addEventListener('hashchange', () => { if (location.hash !== '#main') void render() })
window.addEventListener('pageshow', event => { if (event.persisted) void refreshSession() })
window.addEventListener('pagehide', () => {
  ++initialization; identityController?.abort(); pageController?.abort()
  session = undefined; organizations = []; setSession(undefined)
  mount.replaceChildren(el('main', { id: 'main', className: 'boot' }, '返回页面后将重新验证会话…'))
})
document.addEventListener('center-session-expired', () => { ++initialization; login('会话已失效，请重新登录。') })
document.addEventListener('center-ui-error', event => { const target = document.getElementById('global-error'); if (target) showError(target, event.detail) })
if (location.hash === '#/login-error') login('登录未完成，可能是认证已过期、邀请无效或没有成员资格。请重新登录；如仍失败，请联系管理员。')
else void refreshSession()
