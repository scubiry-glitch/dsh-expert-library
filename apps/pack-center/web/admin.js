import { el, api, button, field, notice, statusBadge, formatDate, showError, runAction } from './shared.js';
import { runUpstreamUpdate } from './submissions.js';

const enc = encodeURIComponent;
const roles = [['admin', '组织管理员'], ['reviewer', '审核员'], ['member', '成员']];
const pageSize = 20;
const activeRenders = new WeakMap();
const receiptCleanups = new WeakMap();
// Only in-flight or unconfirmed non-secret writes survive route re-renders.
// This is deliberately memory-only: a full document reload loses the keys.
const pendingWrites = new Map();
const maxPendingWrites = 100;
const unconfirmedWriteNotice = '操作结果尚未确认。请先查询已提交记录；页面内以相同内容重试会保留原操作标识。整页刷新或关闭页面会丢失内存标识，之后请勿盲目重复提交。';

function input(name, attrs = {}) { return el('input', { name, id: name, type: 'text', ...attrs }); }
function textarea(name, attrs = {}) { return el('textarea', { name, id: name, rows: 3, maxLength: 4000, required: true, ...attrs }); }
function section(title, ...children) { return el('section', { className: 'card stack' }, el('h2', {}, title), ...children); }
function empty(text) { return notice(text); }
function invalid(text) { return Object.assign(new Error(text), { code: 'INVALID_INPUT', clientValidation: true, userMessage: text }); }
function roleLabels(values) { return values.map(value => roles.find(role => role[0] === value)?.[1] || value).join('、'); }
function isAdmin(principal, id) { return principal.platformAdmin || principal.memberships.some(member => member.organizationId === id && member.roles.includes('admin')); }
function isReviewer(principal) { return principal.memberships.some(member => member.roles.includes('reviewer')); }
function canReview(principal, id) { return isReviewer(principal) && principal.reviewScopes.includes(id); }
function scopeText(scope) {
  if (scope.kind === 'organization') return '仅所属组织';
  if (scope.kind === 'authenticated') return '所有已认证用户及部署点';
  return `指定组织：${scope.organizationIds.join('、') || '无'}；指定部署点：${scope.deploymentIds.join('、') || '无'}`;
}
function table(headers, rows) {
  return el('div', { className: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ...headers.map(text => el('th', { scope: 'col' }, text)))),
    el('tbody', {}, ...rows.map(row => el('tr', {}, ...row.map(value => el('td', {}, value ?? '—')))))));
}
function details(values) {
  return el('dl', { className: 'detail-grid' }, ...values.flatMap(([label, value]) => [el('dt', {}, label), el('dd', {}, value ?? '—')]));
}
function select(name, entries, current) {
  const node = el('select', { name, id: name }, ...entries.map(([value, text]) => el('option', { value }, text)));
  if (current !== undefined) node.value = current;
  return node;
}
function rolePicker(prefix, current = ['member']) {
  const controls = roles.map(([value, label]) => ({ value, node: input(`${prefix}-${value}`, { type: 'checkbox', checked: current.includes(value) }), label }));
  return {
    node: el('fieldset', { className: 'role-picker' }, el('legend', {}, '角色（至少选择一项）'), ...controls.map(({ node, label }) => el('label', {}, node, ` ${label}`))),
    value() { const selected = controls.filter(item => item.node.checked).map(item => item.value); if (!selected.length) throw invalid('请至少选择一个角色。'); return selected; },
  };
}
function confirmation(name, label) { return el('label', { className: 'confirm-check' }, input(name, { type: 'checkbox', required: true }), ` ${label}`); }
function actionForm(ctx, label, content, action, { kind = 'primary', testid, secretIssue = false } = {}) {
  const errors = el('div', { role: 'alert' });
  const submit = button(label, () => {}, { kind, type: 'submit', ...(testid ? { 'data-testid': testid } : {}) });
  const form = el('form', { className: 'stack' }, ...content, errors, submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity() || ctx.signal.aborted || submit.disabled) return;
    runAction(submit, async () => {
      try { await action(errors); }
      catch (error) {
        if (ctx.signal.aborted) return;
        if (secretIssue && ['NETWORK_UNCONFIRMED', 'RESPONSE_INVALID', 'INTERNAL_ERROR'].includes(error?.code)) {
          showError(errors, error);
          errors.append(notice('签发结果未确认，不会自动重试。请先刷新下方元数据，撤销不明记录后，再手动重新签发。', 'warning'));
          return;
        }
        if (error?.unconfirmedWrite) {
          showError(errors, error);
          errors.append(notice(unconfirmedWriteNotice, 'warning'));
          return;
        }
        throw error;
      }
    }, errors);
  });
  return form;
}
function paths(route, entries) {
  const query = new URLSearchParams(Object.entries(entries).filter(([, value]) => value !== undefined && value !== null && value !== ''));
  return `${route}${query.size ? `?${query}` : ''}`;
}
function pagination(ctx, route, params, nextCursor) {
  const controls = [];
  if (ctx.query.has('beforeId')) controls.push(button('返回第一页', () => ctx.navigate(paths(route, params)), { kind: 'secondary' }));
  if (nextCursor) controls.push(button('下一页', () => ctx.navigate(paths(route, { ...params, beforeId: nextCursor })), { kind: 'secondary', 'data-testid': 'next-page' }));
  return el('div', { className: 'toolbar' }, ...controls);
}
function pageQuery(ctx) {
  const query = new URLSearchParams({ limit: String(pageSize) });
  if (ctx.query.get('beforeId')) query.set('beforeId', ctx.query.get('beforeId'));
  return query;
}
function organizationPicker(ctx, organizations, route, extras = {}) {
  const requested = ctx.query.get('organizationId');
  const organization = organizations.find(item => item.id === requested) || (!requested ? organizations[0] : undefined);
  const picker = select(`${route}-organization`, organizations.map(item => [item.id, `${item.name || item.id}${item.status === 'disabled' ? '（已停用）' : ''}`]), organization?.id);
  if (!organization) picker.prepend(el('option', { value: '', selected: true }, '请选择有权限的组织'));
  picker.addEventListener('change', () => ctx.navigate(paths(route, { ...extras, organizationId: picker.value })));
  return { organization, node: field('管理组织', picker) };
}
function requestWriter(ctx) {
  return async (path, body, idempotent = true) => {
    // Invitation/binding issuance bypasses both signatures and key storage.
    if (!idempotent) return api(path, { method: 'POST', body, signal: ctx.signal });
    if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const canonical = value => value && typeof value === 'object'
      ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
      : value;
    const signature = JSON.stringify([ctx.principal.userId, 'POST', path, canonical(body)]);
    let pending = pendingWrites.get(signature);
    if (!pending) {
      if (pendingWrites.size >= maxPendingWrites) throw invalid('已有过多结果未确认的操作，已暂停新的管理写入。请先核对已提交记录，并以原参数重试核实未确认操作；不会丢弃原操作标识。');
      pending = { key: `web:${crypto.randomUUID()}`, userId: ctx.principal.userId };
      pendingWrites.set(signature, pending);
    }
    try {
      const result = await api(path, { method: 'POST', body, key: pending.key, signal: ctx.signal });
      pendingWrites.delete(signature);
      return result;
    } catch (error) {
      // Explicit client rejection confirms no new write; timeouts/aborts and
      // server/response failures remain uncertain and must retain the key.
      if (error?.status >= 400 && error.status < 500 && error.status !== 408) pendingWrites.delete(signature);
      else if (error && typeof error === 'object') error.unconfirmedWrite = true;
      throw error;
    }
  };
}
function clearReceipt(holder) { receiptCleanups.get(holder)?.(); holder.replaceChildren(); }
function secretReceipt(ctx, holder, label, value, expiresAt) {
  if (ctx.signal.aborted) return;
  clearReceipt(holder);
  const secret = input(`one-time-${crypto.randomUUID()}`, { value, readOnly: true, autoComplete: 'off', spellcheck: false, 'data-testid': 'one-time-secret', 'aria-label': label });
  const clear = () => {
    secret.value = '';
    if (receiptCleanups.get(holder) === clear) { holder.replaceChildren(); receiptCleanups.delete(holder); }
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', clear);
  };
  const timer = setTimeout(clear, Math.max(0, new Date(expiresAt).getTime() - Date.now()));
  receiptCleanups.set(holder, clear);
  ctx.signal.addEventListener('abort', clear, { once: true });
  ctx.onCleanup(clear);
  holder.append(section(`${label} · 仅本次显示`,
    notice('请通过可信渠道交付。不会存入浏览器存储或网址；清除、刷新、离开页面或到期后无法再次查看。', 'warning'),
    field(label, secret), el('p', {}, `失效时间：${formatDate(expiresAt)}`),
    button('清除一次性回执', clear, { kind: 'secondary', 'data-testid': 'clear-secret' })));
}
function pageHeader(title, text, extra) {
  return el('header', { className: 'page-header stack' }, el('h1', {}, title), el('p', { className: 'muted' }, text), ...(extra ? [extra] : []));
}
function unauthorized(ctx, text = '当前身份没有此管理功能所需的权限。') { ctx.root.replaceChildren(pageHeader('无权访问', text), notice('如需访问，请联系平台或组织管理员。', 'warning')); }
async function reload(ctx) { if (!ctx.signal.aborted) await renderAdmin(ctx.base); }

