import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CustomerWebSearchPolicyStore, registerCustomerWebSearchTool } from '../lib/host/customer-web-search.js'

test('customer web search asks once, persists the decision, and blocks denied or private queries', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-search-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const policies = new CustomerWebSearchPolicyStore(join(dir, 'policy.sqlite'))
  t.after(() => policies.close())
  const tools = new Map()
  let asked = 0, sent = 0
  const credentials = { resolve: async ref => ref === 'DEEPSEEK_API_KEY' ? { value: 'proxy-key' } : undefined }
  const ctx = { tools: { register: definition => { tools.set(definition.name, definition) } },
    get: name => name === 'credentials' ? credentials : undefined }
  const questions = { ask: async (_id, items) => {
    asked++
    assert.equal(items[0].id, 'web_search_permission')
    assert.match(items[0].detail, /公开政策/)
    return { answers: [{ selected: ['开启本会话联网搜索'] }] }
  } }
  registerCustomerWebSearchTool(ctx, join(dir, 'workspace'), questions, policies)
  const tool = tools.get('customer_web_search')
  const fetchTool = tools.get('customer_web_fetch')
  const sessionId = 'session-11111111-1111-4111-8111-111111111111'
  const exec = { agent: { session: { header: { id: sessionId, cwd: join(dir, 'workspace'), origin: 'user' } } },
    signal: new AbortController().signal }
  const oldFetch = globalThis.fetch, oldBase = process.env.DEEPSEEK_BASE_URL
  process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:3190'
  globalThis.fetch = async (url, init) => {
    sent++
    assert.equal(init.headers.authorization, 'Bearer proxy-key')
    if (String(url).endsWith('/fetch')) {
      assert.equal(JSON.parse(init.body).url, 'https://example.com/policy')
      return Response.json({ title: '政策原文', content: '正文', truncated: false })
    }
    assert.equal(String(url), 'http://127.0.0.1:3190/v1/tools/search')
    assert.equal(JSON.parse(init.body).need_content, false)
    return Response.json({ results: [{ title: '政策原文', url: 'https://example.com/policy', summary: '摘要', date: '2026-10-28' }] })
  }
  t.after(() => { globalThis.fetch = oldFetch; if (oldBase === undefined) delete process.env.DEEPSEEK_BASE_URL; else process.env.DEEPSEEK_BASE_URL = oldBase })
  const first = await tool.execute({ query: '公开政策' }, exec)
  assert.equal(first.enabled, true)
  assert.equal(first.results[0].url, 'https://example.com/policy')
  assert.deepEqual([asked, sent, policies.get(sessionId)], [1, 1, 'on'])
  await tool.execute({ query: '其他公开政策' }, exec)
  assert.deepEqual([asked, sent], [1, 2])
  const fetched = await fetchTool.execute({ url: 'https://example.com/policy' }, exec)
  assert.equal(fetched.content, '正文')
  assert.deepEqual([asked, sent], [1, 3])
  await assert.rejects(fetchTool.execute({ url: 'http://127.0.0.1/private' }, exec), /INVALID_PUBLIC_FETCH_URL/)
  policies.set(sessionId, 'off')
  assert.equal((await tool.execute({ query: '公开政策' }, exec)).enabled, false)
  assert.equal((await fetchTool.execute({ url: 'https://example.com/policy' }, exec)).enabled, false)
  assert.equal(sent, 3)
  await assert.rejects(tool.execute({ query: '某人手机号 13800138000' }, exec), /INVALID_PUBLIC_SEARCH_QUERY/)
  assert.equal(sent, 3)
})
