/** Offline five-chapter fixture for the isolated Stage 3 Host path. No business claims. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const sha = value => createHash('sha256').update(value).digest('hex')
const PDF = String.raw`
import sys,sysconfig,json,base64,io
for key in ('purelib','platlib'):
 p=sysconfig.get_path(key)
 if p and p not in sys.path:sys.path.append(p)
from bs4 import BeautifulSoup
from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter
import fitz
p=json.load(sys.stdin);s=BeautifulSoup(p['html'],'html.parser');txt=s.select_one('main#report-body').get_text(' ',strip=True)
d=fitz.open();d.new_page(width=595,height=842).insert_text((40,70),'Synthetic report cover',fontsize=16)
page=d.new_page(width=595,height=842)
font=TTFont('/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',fontNumber=0)
subset=Subsetter();subset.populate(text=txt);subset.subset(font);b=io.BytesIO();font.save(b)
page.insert_font(fontname='report',fontbuffer=b.getvalue())
if page.insert_textbox(fitz.Rect(40,40,555,710),txt,fontname='report',fontsize=10,lineheight=1.4)<0:raise ValueError('fixture PDF overflow')
page.insert_text((40,810),'98wiki | 1/1',fontsize=10)
d.new_page(width=595,height=842).insert_text((40,70),'Synthetic report back',fontsize=16)
d.set_toc([[1,h.get_text(),2] for h in s.find_all('h2')]);print(base64.b64encode(d.tobytes(deflate=True,garbage=4)).decode())
`
const esc = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const strong = s => esc(s).replace(/^\*\*(.*?)\*\*/u, '<strong>$1</strong>')
const span = (markdown, htmlId) => ({ markdown, htmlId })

export function createDeepResearchStage3Fixture(names) {
  assert.equal(names.length, 5)
  const rows = names.map((name, index) => {
    const parts = {
      position: `> 章眼金句：${name}先查证据再作判断。`,
      roles: `**角色对照**：${name}供给方与需求方分别核对条件。`,
      basis: `**事实依据**：${name}，S1 与 S2 仅作隔离合成标签。`,
      inference: `**推论与数据**：${name}暂无可证数值，保留条件判断。`,
      opportunity: `**机会**：${name}观察政策与成交的共振信号。`,
      risk: `**风险**：${name}若证据缺失则撤回判断。`,
    }
    const figure = `<aside class="fig" data-chapter="${esc(name)}"><p>${esc(parts.position.slice(2))}</p></aside>`
    const id = `ch${index + 1}`
    const html = `<section id="${id}" data-report-chapter="${esc(name)}"><h2>${esc(name)}</h2><blockquote id="${id}-quote"><p>${esc(parts.position.slice(2))}</p></blockquote><p id="${id}-roles">${strong(parts.roles)}</p><p id="${id}-basis">${strong(parts.basis)}</p><p id="${id}-inference">${strong(parts.inference)}</p><p id="${id}-opportunity">${strong(parts.opportunity)}</p><p id="${id}-risk">${strong(parts.risk)}</p>${figure}</section>`
    const craft = { heading: name, htmlId: id, parts: { quote: span(parts.position, `${id}-quote`), roles: span(parts.roles, `${id}-roles`), basis: span(parts.basis, `${id}-basis`), inference: span(parts.inference, `${id}-inference`), opportunityRisk: { opportunity: span(parts.opportunity, `${id}-opportunity`), risk: span(parts.risk, `${id}-risk`) } } }
    return { name, parts, figure, html, craft }
  })
  const md = '# 98wiki 合成研究验收报告\n\n## 卷首速览\n本轮只验证结构，不作为业务研究结论。\n\n## 总论\n本轮只验证结构、来源和审阅门控。\n\n'
    + rows.map(row => `## ${row.name}\n\n${Object.values(row.parts).join('\n\n')}\n`).join('\n')
    + '\n## 总结与行动\n本轮结论只适用于隔离 Host 测试。\n\n> 收束金句：没有真实数据就不能下业务结论。\n\n## 来源披露\n- Wind：未调用。\n- 政研通：通道失败。\n- 贝壳：未调用。\n'
  const fragments = rows.map(row => row.figure).join('\n')
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html{background:#f7f5ed;color:#24352d}body{margin:0;font:16px/1.6 sans-serif}main{box-sizing:border-box;max-width:920px;margin:auto;padding:32px 22px}section{margin:28px 0}h1,h2{line-height:1.3}blockquote{border-left:3px solid #275b43;padding:4px 14px;margin:12px 0}.fig{background:#e4ece3;border:1px solid #526b57;padding:12px;margin:16px 0}p{margin:10px 0}@media print{body{background:white;color:#222}main{max-width:none;padding:0}}</style></head><body><main id="report-body"><h1>98wiki 合成研究验收报告</h1><h2>卷首速览</h2><p>本轮只验证结构，不作为业务研究结论。</p><h2>总论</h2><p>本轮只验证结构、来源和审阅门控。</p>'
    + rows.map(row => row.html).join('')
    + '<h2>总结与行动</h2><p>本轮结论只适用于隔离 Host 测试。</p><blockquote><p>收束金句：没有真实数据就不能下业务结论。</p></blockquote><h2>来源披露</h2><ul><li>Wind：未调用。</li><li>政研通：通道失败。</li><li>贝壳：未调用。</li></ul></main></body></html>'
  const built = spawnSync('python3', ['-I', '-c', PDF], { input: JSON.stringify({ html }), encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 })
  assert.equal(built.status, 0, built.stderr)
  const pdf = Buffer.from(built.stdout.trim(), 'base64')
  const craftEvidence = { schemaVersion: 3, reportSha256: { md: sha(md), html: sha(html), pdf: sha(pdf) }, body: { htmlId: 'report-body' }, chapters: rows.map(row => row.craft), calculations: [], policyClaims: [], figureLayer: { fragmentsHtml: fragments, sha256: sha(fragments), chapters: names } }
  const figureSpec = '```json figure-spec\n' + JSON.stringify({ figures: rows.map(row => ({ chapter: row.name, selector: '.fig', claim: row.parts.position.slice(2), sourceQuote: row.parts.position, data: [] })) }) + '\n```'
  return { names, rows, md, html, pdf, fragments, figureSpec, craftEvidence, craftText: JSON.stringify(craftEvidence), sha256: sha }
}
