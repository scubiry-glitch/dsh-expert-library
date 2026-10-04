/** Small synthetic craft bundle; no network, business data, or report history. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
export const craftBinding = Object.freeze({ id: 'zhijian-report-craft-core-v1', md: 'report.md', html: 'report.html', pdf: 'report.pdf' })
export const craftMarkdown = `# Synthetic craft fixture

## 第一章 分析

This synthetic chapter explains a choice, its boundary, and a later check.

## 总结

The choice, boundary, and later check remain separate decisions.

> 收束金句：先说明边界，再作出选择。

## 来源披露

- Wind：未采用。
- zyt：待补，本轮未调用。
- beike：未配置，本轮未采用。
`
export const craftHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic fixture</title>
<style>body { color: #222; background: white; } blockquote { border-left: 3px solid #176a58; }</style></head><body>
<h1>Synthetic craft fixture</h1><h2>第一章 分析</h2><p>This synthetic chapter explains a choice, its boundary, and a later check.</p>
<h2>总结</h2><p>The choice, boundary, and later check remain separate decisions.</p><blockquote>收束金句：先说明边界，再作出选择。</blockquote>
<h2>来源披露</h2><ul><li>Wind：未采用。</li><li>zyt：待补，本轮未调用。</li><li>beike：未配置，本轮未采用。</li></ul></body></html>`
const PDF_FIXTURE = String.raw`
import sys, sysconfig, json, base64
for key in ('purelib','platlib'):
    p=sysconfig.get_path(key)
    if p and p not in sys.path: sys.path.append(p)
import fitz
options=json.load(sys.stdin)
doc=fitz.open()
body_pages=options.get('bodyPages',2)
for i in range(body_pages+2):
    page=doc.new_page(width=595,height=842)
    if i==0: page.insert_text((60,80),'Synthetic report cover',fontsize=20)
    elif i==body_pages+1: page.insert_text((60,80),'Synthetic report back cover',fontsize=20)
    else:
        heading=options.get('chapterTitle','第一章 分析') if i==1 else '总结'
        page.insert_text((60,80),heading,fontname='china-s',fontsize=16)
        page.insert_text((60,110),'Synthetic analysis; no external or business data.',fontsize=11)
        footer=options.get('brand','98wiki')+' | '
        if options.get('chineseNumber'):
            footer+='第'+str(i)+'页 / 共'+str(body_pages)+'页'
        else: footer+=str(i)+'/'+str(options.get('wrongTotal',body_pages))
        if not options.get('missingFooter'):
            page.insert_text((60,815 if not options.get('numberInBody') else 140),footer,fontname='china-s',fontsize=10)
    if options.get('numberedCovers') and i in (0,body_pages+1):
        page.insert_text((60,25 if options.get('numberInHeader') else 815),'Page '+str(i+1),fontsize=10)
if not options.get('missingOutline'):
    doc.set_toc([[1,'wrong chapter' if options.get('wrongOutline') else options.get('chapterTitle','第一章 分析'),2],[1,'总结',min(3,len(doc)-1)]])
print(base64.b64encode(doc.tobytes()).decode())
`
export function createCraftPdf(options = {}) {
  const p = spawnSync('python3', ['-I', '-c', PDF_FIXTURE], { input: JSON.stringify(options), encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, shell: false })
  if (p.status !== 0 || p.error) throw new Error(`Synthetic PDF fixture unavailable: ${p.error?.code ?? p.status}; ${p.stderr?.slice(-500)}`)
  return Buffer.from(p.stdout.trim(), 'base64')
}
export function craftArtifact(id, bytes, extra = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8')
  return { id, taskId: 'craft-fixture', attempt: 1, path: `/unreadable-by-design/${id}`, sha256: createHash('sha256').update(buffer).digest('hex'), encoding: 'base64', content: buffer.toString('base64'), ...extra }
}
export function createCraftFixture(options = {}) {
  const md = options.md ?? craftMarkdown
  const html = options.html ?? craftHtml
  const pdf = options.pdf ?? createCraftPdf(options.pdfOptions)
  return { binding: { ...craftBinding }, md, html, pdf, artifacts: [craftArtifact('report.md', md), craftArtifact('report.html', html), craftArtifact('report.pdf', pdf)] }
}
