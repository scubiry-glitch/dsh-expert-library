import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createCraftV2Fixture, rebuildCraftV2Fixture } from './support/report-craft-v2-fixture.mjs'
import { evaluateReportCraftV2 } from '../domain-packs/.zhijian-realestate-v15-src/checks/report-craft-checker-v2.mjs'

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
d=fitz.open();d.new_page().insert_text((40,70),'Synthetic report cover',fontsize=16)
page=d.new_page(width=595,height=842)
font=TTFont('/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',fontNumber=0)
subset=Subsetter();subset.populate(text=txt);subset.subset(font);buffer=io.BytesIO();font.save(buffer)
page.insert_font(fontname='report',fontbuffer=buffer.getvalue())
if page.insert_textbox(fitz.Rect(40,40,555,710),txt,fontname='report',fontsize=10,lineheight=1.4)<0:raise ValueError('overflow')
page.insert_text((40,810),'98wiki | 1/1',fontsize=10)
d.new_page().insert_text((40,70),'Synthetic report back',fontsize=16)
d.set_toc([[1,h.get_text(),2] for h in s.find_all('h2')]);print(base64.b64encode(d.tobytes(deflate=True,garbage=4)).decode())
`
function figureFixture() {
  const fixture = createCraftV2Fixture()
  const fragments = '<aside class="fig" data-chapter="第一章 定价"><p>目标回报率为2.0%。</p></aside>'
  fixture.html = fixture.html.replace('<section id="chapter-1">', '<section id="chapter-1" data-report-chapter="第一章 定价">')
  fixture.html = fixture.html.replace('</section><h2>总结</h2>', `${fragments}</section><h2>总结</h2>`)
  const rendered = spawnSync('python3', ['-I', '-c', PDF], { input: JSON.stringify({ html: fixture.html }), encoding: 'utf8', timeout: 30000 })
  assert.equal(rendered.status, 0, rendered.stderr)
  fixture.pdf = Buffer.from(rendered.stdout.trim(), 'base64')
  fixture.evidence.schemaVersion = 3
  fixture.evidence.policyClaims = []
  fixture.evidence.figureLayer = { fragmentsHtml: fragments, sha256: sha(fragments), chapters: ['第一章 定价'] }
  return rebuildCraftV2Fixture(fixture)
}
const run = fixture => evaluateReportCraftV2(fixture.artifacts, fixture.check, { browserExecutablePath: '/no-browser-for-bounded-test' })

test('v1.5.0 F4 accepts an authenticated figure layer and full HTML/PDF parity', async () => {
  const results = await run(figureFixture())
  assert.equal(results.find(result => result.id === 'report-craft-format-consistency')?.status, 'passed', JSON.stringify(results))
})

test('v1.5.0 F4 rejects a figure omitted from PDF', async () => {
  const fixture = figureFixture()
  fixture.pdf = createCraftV2Fixture().pdf
  rebuildCraftV2Fixture(fixture)
  const results = await run(fixture)
  assert.equal(results.find(result => result.id === 'report-craft-format-consistency')?.status, 'failed')
})

test('v1.5.0 rejects a changed figure fragment hash', async () => {
  const fixture = figureFixture()
  fixture.evidence.figureLayer.sha256 = '0'.repeat(64)
  rebuildCraftV2Fixture(fixture)
  const results = await run(fixture)
  assert.equal(results.find(result => result.id === 'report-craft-format-consistency')?.status, 'failed')
})