async function organizationsPage(ctx) {
  const { principal } = ctx;
  if (!principal.platformAdmin && !principal.memberships.some(member => member.roles.includes('admin'))) return unauthorized(ctx);
  const response = await api('/api/organizations', { signal: ctx.signal });
  if (ctx.signal.aborted) return;
  const organizations = response.items.filter(item => isAdmin(principal, item.id));
  const write = requestWriter(ctx);
  const body = el('div', { className: 'admin-page stack' });
  ctx.root.replaceChildren(pageHeader('组织与成员', '管理组织身份、成员角色和一次性邀请；权限以服务端实时校验为准。'), body);
  if (principal.platformAdmin) {
    const id = input('organization-id', { required: true, maxLength: 64, pattern: '[A-Za-z0-9][A-Za-z0-9._-]{0,63}' });
    const slug = input('organization-slug', { required: true, maxLength: 64, pattern: '[a-z0-9][a-z0-9-]{0,63}' });
    const name = input('organization-name', { required: true, maxLength: 200 });
    body.append(section('新建组织', actionForm(ctx, '创建组织', [el('div', { className: 'form-grid' }, field('组织标识', id), field('组织短名称', slug), field('组织名称', name))], async () => {
      await write('/api/organizations', { id: id.value.trim(), slug: slug.value.trim(), name: name.value.trim() }, false);
      if (!ctx.signal.aborted) await ctx.refreshSession();
    }, { testid: 'create-organization' })));
  }
  if (!organizations.length) { body.append(empty('暂无可管理组织。')); return; }
  const picker = organizationPicker(ctx, organizations, 'organizations');
  if (!picker.organization) { body.append(section('选择组织', picker.node), notice('该组织不在当前可管理范围内，请重新选择。', 'warning')); return; }
  const organization = picker.organization;
  const orgPath = `/api/organizations/${enc(organization.id)}`;
  const summary = section(organization.name, picker.node,
    details([['组织标识', organization.id], ['短名称', organization.slug], ['状态', statusBadge(organization.status)]]));
  body.append(summary);
  if (principal.platformAdmin) {
    const next = organization.status === 'active' ? 'disabled' : 'active';
    summary.append(actionForm(ctx, next === 'disabled' ? '停用组织' : '恢复组织', [
      confirmation('confirm-organization-status', next === 'disabled' ? '确认停用此组织；成员与部署点访问将被拒绝。' : '确认恢复此组织。'),
    ], async () => { await write(`${orgPath}/status`, { status: next }, false); if (!ctx.signal.aborted) await ctx.refreshSession(); }, { kind: next === 'disabled' ? 'danger' : 'primary', testid: 'organization-status' }));
    const reviewerId = input('review-scope-user', { required: true, maxLength: 64 });
    const granted = select('review-scope-granted', [['true', '授予审核范围'], ['false', '撤销审核范围']], 'true');
    body.append(section('分配跨组织审核范围', notice('目标用户必须已拥有有效的审核员角色；审核范围不授予成员管理权限。'),
      actionForm(ctx, '保存审核范围', [field('审核员用户标识', reviewerId), field('范围操作', granted)], async errors => {
        await write(`${orgPath}/review-scopes`, { reviewerId: reviewerId.value.trim(), granted: granted.value === 'true' }, false);
        if (!ctx.signal.aborted) {
          errors.replaceChildren(notice('审核范围已由服务端保存。', 'success'));
          if (reviewerId.value.trim() === principal.userId) await ctx.refreshSession();
        }
      }, { testid: 'save-review-scope' })));
  }
  if (organization.status !== 'active') { body.append(notice('此组织已停用；恢复后才能管理成员、邀请和部署点。', 'warning')); return; }
  const memberArea = section('组织成员', notice('正在加载成员…'));
  const invitationList = el('div', { className: 'stack' });
  const receipt = el('div', { 'data-testid': 'invitation-receipt' });
  body.append(memberArea);
  let membersRead = 0, invitationsRead = 0;
  const refreshMembers = async () => {
    const read = ++membersRead;
    const result = await api(`${orgPath}/members`, { signal: ctx.signal });
    if (ctx.signal.aborted || read !== membersRead) return;
    memberArea.replaceChildren(el('h2', {}, '组织成员'));
    if (!result.items.length) { memberArea.append(empty('此组织暂无成员。')); return; }
    const rows = result.items.map(member => {
      const choice = rolePicker(`member-${member.userId}`, member.roles);
      const state = select(`member-status-${member.userId}`, [['active', '有效'], ['disabled', '停用']], member.status);
      const actions = el('div', { className: 'table-actions' },
        button('保存', event => {
          if (!window.confirm(`确认更新 ${member.displayName || member.userId} 的角色与成员状态？`)) return;
          void runAction(event.currentTarget, async () => {
            await write(`${orgPath}/members`, { userId: member.userId, roles: choice.value(), status: state.value }, false);
            if (ctx.signal.aborted) return;
            if (member.userId === principal.userId) await ctx.refreshSession(); else await refreshMembers();
          });
        }, { kind: 'primary', testid: `save-member-${member.userId}`, className: 'small' }));
      if (principal.platformAdmin && member.userId !== principal.userId) {
        const next = member.userStatus === 'active' ? 'disabled' : 'active';
        actions.append(button(next === 'disabled' ? '停用账号' : '恢复账号', event => {
          if (!window.confirm(next === 'disabled' ? '确认停用此用户账号并撤销其全部会话（影响所有组织）？' : '确认恢复此用户账号？')) return;
          void runAction(event.currentTarget, async () => {
            await write(`/api/users/${enc(member.userId)}/status`, { status: next }, false);
            if (!ctx.signal.aborted) await refreshMembers();
          });
        }, { kind: next === 'disabled' ? 'danger' : 'secondary', testid: `user-status-${member.userId}`, className: 'small' }));
        actions.append(button(member.developer === true ? '撤销开发者' : '授予开发者', event => {
          if (!window.confirm(`确认${member.developer === true ? '撤销' : '授予'}该账号的开发者能力（跨组织生效）？`)) return;
          void runAction(event.currentTarget, async () => {
            await write(`/api/users/${enc(member.userId)}/developer`, { developer: !(member.developer === true) }, false);
            if (!ctx.signal.aborted) await refreshMembers();
          });
        }, { kind: 'secondary', testid: `user-developer-${member.userId}`, className: 'small' }));
      }
      return [
        el('td', {}, el('div', { className: 'cell-main' }, member.displayName || member.userId), el('div', { className: 'cell-sub' }, member.userId)),
        el('td', {}, statusBadge(member.userStatus)),
        el('td', { className: 'member-roles' }, choice.node),
        el('td', {}, state),
        el('td', {}, actions),
      ];
    });
    memberArea.append(el('div', { className: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['成员', '账号', '角色', '成员状态', '操作'].map(text => el('th', { scope: 'col' }, text)))),
      el('tbody', {}, ...rows.map(cells => el('tr', {}, ...cells))))));
  };
  const refreshInvitations = async () => {
    const read = ++invitationsRead;
    const result = await api(`${orgPath}/invitations`, { signal: ctx.signal });
    if (ctx.signal.aborted || read !== invitationsRead) return;
    invitationList.replaceChildren();
    if (!result.items.length) { invitationList.append(empty('暂无邀请记录。')); return; }
    invitationList.append(table(['邀请标识', '角色', '到期时间', '状态', '操作'], result.items.map(invitation => {
      const expired = new Date(invitation.expiresAt).getTime() <= Date.now();
      const state = invitation.revokedAt ? '已撤销' : invitation.acceptedAt ? '已接受' : expired ? '已过期' : '待接受';
      const action = !invitation.revokedAt && !invitation.acceptedAt && !expired ? actionForm(ctx, '撤销邀请', [confirmation(`confirm-invitation-${invitation.id}`, '确认撤销')], async () => {
        await write(`/api/invitations/${enc(invitation.id)}/revoke`, {}, false);
        if (!ctx.signal.aborted) { clearReceipt(receipt); await refreshInvitations(); }
      }, { kind: 'danger' }) : '—';
      return [invitation.id, roleLabels(invitation.roles), formatDate(invitation.expiresAt), state, action];
    })));
  };
  const invitedRoles = rolePicker('invite-role');
  const hours = input('invitation-hours', { type: 'number', min: 1, max: 168, step: 1, value: '24', required: true });
  body.append(section('邀请新成员', notice('邀请码只返回一次；创建结果不明时请刷新元数据，撤销不明邀请后再手动创建，不会自动重试。', 'warning'),
    actionForm(ctx, '创建一次性邀请', [invitedRoles.node, field('邀请有效期（小时）', hours)], async () => {
      clearReceipt(receipt);
      const result = await write(`${orgPath}/invitations`, { roles: invitedRoles.value(), expiresInMs: Number(hours.value) * 3600000 }, false);
      if (ctx.signal.aborted) return;
      secretReceipt(ctx, receipt, '一次性邀请码', result.invitationToken, result.expiresAt);
      try { await refreshInvitations(); } catch (error) { if (!ctx.signal.aborted) showError(invitationList, error); }
    }, { testid: 'create-invitation', secretIssue: true }), receipt));
  body.append(section('邀请记录（不含邀请码）', button('刷新邀请记录', async () => { try { await refreshInvitations(); } catch (error) { if (!ctx.signal.aborted) showError(invitationList, error); } }, { kind: 'secondary' }), invitationList));
  await Promise.all([
    refreshMembers().catch(error => { if (!ctx.signal.aborted) showError(memberArea, error); }),
    refreshInvitations().catch(error => { if (!ctx.signal.aborted) showError(invitationList, error); }),
  ]);
}

