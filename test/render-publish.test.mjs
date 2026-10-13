import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerRenderPublishTool } from '../lib/host/render-publish.js'

test('render_publish isolates a tenant, serves HTML and PDF, and rejects symlink escapes', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'render-publish-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const workspace = join(scratch, 'workspace')
  const publicDir = join(scratch, 'public')
  await mkdir(workspace)
  await mkdir(publicDir)
  const oldDir = process.env.DSH_RENDER_PUBLIC_DIR
  const oldBase = process.env.DSH_RENDER_PUBLIC_BASE
  process.env.DSH_RENDER_PUBLIC_DIR = publicDir
  process.env.DSH_RENDER_PUBLIC_BASE = 'https://example.test/render/tenants/c'
  t.after(() => {
    if (oldDir === undefined) delete process.env.DSH_RENDER_PUBLIC_DIR
    else process.env.DSH_RENDER_PUBLIC_DIR = oldDir
    if (oldBase === undefined) delete process.env.DSH_RENDER_PUBLIC_BASE
    else process.env.DSH_RENDER_PUBLIC_BASE = oldBase
  })

  let tool
  registerRenderPublishTool({ tools: { register(value) { tool = value } } })
  assert.ok(tool)
  const exec = { agent: { session: { header: { cwd: workspace } } } }
  await writeFile(join(workspace, 'report.html'), '<h1>Public report</h1>')
  const html = await tool.execute({ teamId: 'project', file: 'report.html', slug: 'brief' }, exec)
  assert.equal(html.url, 'https://example.test/render/tenants/c/project/brief.html')
  assert.equal(await readFile(html.file, 'utf8'), '<h1>Public report</h1>')

  await writeFile(join(workspace, 'report.pdf'), Buffer.from('%PDF-1.7\nexample'))
  const pdf = await tool.execute({ teamId: 'project', file: 'report.pdf', slug: 'brief' }, exec)
  assert.equal(pdf.url, 'https://example.test/render/tenants/c/project/brief.pdf')
  assert.equal((await readFile(pdf.file)).toString(), '%PDF-1.7\nexample')

  const outside = join(scratch, 'private.html')
  await writeFile(outside, '<h1>private</h1>')
  await symlink(outside, join(workspace, 'escape.html'))
  await assert.rejects(() => tool.execute({ teamId: 'project', file: 'escape.html' }, exec), /会话工作区内/)
  await assert.rejects(() => tool.execute({ teamId: '../other', html: 'bad' }, exec), /teamId 非法/)
})
