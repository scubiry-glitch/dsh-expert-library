import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountStore } from '../account-store.mjs'
import { resolveAccountBackend } from '../backend-routing.mjs'

test('two customer accounts cannot read or bind each other\'s sessions', () => {
  const store = new AccountStore()
  try {
    const a = store.provisionAccount({ slug: 'customer-a' })
    const b = store.provisionAccount({ slug: 'customer-b' })
    store.bindWorkspace(a, 'workspace-a')
    store.bindWorkspace(b, 'workspace-b')
    store.bindBackend(a, 'customer-a')
    store.bindBackend(b, 'customer-b')
    assert.throws(() => store.bindBackend(b, 'customer-a'))
    assert.throws(() => store.bindWorkspace(b, 'workspace-a'))
    const userA = store.provisionMember({ accountId: a, issuer: 'https://issuer.test', subject: 'a', displayName: 'A' })
    store.provisionMember({ accountId: b, issuer: 'https://issuer.test', subject: 'b', displayName: 'B' })
    assert.equal(store.issueBrowserSession({ issuer: 'https://issuer.test', subject: 'a', accountId: b }), undefined)
    const loginA = store.issueBrowserSession({ issuer: 'https://issuer.test', subject: 'a', accountId: a })
    const loginB = store.issueBrowserSession({ issuer: 'https://issuer.test', subject: 'b', accountId: b })
    assert.equal(store.resolveBrowserSession(loginA.token).workspaceId, 'workspace-a')
    const routing = { dshBackends: { 'customer-a': 'http://127.0.0.1:3101', 'customer-b': 'http://127.0.0.1:3102' }, researchEnabledBackends: ['customer-a', 'customer-b'] }
    assert.deepEqual(resolveAccountBackend(store.resolveBrowserSession(loginA.token), routing),
      { origin: 'http://127.0.0.1:3101', backendRef: 'customer-a', workspaceId: 'workspace-a' })
    assert.deepEqual(resolveAccountBackend(store.resolveBrowserSession(loginB.token), routing),
      { origin: 'http://127.0.0.1:3102', backendRef: 'customer-b', workspaceId: 'workspace-b' })
    assert.throws(() => resolveAccountBackend(store.resolveBrowserSession(loginA.token), { ...routing, researchEnabledBackends: ['customer-b'] }))
    assert.equal(store.verifyCsrf(loginA.token, loginB.csrf), false)
    assert.equal(store.verifyCsrf(loginA.token, loginA.csrf), true)
    const rowA = store.createResearchSession({ principal: loginA.principal, requestId: 'request-1' })
    assert.equal(store.createResearchSession({ principal: loginA.principal, requestId: 'request-1' }).id, rowA.id)
    assert.deepEqual(store.listResearchSessions(loginA.principal), [])
    store.bindDshSession(loginA.principal, rowA.id, 'dsh-session-a')
    assert.equal(store.listResearchSessions(loginA.principal).length, 1)
    assert.equal(store.getResearchSession(loginB.principal, rowA.id), undefined)
    assert.deepEqual(store.listResearchSessions(loginB.principal), [])
    assert.throws(() => store.bindDshSession(loginB.principal, rowA.id, 'dsh-session-b'))
    const rowB = store.createResearchSession({ principal: loginB.principal, requestId: 'request-1' })
    assert.notEqual(rowB.id, rowA.id)
    assert.throws(() => store.bindDshSession(loginB.principal, rowB.id, 'dsh-session-a'))
    store.setMembershipActive(a, userA, false)
    assert.equal(store.resolveBrowserSession(loginA.token), undefined)
    assert.equal(store.getResearchSession(loginA.principal, rowA.id), undefined)
    assert.equal(store.verifyCsrf(loginA.token, loginA.csrf), false)
  } finally { store.close() }
})

test('identity linking is explicit and rollback leaves no partial member', () => {
  const store = new AccountStore()
  try {
    const account = store.provisionAccount({ slug: 'first' })
    store.provisionMember({ accountId: account, issuer: 'https://issuer.test', subject: 'same', displayName: 'Known User' })
    assert.throws(() => store.provisionMember({ accountId: account, issuer: 'https://issuer.test', subject: 'same', displayName: 'Another Name' }))
    assert.equal(store.issueBrowserSession({ issuer: 'https://issuer.test', subject: 'unlinked', accountId: account }), undefined)
    store.recordPendingIdentity({ issuer: 'https://issuer.test', subject: 'unlinked', displayName: 'Pending' })
    assert.equal(store.listPendingIdentities().length, 1)
    store.provisionMember({ accountId: account, issuer: 'https://issuer.test', subject: 'unlinked', displayName: 'Pending' })
    assert.equal(store.listPendingIdentities().length, 0)
  } finally { store.close() }
})

test('runtime provisioning is atomic and prevents two customers sharing a backend', () => {
  const store = new AccountStore()
  try {
    assert.throws(() => store.provisionCustomerAccount({ slug: 'unsafe', workspaceId: 'work-unsafe', backendRef: 'default' }))
    store.provisionCustomerAccount({ slug: 'first', workspaceId: 'work-first', backendRef: 'backend-first' })
    assert.throws(() => store.provisionCustomerAccount({ slug: 'second', workspaceId: 'work-second', backendRef: 'backend-first' }))
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM accounts').get().count, 1)
    assert.throws(() => resolveAccountBackend({ accountId: 'legacy', workspaceId: 'work-legacy', backendRef: 'default' },
      { dshBackends: { default: 'http://127.0.0.1:3080' } }))
  } finally { store.close() }
})

test('session groups are account scoped and deleting a group keeps its sessions', () => {
  const store = new AccountStore()
  try {
    const a = store.provisionAccount({ slug: 'group-a' })
    const b = store.provisionAccount({ slug: 'group-b' })
    store.provisionMember({ accountId: a, issuer: 'https://issuer.test', subject: 'a', displayName: 'A' })
    store.provisionMember({ accountId: b, issuer: 'https://issuer.test', subject: 'b', displayName: 'B' })
    const principalA = store.issueBrowserSession({ issuer: 'https://issuer.test', subject: 'a', accountId: a }).principal
    const principalB = store.issueBrowserSession({ issuer: 'https://issuer.test', subject: 'b', accountId: b }).principal
    const session = store.createResearchSession({ principal: principalA, requestId: 'group-session' })
    store.bindDshSession(principalA, session.id, 'dsh-group-session')
    const group = store.createSessionGroup(principalA, '市场研究')
    assert.deepEqual(store.listSessionGroups(principalB), [])
    assert.equal(store.renameSessionGroup(principalB, group.id, '越权'), false)
    assert.throws(() => store.updateSessionPreference(principalA, session.id, { groupId: 'not-a-group' }))
    store.updateSessionPreference(principalA, session.id, { groupId: group.id })
    assert.equal(store.sessionPreference(principalA, session.id).groupId, group.id)
    assert.equal(store.deleteSessionGroup(principalB, group.id), false)
    assert.equal(store.renameSessionGroup(principalA, group.id, '行业研究'), true)
    assert.equal(store.listSessionGroups(principalA)[0].name, '行业研究')
    assert.equal(store.deleteSessionGroup(principalA, group.id), true)
    assert.equal(store.sessionPreference(principalA, session.id).groupId, null)
    assert.equal(store.listResearchSessions(principalA).length, 1)
  } finally { store.close() }
})