async function deploymentsPage(ctx) {
  const organizations = ctx.organizations.filter(item => item.status === 'active' && isAdmin(ctx.principal, item.id));
  if (!organizations.length) return unauthorized(ctx, '没有可管理的有效组织；部署点管理要求组织管理员权限。');
  const picker = organizationPicker(ctx, organizations, 'deployments');
  ctx.root.replaceChildren(pageHeader('部署点管理', '管理独立宿主的只读机器身份；浏览器不能兑换或读取机器凭据。'), section('选择组织', picker.node));
  if (!picker.organization) { ctx.root.append(notice('所选组织不在可管理范围内。', 'warning')); return; }
  const organizationId = picker.organization.id;
  const write = requestWriter(ctx);
  const name = input('deployment-name', { required: true, maxLength: 200 });
  ctx.root.append(section('新建部署点', actionForm(ctx, '创建部署点', [field('部署点名称', name)], async () => {
    const result = await write('/api/v1/deployments', { organizationId, name: name.value.trim() });
    if (!ctx.signal.aborted) ctx.navigate(`deployments/${enc(result.id)}`);
  }, { testid: 'create-deployment' })));
  const loading = section('部署点列表', notice('正在加载部署点…'));
  ctx.root.append(loading);
  const query = pageQuery(ctx); query.set('organizationId', organizationId);
  const result = await api(`/api/v1/deployments?${query}`, { signal: ctx.signal });
  if (ctx.signal.aborted) return;
  loading.replaceChildren(el('h2', {}, '部署点列表'), result.deployments.length ? table(['名称', '状态', '状态版本', '创建时间', '操作'], result.deployments.map(point => [point.name, statusBadge(point.status), String(point.stateVersion), formatDate(point.createdAt), button('管理部署点', () => ctx.navigate(`deployments/${enc(point.id)}`), { kind: 'secondary', 'data-testid': `deployment-${point.id}` })])) : empty('此组织暂无部署点。'), pagination(ctx, 'deployments', { organizationId }, result.nextCursor));
}

