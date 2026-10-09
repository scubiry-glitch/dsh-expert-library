/** Small same-origin UI primitives. All server/repository text stays text. */
let csrfCookieName, sessionGeneration = 0
export function setSession(session) { csrfCookieName = session?.csrfCookieName; ++sessionGeneration }
export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null) continue
    if (['innerHTML', 'outerHTML', 'srcdoc', 'style'].includes(key)) throw new TypeError('Unsafe DOM property')
    if (/^on[A-Z]/.test(key) && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'className') node.className = value
    else if (key.startsWith('aria-') || key.startsWith('data-') || key === 'role') node.setAttribute(key, String(value))
    else if (key === 'value' && tag === 'select') continue
    else if (key in node) node[key] = value
    else if (value !== false) node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat(Infinity)) if (child !== undefined && child !== null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  if (tag === 'select' && attributes?.value !== undefined) node.value = attributes.value
  return node
}
export function button(label, onClick, options = {}) {
  const { kind = 'secondary', className = '', ...attributes } = options
  const node = el('button', { type: 'button', className: `button ${kind} ${className}`, ...attributes }, label)
  if (onClick) node.addEventListener('click', event => {
    if (node.disabled) return
    const report = error => { if (error?.name !== 'AbortError') document.dispatchEvent(new CustomEvent('center-ui-error', { detail: error })) }
    try { Promise.resolve(onClick(event)).catch(report) } catch (error) { report(error) }
  })
  return node
}
let controlId = 0
export function field(label, control, help) {
  if (!control.id) control.id = `control-${++controlId}`
  const hintId = `${control.id}-hint`
  if (help) control.setAttribute('aria-describedby', hintId)
  return el('div', { className: 'field' }, el('label', { htmlFor: control.id }, label), control,
    help ? el('small', { id: hintId, className: 'muted' }, help) : null)
}
export function notice(text, kind = 'info') {
  return el('div', { className: `notice ${kind}`, role: ['error', 'danger'].includes(kind) ? 'alert' : 'status' }, text)
}
const labels = {
  draft: '草稿', validating: '校验中', validated: '校验通过', validation_failed: '校验失败', pending_review: '待审核',
  approved: '已批准', changes_requested: '待修订', rejected: '已拒绝', withdrawn: '已撤回',
  publishing: '发布中', publish_failed: '发布失败', published: '已发布', yanked: '已下架', active: '有效', disabled: '已停用',
  queued: '排队中', running: '运行中', succeeded: '成功', failed: '失败', revoked: '已撤销', expired: '已过期', consumed: '已使用',
}
export function statusBadge(status) {
  const tone = ['validated', 'published', 'active', 'succeeded', 'approved'].includes(status) ? 'success'
    : ['rejected', 'validation_failed', 'publish_failed', 'failed'].includes(status) ? 'danger'
      : ['pending_review', 'validating', 'publishing', 'changes_requested', 'queued', 'running'].includes(status) ? 'warning' : 'neutral'
  return el('span', { className: `badge ${tone}`, 'data-status': status }, labels[status] ?? status ?? '未知状态')
}
export function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date) : '—'
}
const messages = {
  UNAUTHENTICATED: '会话已失效，请重新登录。', INVITATION_REQUIRED: '当前账号没有有效组织成员资格，请联系管理员。',
  FORBIDDEN: '当前账号没有执行此操作的权限。', NOT_FOUND: '记录不存在，或当前账号无权查看。',
  SELF_REVIEW_DENIED: '提交者不能审核自己的内容，请由另一位授权审核员决定。',
  SELF_PLATFORM_ADMIN_DENIED: '不能修改自己的平台管理员身份，请由另一位平台管理员操作。',
  LAST_PLATFORM_ADMIN: '必须至少保留一位平台管理员，不能撤销。',
  VERSION_CONFLICT: '记录已发生变化，请刷新并重新确认。', STATE_CONFLICT: '记录已发生变化，请刷新并重新确认。',
  IDEMPOTENCY_CONFLICT: '此操作标识已用于其他内容，请刷新后重新发起。', CSRF_INVALID: '安全校验已过期，请刷新页面后重试。',
  INVALID_TRANSITION: '当前状态不允许此操作，请刷新查看最新状态。', VERSION_EXISTS: '此版本已经被占用，请使用新版本号。',
  SOURCE_NOT_ALLOWED: 'Git 来源不在中心允许的 HTTPS 主机范围内。', INVALID_SOURCE: '请检查 Git HTTPS 地址和分支或标签。',
  INVALID_INPUT: '输入不符合要求，请检查必填项和字段格式。', INVALID_CONTRACT: '输入结构不符合领域包协议，请检查分发范围与依赖。',
  RELEASE_YANKED: '这个版本已下架，不能再次下载。', DEPENDENCY_UNAVAILABLE: '固定依赖已下架或无权访问，当前无法下载。',
  RELEASE_INTEGRITY: '发布内容完整性校验失败，请联系中心管理员。', BODY_TOO_LARGE: '提交内容超出接口大小限制。',
  NETWORK_UNCONFIRMED: '连接中断或超时，操作结果未确认。请先刷新核对；重试应使用原操作标识。',
  RESPONSE_INVALID: '中心返回了无法识别的结果，请刷新核对操作是否完成。', INTERNAL_ERROR: '中心暂时无法完成请求，请稍后核对状态。',
}
export function showError(container, error) {
  if (error?.name === 'AbortError') return
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'INTERNAL_ERROR'
  const localMessage = error?.clientValidation === true && typeof error.userMessage === 'string' ? error.userMessage.slice(0,1000) : undefined
  const content = el('div', { className: 'notice error', role: 'alert' }, el('strong', {}, localMessage ?? messages[code] ?? '操作未完成，请核对输入、权限与当前状态。'),
    el('small', {}, `错误代码：${code}${error?.requestId ? ` · 请求编号：${error.requestId}` : ''}`))
  container.replaceChildren(content)
}
export async function runAction(control, action, errorContainer) {
  if (control.disabled) return
  control.disabled = true; control.setAttribute('aria-busy', 'true')
  if (errorContainer) errorContainer.replaceChildren()
  try { return await action() }
  catch (error) {
    if (error?.name !== 'AbortError') {
      if (errorContainer) showError(errorContainer, error)
      else document.dispatchEvent(new CustomEvent('center-ui-error', { detail: error }))
    }
  } finally { control.disabled = false; control.removeAttribute('aria-busy') }
}
function cookie(name) {
  return document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1)
}
export async function api(path, options = {}) {
  if (typeof path !== 'string' || !/^\/api\//.test(path) || new URL(path, location.origin).origin !== location.origin) throw new TypeError('Only same-origin center API paths are allowed')
  const generation = sessionGeneration
  const method = options.method ?? 'GET', mutation = !['GET', 'HEAD'].includes(method)
  const headers = { Accept: 'application/json' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (mutation) {
    const token = csrfCookieName && cookie(csrfCookieName)
    if (token) headers['X-CSRF-Token'] = token
    if (options.key) headers['Idempotency-Key'] = options.key
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  options.signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, options.timeoutMs ?? 20000)
  try {
    let response
    try { response = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: controller.signal, body: options.body === undefined ? undefined : JSON.stringify(options.body) }) }
    catch {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      throw Object.assign(new Error('NETWORK_UNCONFIRMED'), { code: 'NETWORK_UNCONFIRMED' })
    }
    let value
    try { value = await response.json() } catch {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      throw Object.assign(new Error('RESPONSE_INVALID'), { code: 'RESPONSE_INVALID' })
    }
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (!response.ok) {
      const error = Object.assign(new Error(value.error?.code ?? 'INTERNAL_ERROR'), { code: value.error?.code ?? 'INTERNAL_ERROR', status: response.status, requestId: value.error?.requestId })
      if (response.status === 401 && path !== '/api/me' && generation === sessionGeneration) document.dispatchEvent(new CustomEvent('center-session-expired'))
      throw error
    }
    return value
  } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort) }
}
