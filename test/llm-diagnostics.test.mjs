import test from 'node:test'
import assert from 'node:assert/strict'
import { extensionFailureDiagnostic } from '../src/host/llm-diagnostics.ts'

test('request extension diagnostics retain the cause chain and redact credentials', () => {
  const cause = Object.assign(new Error('EACCES reading https://packs.example/x?token=secret and Bearer abcdefghijklmnopqrstuvwxyz123456'),
    { code: 'EACCES', syscall: 'open', path: '/tenant/private/inventory.json' })
  const failure = Object.assign(new Error('DeepSeek request extension preparation failed', { cause }), { code: 'REQUEST_EXTENSION' })
  const result = extensionFailureDiagnostic(failure, ['dsh_plugin_packages', 'dsh_session_log'])
  assert.deepEqual(result.fields, ['dsh_plugin_packages', 'dsh_session_log'])
  assert.equal(result.causes[1].code, 'EACCES')
  assert.equal(result.causes[1].path, 'inventory.json')
  assert.equal(JSON.stringify(result).includes('abcdefghijklmnopqrstuvwxyz123456'), false)
  assert.equal(JSON.stringify(result).includes('https://packs.example'), false)
  assert.equal(extensionFailureDiagnostic(new Error('unrelated')), undefined)
})