async function deploymentPage(ctx, id) {
  if (!ctx.principal.platformAdmin && !ctx.principal.memberships.some(member => member.roles.includes('admin'))) return unauthorized(ctx);
  const path = `/api/v1/deployments/${enc(id)}`;
  const result = await api(path, { signal: ctx.signal });
  if (ctx.signal.aborted) return;
  const { deployment: point } = result;
  if (!isAdmin(ctx.principal, point.organizationId)) return unauthorized(ctx);
  const write = requestWriter(ctx);
  const receipt = el('div', { 'data-testid': 'binding-receipt' });
  const metadata = el('div', { className: 'stack' });
  ctx.root.replaceChildren(pageHeader(point.name, '机器凭据明文只交付宿主。此页仅显示凭据及绑定码的非敏感元数据。', button('返回部署点列表', () => ctx.navigate(paths('deployments', { organizationId: point.organizationId })), { kind: 'secondary' })),
    section('部署点身份', details([['部署点标识', point.id], ['所属组织', point.organizationId], ['状态', statusBadge(point.status)], ['状态版本', String(point.stateVersion)], ['创建时间', formatDate(point.createdAt)]])));
  if (result.center) {
    const keys = result.center.signingKeys || []
    ctx.root.append(section('中心连接信息（独立核对用）', notice('在部署点宿主的「来源设置」绑定/核对时填写以下值；请通过可信渠道核对此页与宿主两侧一致。', 'info'),
      details([['中心地址', el('code', {}, result.center.origin || '—')], ['中心 ID', el('code', {}, result.center.centerId)], ['公钥 ID', el('code', {}, keys[0]?.keyId || '—')], ['公钥指纹（SHA-256）', el('code', {}, keys[0]?.fingerprint || '—')]]),
      keys[0] ? el('details', {}, el('summary', {}, '公钥 PEM（仅 PUBLIC KEY）'), el('pre', {}, keys[0].publicKeyPem)) : null))
  }
  const next = point.status === 'active' ? 'disabled' : 'active';
  ctx.root.append(section('部署点状态', actionForm(ctx, next === 'disabled' ? '停用部署点' : '恢复部署点', [
    notice(next === 'disabled' ? '停用将同时撤销此部署点全部有效凭据与未使用的绑定码；恢复不会使旧凭据重新生效。' : '恢复后需要签发新绑定码，由宿主重新绑定。', 'warning'),
    confirmation('confirm-deployment-status', next === 'disabled' ? '确认停用部署点并撤销相关凭据。' : '确认恢复部署点。'),
  ], async () => { await write(`${path}/status`, { status: next, expectedVersion: point.stateVersion }); await reload(ctx); }, { kind: next === 'disabled' ? 'danger' : 'primary', testid: 'deployment-status' })));
  if (point.status === 'active') {
    const minutes = input('binding-minutes', { type: 'number', min: 1, max: 15, step: 1, value: '10', required: true });
    ctx.root.append(section('签发宿主绑定码', notice('签发新码会撤销此前未使用的绑定码；不会自动重试。若响应丢失，请先刷新元数据，再手动签发新码。', 'warning'),
      actionForm(ctx, '签发一次性绑定码', [field('绑定码有效期（分钟）', minutes), confirmation('confirm-binding-issue', '确认签发新绑定码并撤销旧的未使用码。')], async () => {
        clearReceipt(receipt);
        const issued = await write(`${path}/binding-codes`, { expiresInMs: Number(minutes.value) * 60000 }, false);
        if (ctx.signal.aborted) return;
        secretReceipt(ctx, receipt, '一次性宿主绑定码', issued.bindingCode, issued.expiresAt);
        try { await refreshMetadata(); } catch (error) { if (!ctx.signal.aborted) showError(metadata, error); }
      }, { testid: 'issue-binding-code', secretIssue: true }), receipt));
  }
  ctx.root.append(metadata);
  function drawMetadata(current) {
    if (ctx.signal.aborted) return;
    metadata.replaceChildren(section('凭据元数据', current.credentials.length ? table(['凭据标识', '只读范围', '到期时间', '状态', '操作'], current.credentials.map(credential => {
      const expired = credential.expiresAt && new Date(credential.expiresAt).getTime() <= Date.now();
      const active = !credential.revokedAt && !expired;
      return [credential.id, credential.scopes.map(scope => ({ 'catalog:read': '读取目录', 'release:download': '下载发布包' }[scope] || scope)).join('、'), credential.expiresAt ? formatDate(credential.expiresAt) : '无', credential.revokedAt ? '已撤销' : expired ? '已过期' : '有效', active ? actionForm(ctx, '撤销凭据', [confirmation(`revoke-credential-${credential.id}`, '确认撤销此凭据')], async () => { await write(`${path}/credentials/revoke`, { credentialId: credential.id }); await reload(ctx); }, { kind: 'danger', testid: `revoke-credential-${credential.id}` }) : '—'];
    })) : empty('尚无机器凭据。请由宿主使用绑定码完成绑定。')),
    section('绑定码元数据', current.bindingCodes.length ? table(['绑定码标识', '到期时间', '状态', '操作'], current.bindingCodes.map(code => {
      const expired = new Date(code.expiresAt).getTime() <= Date.now();
      const active = !code.revokedAt && !code.consumedAt && !expired;
      return [code.id, formatDate(code.expiresAt), code.revokedAt ? '已撤销' : code.consumedAt ? '已兑换' : expired ? '已过期' : '待兑换', active ? actionForm(ctx, '撤销绑定码', [confirmation(`revoke-binding-${code.id}`, '确认撤销此绑定码')], async () => { await write(`${path}/binding-codes/revoke`, { bindingCodeId: code.id }); await reload(ctx); }, { kind: 'danger', testid: `revoke-binding-${code.id}` }) : '—'];
    })) : empty('尚无绑定码记录。')),
    button('刷新部署点状态', () => reload(ctx), { kind: 'secondary', 'data-testid': 'refresh-deployment' }));
  }
  async function refreshMetadata() { const current = await api(path, { signal: ctx.signal }); if (!ctx.signal.aborted) drawMetadata(current); }
  drawMetadata(result);
}

