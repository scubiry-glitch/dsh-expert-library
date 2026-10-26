import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDshGateway } from '../dsh-gateway.mjs'

test('DSH connector selects only the configured account instance and its token file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'portal-gateway-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'a.token'), 'a'.repeat(48), { mode: 0o600 })
  await writeFile(join(dir, 'b.token'), 'b'.repeat(48), { mode: 0o600 })
  const config = { gatewayTokenDir: dir, dshBackends: { a: 'http://127.0.0.1:3101', b: 'http://127.0.0.1:3102' } }
  const calls = []
  const gateway = createDshGateway(config, async (url, options) => {
    calls.push({ url: url.href, auth: options.headers.authorization, redirect: options.redirect })
    return { ok: true, json: async () => ({ accepted: true }) }
  })
  await gateway.sendMessage({ backendRef: 'a', origin: config.dshBackends.a }, 'session-abc', 'first', 'request-123')
  await gateway.uploadAttachment({ backendRef: 'a', origin: config.dshBackends.a }, 'session-abc', 'notes.txt', 'aGVsbG8=')
  await gateway.removeAttachment({ backendRef: 'a', origin: config.dshBackends.a }, 'session-abc', 'customer-uploads/session-abc/stored.txt')
  await gateway.sendMessage({ backendRef: 'b', origin: config.dshBackends.b }, 'session-def', 'second', 'request-456')
  await gateway.mentions({ backendRef: 'a', origin: config.dshBackends.a })
  await gateway.activityBatch({ backendRef: 'a', origin: config.dshBackends.a }, ['session-abc'])
  await gateway.conversation({ backendRef: 'a', origin: config.dshBackends.a }, 'session-abc', -1, true)
  await gateway.conversation({ backendRef: 'a', origin: config.dshBackends.a }, 'session-abc', -1, true, 42)
  assert.deepEqual(calls.map(call => [call.url, call.auth, call.redirect]), [
    ['http://127.0.0.1:3101/plugins/dsh-expert-library/customer-gateway/sessions/session-abc/messages', `Bearer ${'a'.repeat(48)}`, 'manual'],
    ['http://127.0.0.1:3101/plugins/dsh-expert-library/customer-gateway/sessions/session-abc/attachments', `Bearer ${'a'.repeat(48)}`, 'manual'],
    ['http://127.0.0.1:3101/plugins/dsh-expert-library/customer-gateway/sessions/session-abc/attachments', `Bearer ${'a'.repeat(48)}`, 'manual'],
    ['http://127.0.0.1:3102/plugins/dsh-expert-library/customer-gateway/sessions/session-def/messages', `Bearer ${'b'.repeat(48)}`, 'manual'],
    ['http://127.0.0.1:3101/plugins/dsh-expert-library/customer-gateway/mentions', `Bearer ${'a'.repeat(48)}`, 'manual'],
    ['http://127.0.0.1:3101/plugins/dsh-expert-library/customer-gateway/sessions/activity-batch', `Bearer ${'a'.repeat(48)}`, 'manual'],
    ['http://127.0.0.1:3101/plugins/dsh-expert-library/customer-gateway/sessions/session-abc/messages?after=-1&latest=1', `Bearer ${'a'.repeat(48)}`, 'manual'],
    ['http://127.0.0.1:3101/plugins/dsh-expert-library/customer-gateway/sessions/session-abc/messages?after=-1&latest=1&before=42', `Bearer ${'a'.repeat(48)}`, 'manual'],
  ])
  await assert.rejects(gateway.createSession({ backendRef: '../b', origin: config.dshBackends.a }, 'session-abc'))
  await assert.rejects(gateway.createSession({ backendRef: 'a', origin: config.dshBackends.b }, 'session-abc'))
  assert.equal(calls.length, 8)
})
