import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeCustomerUpload, saveCustomerUpload } from '../src/host/customer-uploads.ts'

test('customer attachment stays under its session and rejects unsafe names and symlinked upload directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'customer-uploads-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const session = 'session-11111111-1111-4111-8111-111111111111'
  const uploaded = await saveCustomerUpload(root, session, '研究资料.txt', Buffer.from('hello').toString('base64'))
  assert.match(uploaded.path, /^customer-uploads\/session-11111111-1111-4111-8111-111111111111\/[0-9a-f-]+-研究资料\.txt$/)
  assert.equal(await readFile(join(root, uploaded.path), 'utf8'), 'hello')
  await assert.rejects(removeCustomerUpload(root, 'session-22222222-2222-4222-8222-222222222222', uploaded.path))
  await removeCustomerUpload(root, session, uploaded.path)
  await assert.rejects(readFile(join(root, uploaded.path)))
  await assert.rejects(saveCustomerUpload(root, session, '../secret.txt', 'aGVsbG8='))
  await assert.rejects(saveCustomerUpload(root, session, 'script.exe', 'aGVsbG8='))
  const other = 'session-22222222-2222-4222-8222-222222222222'
  await symlink(root, join(root, 'customer-uploads', other))
  await assert.rejects(saveCustomerUpload(root, other, 'notes.txt', 'aGVsbG8='))
})