function managementOrganizations(ctx) {
  const ids = new Set(ctx.organizations.filter(item => item.status === 'active' && isAdmin(ctx.principal, item.id)).map(item => item.id));
  if (isReviewer(ctx.principal)) ctx.principal.reviewScopes.forEach(id => ids.add(id));
  return [...ids].map(id => ctx.organizations.find(item => item.id === id) || { id, name: id, status: 'active' });
}
async function releasesPage(ctx) {
  const organizations = managementOrganizations(ctx);
  if (!organizations.length) return unauthorized(ctx, '发布管理需要组织管理员权限，或审核员角色及相应组织审核范围。');
  const picker = organizationPicker(ctx, organizations, 'releases');
  ctx.root.replaceChildren(pageHeader('发布管理', '查看完整发布状态，包括发布中、发布失败和已下架记录；此列表不同于可下载目录。'), section('选择组织', picker.node));
  if (!picker.organization) { ctx.root.append(notice('所选组织不在当前管理范围内。', 'warning')); return; }
  const organizationId = picker.organization.id;
  const result = await api(`/api/v1/organizations/${enc(organizationId)}/releases?${pageQuery(ctx)}`, { signal: ctx.signal });
  if (ctx.signal.aborted) return;
  ctx.root.append(section('发布记录', result.items.length ? table(['领域包', '版本', '发布状态', '分发范围', '操作'], result.items.map(release => [release.packId, release.version, statusBadge(release.status), scopeText(release.distribution.scope), button('管理发布', () => ctx.navigate(`releases/${enc(release.id)}`), { kind: 'secondary', 'data-testid': `release-${release.id}` })])) : empty('此组织暂无发布记录。'), pagination(ctx, 'releases', { organizationId }, result.nextCursor)));
}
function scopeEditor(scope) {
  const kind = select('distribution-kind', [['organization', '仅所属组织'], ['authenticated', '所有已认证用户及部署点'], ['selected', '指定组织与部署点']], scope.kind);
  const orgIds = textarea('distribution-organizations', { required: false, value: scope.kind === 'selected' ? scope.organizationIds.join('\n') : '', maxLength: 10000 });
  const deploymentIds = textarea('distribution-deployments', { required: false, value: scope.kind === 'selected' ? scope.deploymentIds.join('\n') : '', maxLength: 10000 });
  const recipients = el('div', { className: 'form-grid', hidden: kind.value !== 'selected' }, field('目标组织标识', orgIds, '每行一个标识，或以逗号分隔。'), field('目标部署点标识', deploymentIds, '至少指定一个有效组织或部署点；服务端验证授权和依赖范围。'));
  kind.addEventListener('change', () => { recipients.hidden = kind.value !== 'selected'; });
  return {
    node: el('div', { className: 'stack' }, field('新的分发范围', kind), recipients),
    value() {
      if (kind.value !== 'selected') return { kind: kind.value };
      const split = value => [...new Set(value.split(/[\s,，]+/).filter(Boolean))];
      const organizationIds = split(orgIds.value), selectedDeployments = split(deploymentIds.value);
      if (!organizationIds.length && !selectedDeployments.length) throw invalid('指定分发范围至少需要一个组织或部署点。');
      if ([...organizationIds, ...selectedDeployments].some(id => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || id.includes('..'))) throw invalid('目标标识格式不正确。');
      return { kind: 'selected', organizationIds, deploymentIds: selectedDeployments };
    },
  };
}
function requestTable(ctx, requests, organizationId) {
  return table(['申请标识', '申请人', '目标范围', '状态', '提交时间', '操作'], requests.map(request => [request.id, request.requestedBy, scopeText(request.requestedScope), statusBadge(request.status), formatDate(request.createdAt), button('查看分发申请', () => ctx.navigate(paths('distribution-reviews', { organizationId, requestId: request.id })), { kind: 'secondary', 'data-testid': `distribution-request-${request.id}` })]));
}
async function releasePage(ctx, id) {
  if (!managementOrganizations(ctx).length) return unauthorized(ctx);
  const path = `/api/v1/releases/${enc(id)}`;
  const [release, requests] = await Promise.all([api(`${path}/manage`, { signal: ctx.signal }), api(`${path}/distribution-requests?${pageQuery(ctx)}`, { signal: ctx.signal })]);
  if (ctx.signal.aborted) return;
  const write = requestWriter(ctx);
  ctx.root.replaceChildren(pageHeader(`${release.packId} · ${release.version}`, '签名清单和发布内容保持固定；下架与分发范围通过独立治理状态控制。', button('返回发布列表', () => ctx.navigate(paths('releases', { organizationId: release.ownerOrgId })), { kind: 'secondary' })),
    section('发布状态', details([['发布标识', release.id], ['所属组织', release.ownerOrgId], ['状态', statusBadge(release.status)], ['发布状态版本', String(release.stateVersion)], ['分发状态版本', String(release.distribution.stateVersion)], ['当前分发范围', scopeText(release.distribution.scope)], ['批准提交', el('a', { href: `#/submissions/${enc(release.approvedSubmissionId)}`, 'data-testid': 'approved-submission' }, release.approvedSubmissionId)], ['固定快照', release.snapshotId], ['发布时间', formatDate(release.publishedAt)], ['下架时间', formatDate(release.yankedAt)], ['下架原因', release.yankReason]])));
  const updateOut = el('div', { role: 'status' });
  ctx.root.append(section('一键更新到上游', notice('检查上游仓库是否有新提交；有则自动创建修订、校验并送审。审核仍需审核员批准。', 'info'),
    button('一键更新到上游', async event => {
      const control = event.currentTarget;
      control.disabled = true;
      updateOut.replaceChildren(el('p', {}, '正在读取来源提交…'));
      try {
        const submission = await api(`/api/submissions/${enc(release.approvedSubmissionId)}`, { signal: ctx.signal });
        const result = await runUpstreamUpdate(ctx, submission.submission ?? submission, release.approvedSubmissionId, text => updateOut.replaceChildren(el('p', {}, text)), ctx.navigate);
        if (result.kind === 'up-to-date') updateOut.replaceChildren(notice('上游与当前发布内容一致，无需更新。', 'info'));
        else if (result.kind === 'validation_failed') updateOut.replaceChildren(notice(`校验未通过（${result.status}）。`, 'warning'), button('查看新提交', () => ctx.navigate(`submissions/${enc(result.draftId)}`)));
        else updateOut.replaceChildren(notice(`已完成：新提交（v${result.version}）已进入待审核队列，等待审核员批准后自动发布。`, 'info'), button('查看新提交', () => ctx.navigate(`submissions/${enc(result.draftId)}`)));
      } catch (error) {
        if (ctx.signal.aborted) return;
        const errorCode = error?.code || error?.body?.error?.code || 'UNKNOWN';
        updateOut.replaceChildren(notice(`一键更新失败（${errorCode}）。当前发布不受影响。`, 'warning'));
      } finally { control.disabled = false; }
    }, { 'data-testid': 'release-one-click-update' }), updateOut));
  if (release.status === 'publish_failed' && isAdmin(ctx.principal, release.ownerOrgId)) {
    ctx.root.append(section('重试原批准发布', notice('重试固定的原批准快照；不会改变内容、审核决定或分发范围。'), actionForm(ctx, '重试发布', [confirmation('confirm-retry-release', '确认重试原批准快照的发布任务。')], async () => {
      await write(`/api/submissions/${enc(release.approvedSubmissionId)}/retry-publication`, { expectedReleaseVersion: release.stateVersion }); await reload(ctx);
    }, { testid: 'retry-publication' })));
  }
  if (isAdmin(ctx.principal, release.ownerOrgId) && release.status === 'published') {
    const scope = scopeEditor(release.distribution.scope);
    const reason = textarea('distribution-reason');
    ctx.root.append(section('申请变更分发范围', notice('申请不会立即改变访问范围；必须由有权限且不是申请人的审核员独立批准。'),
      actionForm(ctx, '提交分发变更申请', [scope.node, field('变更原因', reason), el('p', { className: 'muted' }, `基于分发状态版本 ${release.distribution.stateVersion}`)], async () => {
        await write(`${path}/distribution-requests`, { expectedVersion: release.distribution.stateVersion, scope: scope.value(), reason: reason.value.trim() }); await reload(ctx);
      }, { testid: 'request-distribution' })));
    const yankReason = textarea('yank-reason');
    ctx.root.append(section('下架发布', notice('下架后禁止新的目录访问与下载；不会删除已交付到宿主的本地副本。', 'warning'),
      actionForm(ctx, '确认下架发布', [field('下架原因', yankReason), confirmation('confirm-yank', '确认下架此发布。此操作不能通过本页面撤销。'), el('p', { className: 'muted' }, `基于发布状态版本 ${release.stateVersion}`)], async () => {
        await write(`${path}/yank`, { expectedVersion: release.stateVersion, reason: yankReason.value.trim() }); await reload(ctx);
      }, { kind: 'danger', testid: 'yank-release' })));
  }
  ctx.root.append(section('分发变更申请记录', requests.items.length ? requestTable(ctx, requests.items, release.ownerOrgId) : empty('暂无分发变更申请。'), pagination(ctx, `releases/${enc(id)}`, {}, requests.nextCursor)), button('刷新发布状态', () => reload(ctx), { kind: 'secondary' }));
}

async function distributionReviewsPage(ctx) {
  const requestId = ctx.query.get('requestId');
  if (requestId) return distributionRequestPage(ctx, requestId);
  const adminOrgs = ctx.principal.platformAdmin ? [] : ctx.principal.memberships
    .filter(member => member.roles.includes('admin')).map(member => member.organizationId);
  const scopeIds = [...new Set([...ctx.principal.reviewScopes, ...adminOrgs])];
  const isAdminFor = id => ctx.principal.platformAdmin || adminOrgs.includes(id);
  if (!isReviewer(ctx.principal) && !adminOrgs.length && !ctx.principal.platformAdmin) return unauthorized(ctx, '分发审核队列仅向审核员（含审核范围）或租户管理员/平台管理员开放。');
  const organizations = scopeIds.map(id => ctx.organizations.find(item => item.id === id) || { id, name: id, status: 'active' });
  const states = [['pending_review', '待审核'], ['approved', '已批准'], ['rejected', '已拒绝'], ['withdrawn', '已撤回']];
  const requestedStatus = ctx.query.get('status') || 'pending_review';
  const status = states.some(([value]) => value === requestedStatus) ? requestedStatus : 'pending_review';
  const picker = organizationPicker(ctx, organizations, 'distribution-reviews', { status });
  const state = select('distribution-review-status', states, status);
  state.addEventListener('change', () => ctx.navigate(paths('distribution-reviews', { organizationId: picker.organization?.id, status: state.value })));
  ctx.root.replaceChildren(pageHeader('分发范围审核', '依据固定申请批准或拒绝；申请人若为租户管理员或平台管理员可自批，普通审核员不能。'), section('审核队列筛选', picker.node, field('申请状态', state)));
  if (!picker.organization) { ctx.root.append(notice('所选组织不在当前审核范围内。', 'warning')); return; }
  const organizationId = picker.organization.id;
  const query = pageQuery(ctx); query.set('status', status);
  const result = await api(`/api/v1/organizations/${enc(organizationId)}/distribution-review-queue?${query}`, { signal: ctx.signal });
  if (ctx.signal.aborted) return;
  ctx.root.append(section('分发审核队列', result.items.length ? requestTable(ctx, result.items, organizationId) : empty('当前筛选条件下没有分发申请。'), pagination(ctx, 'distribution-reviews', { organizationId, status }, result.nextCursor)));
}
async function distributionRequestPage(ctx, requestId) {
  const request = await api(`/api/v1/distribution-requests/${enc(requestId)}`, { signal: ctx.signal });
  if (ctx.signal.aborted) return;
  const release = await api(`/api/v1/releases/${enc(request.releaseId)}/manage`, { signal: ctx.signal });
  if (ctx.signal.aborted) return;
  const write = requestWriter(ctx);
  ctx.root.replaceChildren(pageHeader('分发申请详情', '审核决定仅针对以下固定申请；版本发生变化时必须刷新后重新判断。', button('返回发布管理', () => ctx.navigate(`releases/${enc(release.id)}`), { kind: 'secondary' })),
    section('固定申请', details([['申请标识', request.id], ['领域包', `${release.packId} · ${release.version}`], ['所属组织', release.ownerOrgId], ['申请人', request.requestedBy], ['申请原因', request.reason], ['申请范围', scopeText(request.requestedScope)], ['当前范围', scopeText(release.distribution.scope)], ['申请状态', statusBadge(request.status)], ['申请状态版本', String(request.stateVersion)], ['申请所依据的分发版本', String(request.expectedDistributionVersion)], ['当前分发版本', String(release.distribution.stateVersion)], ['提交时间', formatDate(request.createdAt)], ['审核人', request.reviewedBy], ['审核意见', request.comment], ['审核时间', formatDate(request.reviewedAt)]])));
  if (request.status !== 'pending_review') { ctx.root.append(notice('此申请已结束，不能再次审核。')); return; }
  // Policy parity with submission self-review: platform admins and the owning
  // tenant's admin may self-approve; the server re-checks both conditions.
  const isPlatform = ctx.principal.platformAdmin;
  const isOwnerTenantAdmin = ctx.principal.memberships.some(member => member.organizationId === release.ownerOrgId && member.roles.includes('admin'));
  const selfReviewer = request.requestedBy === ctx.principal.userId;
  if (selfReviewer && !isPlatform && !isOwnerTenantAdmin) { ctx.root.append(notice('禁止自审：您是此申请的申请人，且不具备平台管理员/所属租户管理员身份，请由另一位有权限的审核员处理。', 'warning')); return; }
  if (!selfReviewer && !isPlatform && !isOwnerTenantAdmin && !canReview(ctx.principal, release.ownerOrgId)) { ctx.root.append(notice('您可以查看此申请，但没有该组织的独立审核权限。', 'warning')); return; }
  const stale = request.expectedDistributionVersion !== release.distribution.stateVersion;
  if (stale) ctx.root.append(notice('当前分发版本已变化，此申请不能批准；可拒绝并说明原因。', 'warning'));
  for (const [decision, label] of [['approved', '批准分发变更'], ['rejected', '拒绝分发变更']]) {
    if (decision === 'approved' && (stale || release.status !== 'published')) continue;
    const comment = textarea(`distribution-comment-${decision}`);
    ctx.root.append(section(label, actionForm(ctx, label, [field('审核意见（必填）', comment), confirmation(`confirm-distribution-${decision}`, `确认${decision === 'approved' ? '批准并应用' : '拒绝'}这份固定分发申请。`)], async () => {
      await write(`/api/v1/distribution-requests/${enc(request.id)}/review`, { expectedVersion: request.stateVersion, decision, comment: comment.value.trim() }); await reload(ctx);
    }, { kind: decision === 'approved' ? 'primary' : 'danger', testid: `distribution-${decision}` })));
  }
  ctx.root.append(button('刷新申请状态', () => reload(ctx), { kind: 'secondary' }));
}


