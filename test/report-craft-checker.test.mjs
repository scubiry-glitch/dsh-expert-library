import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createCraftFixture, craftArtifact, craftMarkdown, craftHtml, createCraftPdf } from './support/report-craft-fixture.mjs'
const { evaluateReportCraft } = await import(process.env.REPORT_CRAFT_CHECKER_MODULE ?? '../lib/report-craft-checker.js')
const IDs = ['report-craft-source-disclosure', 'report-craft-closing-structure', 'report-craft-pdf-structure']
let good
try { good = createCraftFixture() } catch (error) { throw new Error(`These offline checker tests require existing fitz fixture support: ${error.message}`) }
async function check(options={}) {
  const f = createCraftFixture({ pdf: good.pdf, ...options })
  const result = await evaluateReportCraft(f.artifacts, f.binding)
  assert.deepEqual(result.map(x=>x.id),IDs)
  return result
}

test('valid small immutable bundle passes three partial checks, without reading paths or enforcing recommended page count', async()=>{
  const result=await check()
  assert.deepEqual(result.map(x=>x.status),['passed','passed','passed'])
  assert.match(result[1].detail,/Does not judge semantic/)
  assert.match(result[2].detail,/No 20–25-page requirement/)
})
test('Chinese footer numbering and 智见 brand pass',async()=>{
  const result=await check({pdf:createCraftPdf({bodyPages:1,brand:'智见',chineseNumber:true})})
  assert.equal(result[2].status,'passed',result[2].detail)
})
test('99wiki brand passes',async()=>{
  assert.equal((await check({pdf:createCraftPdf({brand:'99wiki'})}))[2].status,'passed')
})
test('primary channel label accepts Beike ZYT attribution and comparison with another source',async()=>{
  const md=craftMarkdown.replace('zyt：待补，本轮未调用。','政研通 zyt（贝壳政研通口径）：仅趋势性结论，与 Wind 不同。')
  const html=craftHtml.replace('zyt：待补，本轮未调用。','政研通 zyt（贝壳政研通口径）：仅趋势性结论，与 Wind 不同。')
  assert.equal((await check({md,html}))[0].status,'passed')
})
test('table first-cell channel labels allow later comparison sources',async()=>{
  const md=craftMarkdown.replace('- Wind：未采用。','| Wind | 未采用，计划与 zyt 比较 |')
  const html=craftHtml.replace('<li>Wind：未采用。</li>','<table><tr><td>Wind</td><td>未采用，计划与 zyt 比较</td></tr></table>')
  assert.equal((await check({md,html}))[0].status,'passed')
})
test('unnumbered descriptive h2 chapters remain valid outline targets',async()=>{
  const chapterTitle='从信息到判断'
  const result=await check({md:craftMarkdown.replace('第一章 分析',chapterTitle),html:craftHtml.replace('第一章 分析',chapterTitle),pdf:createCraftPdf({chapterTitle})})
  assert.equal(result[2].status,'passed',result[2].detail)
})
test('Wind only in observation list does not satisfy channel disclosure',async()=>{
  const md=craftMarkdown.replace('- Wind：未采用。','')+'\n## 观察清单\n\n- Wind：待补。\n'
  const result=await check({md})
  assert.equal(result[0].status,'failed'); assert.match(result[0].detail,/MD: missing channel status: Wind/)
})
test('a channel mention without a status is not disclosure',async()=>{
  const result=await check({html:craftHtml.replace('Wind：未采用。','Wind CLI channel')})
  assert.equal(result[0].status,'failed'); assert.match(result[0].detail,/HTML: missing channel status: Wind/)
})
test('HTML hidden/script/comment/code text cannot fake missing Wind disclosure',async()=>{
  for (const replacement of ['<span hidden>Wind：未采用。</span>','<span style="display:none">Wind：未采用。</span>','<span aria-hidden="true">Wind：未采用。</span>','<script>Wind：未采用。</script>','<!--Wind：未采用。-->','<code>Wind：未采用。</code>']) {
    const result=await check({html:craftHtml.replace('Wind：未采用。',replacement)})
    assert.equal(result[0].status,'failed',replacement)
  }
})
test('simple CSS display:none class cannot fake disclosure',async()=>{
  const html=craftHtml.replace('</style>','.concealed{display:none}</style>').replace('Wind：未采用。','<span class="concealed">Wind：未采用。</span>')
  assert.equal((await check({html}))[0].status,'failed')
})
test('normal styling/opacity does not prevent basic static extraction',async()=>{
  const html=craftHtml.replace('Wind：未采用。','<span style="opacity:0.7;color:#333">Wind：未采用。</span>')
  assert.equal((await check({html}))[0].status,'passed')
})
test('one collective row is not three per-channel status rows',async()=>{
  const md=craftMarkdown.replace(/- Wind：[\s\S]*/,'- Wind / zyt / beike：未采用。\n')
  assert.equal((await check({md}))[0].status,'failed')
})
test('Markdown fenced examples and comments do not fake source disclosure',async()=>{
  const md=craftMarkdown.replace('- Wind：未采用。','<!-- Wind：未采用。 -->\n```text\nWind：未采用。\n```')
  assert.equal((await check({md}))[0].status,'failed')
})
test('raw hidden HTML blocks inside Markdown cannot supply disclosure',async()=>{
  const md=craftMarkdown.replace('- Wind：未采用。','<div hidden>\nWind：未采用。\n</div>')
  assert.equal((await check({md}))[0].status,'failed')
})
test('nested observation subsection cannot masquerade as source disclosure',async()=>{
  const md=craftMarkdown.replace('- Wind：未采用。','')+'\n### 观察清单\n\n#### 待补来源\n\nWind：待补。\n'
  assert.equal((await check({md}))[0].status,'failed')
})
test('closing heading alone and quotes alone cannot claim summary structure',async()=>{
  assert.equal((await check({md:craftMarkdown.replace('The choice, boundary, and later check remain separate decisions.','')}))[1].status,'failed')
  assert.equal((await check({html:craftHtml.replace('<p>The choice, boundary, and later check remain separate decisions.</p>','')}))[1].status,'failed')
})
test('missing closing quote fails even with nonempty summary',async()=>{
  assert.equal((await check({md:craftMarkdown.replace('> 收束金句：先说明边界，再作出选择。','')}))[1].status,'failed')
})
test('chapter-opening quote does not substitute for closing section',async()=>{
  const md=craftMarkdown.replace('## 总结','## 第二章 后续分析')
  assert.equal((await check({md}))[1].status,'failed')
})
test('explicit closing quote label is accepted without prescribing renderer',async()=>{
  const md=craftMarkdown.replace('> 收束金句：','收束金句：')
  const html=craftHtml.replace('<blockquote>收束金句：','<p>收束金句：').replace('作出选择。</blockquote>','作出选择。</p>')
  assert.equal((await check({md,html}))[1].status,'passed')
})
test('later analysis means the earlier summary is not a closing summary',async()=>{
  const md=craftMarkdown.replace('## 来源披露','## 第二章 新的分析\n\nMore analysis.\n\n## 来源披露')
  assert.equal((await check({md}))[1].status,'failed')
})
test('PDF body text cannot substitute for physical footer brand and numbering',async()=>{
  const result=await check({pdf:createCraftPdf({numberInBody:true})})
  assert.equal(result[2].status,'failed'); assert.match(result[2].detail,/missing footer/)
})
test('PDF wrong body total fails',async()=>{
  const result=await check({pdf:createCraftPdf({wrongTotal:4})})
  assert.equal(result[2].status,'failed'); assert.match(result[2].detail,/missing footer 1\/2/)
})
test('numbered covers fail',async()=>{
  const result=await check({pdf:createCraftPdf({numberedCovers:true})})
  assert.equal(result[2].status,'failed'); assert.match(result[2].detail,/cover page 1/)
})
test('cover header page numbering also fails',async()=>{
  const result=await check({pdf:createCraftPdf({numberedCovers:true,numberInHeader:true})})
  assert.equal(result[2].status,'failed'); assert.match(result[2].detail,/cover page 1/)
})
test('missing/wrong outline fails instead of counting raw PDF tokens',async()=>{
  for (const pdfOptions of [{missingOutline:true},{wrongOutline:true}]) {
    const result=await check({pdf:createCraftPdf(pdfOptions)})
    assert.equal(result[2].status,'failed'); assert.match(result[2].detail,/outline/)
  }
})
test('damaged PDF fails without losing independent text findings',async()=>{
  const result=await check({pdf:Buffer.from('%PDF-1.7\nnot a PDF')})
  assert.deepEqual(result.map(x=>x.status),['passed','passed','failed'])
  assert.match(result[2].detail,/Malformed/)
})
test('hash mismatch and duplicate id never borrow unrelated content or filesystem paths',async()=>{
  const f=createCraftFixture({pdf:good.pdf})
  const changed=f.artifacts.map(a=>a.id==='report.md'?{...a,content:Buffer.from('changed').toString('base64')}:a)
  assert.ok((await evaluateReportCraft(changed,f.binding)).every(x=>x.status==='failed'))
  assert.ok((await evaluateReportCraft([...f.artifacts,f.artifacts[0]],f.binding)).every(x=>x.status==='failed'))
})
test('input size bound is explicit and no subprocess is needed',async()=>{
  const f=createCraftFixture({pdf:good.pdf,md:'x'.repeat(2*1024*1024+1)})
  const result=await evaluateReportCraft(f.artifacts,f.binding)
  assert.ok(result.every(x=>x.status==='failed'))
  assert.match(result[0].detail,/size limit/)
})
test('missing interpreter reports unverified, not passed',async()=>{
  const saved=process.env.PATH
  try {
    process.env.PATH='/nonexistent-report-craft-test-bin'
    assert.ok((await evaluateReportCraft(good.artifacts,good.binding)).every(x=>x.status==='unverified'))
  } finally { process.env.PATH=saved }
})
test('isolated Python without fitz/pypdf leaves PDF unverified and text checks intact',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'craft-no-dependencies-'))
  const python=spawnSync('python3',['-I','-c','import sys; print(sys.executable)'],{encoding:'utf8'}).stdout.trim()
  const created=spawnSync(python,['-I','-m','venv','--without-pip',directory],{encoding:'utf8',timeout:10_000})
  assert.equal(created.status,0,created.stderr)
  const saved=process.env.PATH
  try {
    process.env.PATH=join(directory,'bin')
    const result=await evaluateReportCraft(good.artifacts,good.binding)
    assert.deepEqual(result.map(x=>x.status),['passed','passed','unverified'])
    assert.match(result[2].detail,/dependency unavailable/)
  } finally { process.env.PATH=saved; await rm(directory,{recursive:true,force:true}) }
})
// Explicit opt-in uses only the already sealed, owned r8 immutable bundle.
// No report bytes are copied into fixtures/source or read from mutable output.
test('owned r8 immutable negative artifacts demonstrate all three actual failures',{skip:!process.env.REPORT_CRAFT_REAL_AUDIT},async()=>{
  const receipt=JSON.parse(await readFile(process.env.REPORT_CRAFT_REAL_AUDIT,'utf8'))
  const artifacts=await Promise.all(['md','html','pdf'].map(async extension=>{
    const row=receipt.artifacts.find(a=>a.path.endsWith(`report.${extension}`))
    const artifact=craftArtifact(`report.${extension}`,await readFile(row.path))
    assert.equal(artifact.sha256,row.sha256,'sealed immutable artifact must not drift')
    return artifact
  }))
  const result=await evaluateReportCraft(artifacts,good.binding)
  assert.deepEqual(result.map(x=>x.status),['failed','failed','failed'])
  assert.match(result[0].detail,/Wind/)
  assert.match(result[1].detail,/closing-summary heading/)
  assert.match(result[2].detail,/footer|cover/)
  console.log(JSON.stringify({kind:'owned-r8-negative-craft-result',sha256s:artifacts.map(a=>({id:a.id,sha256:a.sha256})),results:result}))
})