async function visibilityPage(ctx) {
  const principal = ctx.principal;
  if (!principal.platformAdmin && !principal.memberships.length) return unauthorized(ctx);
  const picker = organizationPicker(ctx, ctx.organizations, 'visibility');
  if (!picker.organization) return unauthorized(ctx, '没有可查看的组织。');
  const organizationId = picker.organization.id;
  const write = requestWriter(ctx);
  const body = el('div', { className: 'stack' }, notice('正在加载可见性授权…'));
  ctx.root.replaceChildren(pageHeader('可见性授权', '租户分发授权：决定本组织的人类成员和部署点能额外看到哪些已发布领域包。授权是加宽，不改变发布本身的分发范围。'),
    section('选择组织', picker.node), body);
  const grant = await api(`/api/organizations/${enc(organizationId)}/pack-visibility`, { signal: ctx.signal });
  const current = grant
    ? el('p', {}, '当前授权：', el('strong', {}, grant.scope === 'all' ? '全部已发布包' : '白名单'), grant.scope === 'list' ? `（${(grant.packIds || []).join('、') || '空'}）` : '')
    : el('p', {}, '当前没有生效授权。');
  const holder = el('div');
  body.replaceChildren(section('当前授权', current, holder));
  if (!principal.platformAdmin) {
    holder.append(notice('仅平台管理员可以修改授权；此处为只读视图。', 'info'));
    return;
  }
  const kind = select('visibility-scope', [['all', '全部已发布包'], ['list', '白名单（逐包列出）']], grant?.scope ?? 'all');
  const packs = textarea('visibility-packs', { rows: 5, placeholder: '每行一个包标识，如 demo.alpha' });
  packs.required = false;
  const listGrid = el('div', { className: 'form-grid', hidden: kind.value !== 'list' }, field('包白名单', packs, '每行一个包标识；必须是中心已存在的包。'));
  kind.addEventListener('change', () => { listGrid.hidden = kind.value !== 'list'; });
  holder.append(section('设置授权', el('form', { className: 'stack' },
    field('授权范围', kind), listGrid,
    button('保存授权', async event => {
      event.preventDefault();
      const scope = kind.value;
      const packIds = scope === 'list' ? packs.value.split(/[\s,，]+/).map(value => value.trim()).filter(Boolean) : [];
      if (scope === 'list' && !packIds.length) throw invalid('白名单授权至少需要一个包标识。');
      await write('/api/pack-visibility', { organizationId, scope, ...(scope === 'list' ? { packIds } : {}) });
      if (!ctx.signal.aborted) await reload(ctx);
    }, { kind: 'primary', type: 'button', 'data-testid': 'save-visibility' }))),
    section('撤销授权', el('form', { className: 'stack' },
      confirmation('confirm-visibility-disable', '确认撤销该组织的可见性授权；撤销后其成员与部署点立即失去额外可见范围（已缓存副本不受影响）。'),
      button('撤销授权', async event => {
        event.preventDefault();
        await write(`/api/organizations/${enc(organizationId)}/pack-visibility/disable`, {});
        if (!ctx.signal.aborted) await reload(ctx);
      }, { kind: 'secondary', type: 'button', 'data-testid': 'disable-visibility' }))));
}


// Permission center: account-level functional grants (platform / developer /
// status) are managed here, separate from data grants (pack ownerships,
// tenant memberships, review scopes, visibility).
async function accountsPage(ctx) {
  const principal = ctx.principal;
  if (!principal.platformAdmin) return unauthorized(ctx, '账号与角色管理仅限平台管理员。');
  const write = requestWriter(ctx);
  const root = el('div', { className: 'admin-page stack' });
  ctx.root.replaceChildren(pageHeader('账号与角色（权限中心）', '默认列出全部账号。点「权限」展开：左侧按导航功能勾选授权，右侧为底层数据权限明细。所有变更记入审计日志。'), root);
  const stats = el('p', { className: 'muted' });
  const searchInput = input('account-search', { maxLength: 100, placeholder: '显示名或用户标识' });
  const results = el('div', { className: 'stack' }, empty('正在加载账号…'));
  root.append(section('账号列表', el('div', { className: 'toolbar' }, stats,
    el('form', { className: 'inline-form' }, searchInput,
      button('搜索', event => { event.preventDefault(); currentQuery = searchInput.value.trim(); void runAction(event.currentTarget, () => loadUsers()); },
        { kind: 'primary', type: 'button', testid: 'account-search-submit' }))), results));
  let currentQuery = '';
  const expanded = new Map(); // userId -> detail container refetch trigger
  const roleOrder = ['admin', 'reviewer', 'member'];
  const cleanRoles = values => roleOrder.filter(role => values.includes(role));
  const toggleRole = (roles, role) => {
    const set = new Set(roles); set.has(role) ? set.delete(role) : set.add(role);
    return cleanRoles([...set].length ? [...set] : ['member']);
  };
  const checkbox = (text, checked, onChange, testid) => {
    const box = el('input', { type: 'checkbox' }); box.checked = checked;
    if (testid) box.dataset.testid = testid;
    box.addEventListener('change', onChange);
    return el('label', { className: 'perm-check' }, box, ` ${text}`);
  };
  // Run one permission change: confirm -> write -> refresh panel and list.
  async function applyChange(user, confirmText, fn, errors) {
    if (confirmText && !window.confirm(confirmText)) { await refreshPanel(user); return; }
    try { await fn(); } catch (error) { if (!ctx.signal.aborted) showError(errors, error); }
    if (!ctx.signal.aborted) { await refreshPanel(user); await loadUsers(); }
  }
  const membershipWrite = (user, membership, roles, status, errors) => applyChange(user,
    `确认更新 ${user.displayName || user.userId} 在 ${membership.organizationName || membership.organizationId} 的角色与状态？`,
    () => write(`/api/organizations/${enc(membership.organizationId)}/members`, { userId: user.userId, roles, status }, false), errors);
  function renderPanel(user, holder, errors) {
    const result = holder.result;
    const memberships = result.memberships;
    const scopes = new Map(result.reviewScopes.map(item => [item.organizationId, item]));
    // ---- left: functional view over left-nav capabilities ----
    const fnBox = (text, checked, run, testid) => checkbox(text, checked,
      () => applyChange(user, `确认${checked ? '取消' : '勾选'}「${text.split('（')[0]}」？底层授权将同步变更。`, run, errors), testid);
    const functional = el('div', { className: 'stack' },
      notice('勾选 = 授予；取消 = 撤销。与右侧数据权限是同一份数据的功能视角。'),
      checkbox('我的提交（开发者能力）', user.developer,
        () => applyChange(user, `确认${user.developer ? '撤销' : '授予'}开发者能力？（影响创建包与持有包协作角色）`,
          () => write(`/api/users/${enc(user.userId)}/developer`, { developer: !user.developer }, false), errors),
        `fn-developer-${user.userId}`));
    if (user.userId !== principal.userId) {
      functional.append(checkbox('平台管理员（账号与角色 · 审计日志 · 全部管理功能）', user.platformAdmin,
        () => applyChange(user, `确认${user.platformAdmin ? '撤销' : '授予'}平台管理员身份？（可管理全部账号、组织与授权）`,
          () => write(`/api/users/${enc(user.userId)}/platform-admin`, { platformAdmin: !user.platformAdmin }, false), errors),
        `fn-platform-admin-${user.userId}`));
    } else functional.append(checkbox('平台管理员（本人，不可在此修改）', true, () => { }, ''));
    if (!memberships.length) functional.append(empty('尚未加入任何组织；可在右侧「加入组织」直接拉入。'));
    for (const membership of memberships) {
      const orgName = membership.organizationName || membership.organizationId;
      const roles = membership.roles;
      functional.append(el('div', { className: 'perm-org' },
        el('strong', {}, orgName),
        checkbox('审核队列 · 发布管理（审核员）', roles.includes('reviewer'),
          () => applyChange(user, `确认${roles.includes('reviewer') ? '撤销' : '授予'} ${orgName} 审核员角色？`,
            () => membershipWrite(user, membership, toggleRole(roles, 'reviewer'), membership.status, errors))),
        checkbox('部署点 · 组织管理（管理员）', roles.includes('admin'),
          () => applyChange(user, `确认${roles.includes('admin') ? '撤销' : '授予'} ${orgName} 管理员角色？（可管理该组织成员与授权）`,
            () => membershipWrite(user, membership, toggleRole(roles, 'admin'), membership.status, errors))),
        checkbox('分发审核（跨组织审核范围）', scopes.has(membership.organizationId),
          () => applyChange(user, `确认${scopes.has(membership.organizationId) ? '撤销' : '授予'} ${orgName} 的审核范围？`,
            () => write(`/api/organizations/${enc(membership.organizationId)}/review-scopes`,
              { reviewerId: user.userId, granted: !scopes.has(membership.organizationId) }, false), errors))));
    }
    // ---- right: underlying data permissions ----
    const data = el('div', { className: 'stack' });
    const membershipArea = el('div', { className: 'stack' });
    for (const membership of memberships) {
      const choice = rolePicker(`perm-${user.userId}-${membership.organizationId}`, membership.roles);
      const state = select(`perm-status-${user.userId}-${membership.organizationId}`, [['active', '有效'], ['disabled', '停用']], membership.status);
      membershipArea.append(el('div', { className: 'perm-org-row' },
        el('div', {}, el('strong', {}, membership.organizationName || membership.organizationId), ` · ${roleLabels(membership.roles)}`),
        choice.node,
        el('div', { className: 'table-actions' }, state,
          button('保存', event => {
            void runAction(event.currentTarget, () => membershipWrite(user, membership, choice.value(), state.value, errors));
          }, { kind: 'primary', className: 'small', testid: `perm-save-${user.userId}-${membership.organizationId}` }))));
    }
    if (!memberships.length) membershipArea.append(empty('无组织成员资格。'));
    const orgOptions = ctx.organizations.filter(item => item.status === 'active').map(item => [item.id, item.name || item.id]);
    const addOrgPicker = select(`perm-add-org-${user.userId}`, [['', '选择组织…'], ...orgOptions]);
    const addOrgRoles = rolePicker(`perm-add-org-roles-${user.userId}`, ['member']);
    const addOrg = el('div', { className: 'stack' }, el('h3', {}, '加入组织'),
      el('div', { className: 'table-actions' }, addOrgPicker, addOrgRoles.node,
        button('加入', event => {
          const organizationId = addOrgPicker.value;
          if (!organizationId) return;
          void runAction(event.currentTarget, () => applyChange(user,
            `确认将 ${user.displayName || user.userId} 加入 ${organizationId}（${roleLabels(addOrgRoles.value())}）？`,
            () => write(`/api/organizations/${enc(organizationId)}/members`, { userId: user.userId, roles: addOrgRoles.value(), status: 'active' }, false), errors));
        }, { kind: 'primary', className: 'small', testid: `perm-join-${user.userId}` })));
    const packArea = el('div', { className: 'stack' });
    for (const packRole of result.packRoles) {
      const roleSelect = select(`perm-pack-${user.userId}-${packRole.packId}`, [['owner', 'Owner'], ['maintainer', 'Maintainer']], packRole.role);
      packArea.append(el('div', { className: 'table-actions' },
        el('span', {}, `${packRole.packName || packRole.packId}`), roleSelect,
        button('应用', event => {
          void runAction(event.currentTarget, () => applyChange(user,
            `确认将 ${user.displayName || user.userId} 在 ${packRole.packName || packRole.packId} 的协作角色改为 ${roleSelect.value}？（需要你持有该包 Owner 角色）`,
            () => write(`/api/packs/${enc(packRole.packId)}/owners`, { userId: user.userId, role: roleSelect.value }, false), errors));
        }, { kind: 'secondary', className: 'small' }),
        button('移除', event => {
          void runAction(event.currentTarget, () => applyChange(user,
            `确认移除 ${user.displayName || user.userId} 对 ${packRole.packName || packRole.packId} 的协作角色？`,
            () => write(`/api/packs/${enc(packRole.packId)}/owners/${enc(user.userId)}`, {}, false), errors));
        }, { kind: 'danger', className: 'small' })));
    }
    if (!result.packRoles.length) packArea.append(empty('无包协作角色。'));
    packArea.append(notice('修改包协作需要你本人持有对应包的 Owner 角色；否则会提示无权限。', 'warning'));
    data.append(
      el('h3', {}, '组织成员资格'), membershipArea,
      packOrgSection('包协作', packArea),
      addOrg,
      el('p', {}, el('a', { href: '#/visibility' }, '包可见性授权（按组织配置）→')));
    holder.replaceChildren(el('div', { className: 'two-columns' },
      section('功能权限', functional), section('数据权限', data)));
  }
  function packOrgSection(title, ...children) { return el('div', { className: 'stack' }, el('h3', {}, title), ...children); }
  async function refreshPanel(user) {
    const entry = expanded.get(user.userId);
    if (!entry || ctx.signal.aborted) return;
    try {
      const result = await api(`/api/users/${enc(user.userId)}/permissions`, { signal: ctx.signal });
      if (ctx.signal.aborted) return;
      entry.holder.result = result;
      renderPanel(user, entry.holder, entry.errors);
    } catch (error) { if (!ctx.signal.aborted) showError(entry.errors, error); }
  }
  function detailRow(user) {
    const holder = el('div', {}, empty('正在加载权限…'));
    const errors = el('div', { role: 'alert' });
    expanded.set(user.userId, { holder, errors });
    void refreshPanel(user);
    return el('tr', { className: 'detail-row' }, el('td', { colSpan: 6 }, errors, holder));
  }
  let nextCursor;
  async function loadUsers(beforeId) {
    const params = new URLSearchParams({ limit: '50' });
    if (currentQuery) params.set('query', currentQuery);
    if (beforeId) params.set('beforeId', beforeId);
    const result = await api(`/api/users?${params}`, { signal: ctx.signal });
    if (ctx.signal.aborted) return;
    const items = result.items;
    nextCursor = items.length >= 50 ? String(items.at(-1).userId) : undefined;
    stats.replaceChildren(`账号（本页 ${items.length}）· 平台管理员 ${items.filter(item => item.platformAdmin).length} · 开发者 ${items.filter(item => item.developer).length}`);
    const rows = [];
    for (const user of items) {
      const self = user.userId === principal.userId;
      const summary = [user.platformAdmin ? '平台管理员' : null, user.developer ? '开发者' : null].filter(Boolean).join(' · ') || '—';
      const actions = el('div', { className: 'table-actions' });
      actions.append(button(expanded.has(user.userId) ? '收起' : '权限', () => {
        expanded.has(user.userId) ? expanded.delete(user.userId) : expanded.set(user.userId, {});
        void loadUsers();
      }, { kind: 'secondary', testid: `account-permissions-${user.userId}`, className: 'small' }));
      if (!self && !user.platformAdmin) {
        const nextStatus = user.status === 'active' ? 'disabled' : 'active';
        actions.append(button(nextStatus === 'disabled' ? '停用' : '恢复', event => {
          if (!window.confirm(nextStatus === 'disabled' ? '确认停用此账号并撤销其全部会话？' : '确认恢复此账号？')) return;
          void runAction(event.currentTarget, async () => {
            await write(`/api/users/${enc(user.userId)}/status`, { status: nextStatus }, false);
            if (!ctx.signal.aborted) await loadUsers();
          });
        }, { kind: nextStatus === 'disabled' ? 'danger' : 'secondary', testid: `account-status-${user.userId}`, className: 'small' }));
      }
      rows.push(el('tr', {},
        el('td', {}, el('div', { className: 'cell-main' }, user.displayName || user.userId), el('div', { className: 'cell-sub' }, user.userId)),
        el('td', {}, statusBadge(user.status)),
        el('td', {}, summary),
        el('td', {}, `${user.tenants} 组织 · ${user.packs ?? 0} 包`),
        el('td', {}, formatDate(user.createdAt)),
        el('td', {}, actions)));
      if (expanded.has(user.userId)) rows.push(detailRow(user));
    }
    results.replaceChildren(el('div', { className: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['账号', '状态', '功能权限', '数据权限', '创建时间', '操作'].map(text => el('th', { scope: 'col' }, text)))),
      el('tbody', {}, ...rows.length ? rows : [el('tr', {}, el('td', { colSpan: 6 }, '没有匹配账号。'))]))));
    if (nextCursor) results.append(button('下一页', () => void loadUsers(nextCursor), { kind: 'secondary', testid: 'next-page' }));
  }
  await loadUsers();
}

// Read-only platform-wide audit trail. Who did what to which object, when —
// the permission center's answer to "这个授权是谁在什么时候给的".
async function auditPage(ctx) {
  const principal = ctx.principal;
  if (!principal.platformAdmin) return unauthorized(ctx, '审计日志仅限平台管理员查看。');
  const body = el('div', { className: 'stack' }, empty('正在加载审计日志…'));
  ctx.root.replaceChildren(pageHeader('审计日志', '平台范围内的权限与治理操作留痕，按时间倒序。'), body);
  const actorInput = input('audit-actor', { maxLength: 64, placeholder: '按操作者用户标识过滤（可留空）' });
  const errors = el('div', { role: 'alert' });
  const list = el('div', { className: 'stack' });
  let nextCursor;
  async function load(beforeId) {
    const params = new URLSearchParams({ limit: '50' });
    if (actorInput.value.trim()) params.set('actorId', actorInput.value.trim());
    if (beforeId) params.set('beforeId', beforeId);
    const result = await api(`/api/audit?${params}`, { signal: ctx.signal });
    if (ctx.signal.aborted) return;
    nextCursor = result.items.length >= 50 ? String(result.items.at(-1).id) : undefined;
    if (!beforeId) list.replaceChildren();
    if (!result.items.length && !beforeId) { list.append(empty('没有匹配的审计事件。')); return; }
    for (const event of result.items) {
      list.append(section(`${event.action}`,
        details([['时间', formatDate(event.createdAt)], ['操作者', `${event.actorName || '—'}（${event.actorId}）`],
          ['对象', `${event.objectKind}:${event.objectId}`], ['组织', event.organizationName || event.organizationId || '—'],
          ['结果', event.outcome === 'succeeded' ? '成功' : event.outcome === 'denied' ? '被拒绝' : '失败']])));
    }
  }
  body.append(section('过滤', el('form', { className: 'stack' }, field('操作者', actorInput),
    button('查询', event => { event.preventDefault(); void runAction(event.currentTarget, () => load(''), errors); }, { kind: 'primary', type: 'button', testid: 'audit-search' })), errors));
  body.append(list);
  const more = el('div', { className: 'toolbar' });
  body.append(more);
  const originalLoad = load;
  load = async beforeId => { await originalLoad(beforeId); more.replaceChildren(); if (nextCursor) more.append(button('下一页', () => void load(nextCursor), { kind: 'secondary' })); };
  await load('');
}

export async function renderAdmin(original) {
  activeRenders.get(original.root)?.();
  const cleanups = [];
  const controller = new AbortController();
  let active = true;
  const clean = () => {
    active = false;
    controller.abort();
    original.signal.removeEventListener('abort', clean);
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
  activeRenders.set(original.root, clean);
  original.signal.addEventListener('abort', clean, { once: true });
  const ctx = { ...original, base: original, signal: controller.signal, onCleanup(callback) { if (active) cleanups.push(callback); else callback(); } };
  if (original.signal.aborted) { clean(); return; }
  ctx.root.replaceChildren(notice('正在加载管理数据…'));
  try {
    if (ctx.route === 'organizations') await organizationsPage(ctx);
    else if (ctx.route === 'deployments') await deploymentsPage(ctx);
    else if (/^deployments\/[^/]+$/.test(ctx.route)) await deploymentPage(ctx, decodeURIComponent(ctx.route.split('/')[1]));
    else if (ctx.route === 'releases') await releasesPage(ctx);
    else if (/^releases\/[^/]+$/.test(ctx.route)) await releasePage(ctx, decodeURIComponent(ctx.route.split('/')[1]));
    else if (ctx.route === 'distribution-reviews') await distributionReviewsPage(ctx);
    else if (ctx.route === 'visibility') await visibilityPage(ctx);
    else if (ctx.route === 'accounts') await accountsPage(ctx);
    else if (ctx.route === 'audit') await auditPage(ctx);
    else ctx.root.replaceChildren(pageHeader('管理页面不存在', '请使用导航返回有效页面。'));
    if (!ctx.signal.aborted && active && [...pendingWrites.values()].some(write => write.userId === ctx.principal.userId)) {
      ctx.root.prepend(notice(unconfirmedWriteNotice, 'warning'));
    }
  } catch (error) {
    if (!ctx.signal.aborted && active) {
      const errors = el('div');
      ctx.root.replaceChildren(pageHeader('管理数据加载失败', '未用示例数据替代真实结果。请检查会话和访问权限，或重试读取。'), errors);
      showError(errors, error);
      ctx.root.append(button('重新加载', () => reload(ctx), { kind: 'secondary' }));
    }
  }
}
