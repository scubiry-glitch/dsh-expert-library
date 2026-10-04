import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, symlinkSync, unlinkSync, lstatSync } from 'node:fs'
const source = process.env.DSH_CRAFT_V2_SOURCE === '1'
const { evaluateReportCraftV2, REPORT_CRAFT_V2_CHECKER_VERSION, REPORT_CRAFT_V2_DEFAULT_BROWSER } = await import(source ? '../src/report-craft-checker-v2.ts' : '../lib/report-craft-checker-v2.js')
const browserPath = process.env.DSH_CRAFT_QA_BROWSER ?? REPORT_CRAFT_V2_DEFAULT_BROWSER
const browserOptions = { browserExecutablePath: browserPath }
const noBrowser = { browserExecutablePath: '/nonexistent/controlled-craft-browser' }
import { createCraftV2Fixture as fixture, rebuildCraftV2Fixture as bundle } from './support/report-craft-v2-fixture.mjs'
const hash = b => createHash('sha256').update(b).digest('hex')
function artifact(id,bytes){const b=Buffer.from(bytes);return{id,taskId:'synthetic-report',attempt:1,path:'/never-read/'+id,sha256:hash(b),encoding:'base64',content:b.toString('base64')}}
function find(r,id){const row=r.find(x=>x.id==='report-craft-'+id);assert.ok(row);return row}
async function run(f,opts=noBrowser){return evaluateReportCraftV2(f.artifacts,f.check,opts)}

test('v2 checker identity is fixed and independent of the ledger',()=>{assert.equal(REPORT_CRAFT_V2_CHECKER_VERSION,'report-craft-v2.2')})
for (const style of ['credit-policy','designer-paper']) test('actual MD HTML PDF and real offline browser pass for '+style,{skip:!existsSync(browserPath)},async()=>{
 const r=await run(fixture({style}),browserOptions);assert.equal(r.length,7);assert.ok(r.every(x=>x.status==='passed'),JSON.stringify(r))
 const b=JSON.parse(find(r,'browser').detail);assert.deepEqual(b.metrics.map(x=>x.viewport),[1280,375]);assert.deepEqual(b.blockedRequestSchemes,[]);assert.equal(b.screenshots.length,2)
 for(const shot of b.screenshots){assert.ok(shot.path.startsWith('/root/.cache/dsh-report-craft/evidence/'));assert.equal(lstatSync(shot.path).isSymbolicLink(),false);const png=readFileSync(shot.path);assert.equal(hash(png),shot.viewportScreenshotSha256);assert.equal(png.length,shot.bytes);assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(shot.height,900);assert.match(shot.coverage,/initial viewport only/);assert.equal(shot.browserSha256,b.browserSha256)}
})
test('R9 F1 gold small text and pale disclaimer fail actual AA in both viewports',{skip:!existsSync(browserPath)},async()=>{
 const r=await run(fixture({css:'#yield-base{color:#a9741f;background:white;font-size:16px}#ch1-risk{color:#8a9994;background:white;font-size:10px}'}),browserOptions)
 assert.equal(find(r,'browser').status,'failed');const b=JSON.parse(find(r,'browser').detail);assert.ok(b.metrics.every(x=>x.aaFailureCount>=2))
})
test('R9 F2 inverse range with mixed -18/+11 baseline fails real arithmetic',async()=>{
 const r=await run(fixture({wrongCalculation:true}));assert.equal(find(r,'calculations').status,'failed');assert.match(find(r,'calculations').detail,/-9\.0909091|common base/)
 assert.equal(find(r,'format-consistency').status,'passed','Cross-format equality is not arithmetic correctness')
})
test('R9 F3 chapter without five parts cannot pass by being in the inventory',async()=>{
 const f=fixture({missingChapterParts:true});const r=await run(f);assert.equal(find(r,'chapter-structure').status,'failed');assert.match(find(r,'chapter-structure').detail,/absent from its actual MD scope/)
})
test('omitting a real chapter from the ledger fails',async()=>{
 const f=fixture();f.md+='\n## 第二章 行动\n\n行动不是完整五件套。';f.html=f.html.replace('</main>','<section><h2>第二章 行动</h2><p>行动不是完整五件套。</p></section></main>');bundle(f);const r=await run(f);assert.equal(find(r,'chapter-structure').status,'failed');assert.match(find(r,'chapter-structure').detail,/inventory/)
})
test('empty or duplicate chapters fail rather than vacuous PASS',async()=>{
 const f=fixture();f.evidence.chapters=[];bundle(f);assert.ok((await run(f)).slice(3).every(x=>x.status==='failed'))
})
test('global marker comments cannot stand in for visible actual parts',async()=>{
 const f=fixture();f.html=f.html.replace('<p id="ch1-roles">','<!-- <p id="ch1-roles">').replace('卖方核对价格，买方核对租金。</p>','卖方核对价格，买方核对租金。</p> -->');bundle(f);assert.equal(find(await run(f),'chapter-structure').status,'failed')
})
test('duplicated DOM id is rejected',async()=>{
 const f=fixture();f.html=f.html.replace('</main>','<div id="ch1-roles"></div></main>');bundle(f);assert.equal(find(await run(f),'chapter-structure').status,'failed')
})
test('the same broad part cannot satisfy all chapter slots',async()=>{
 const f=fixture();f.evidence.chapters[0].parts.roles=f.evidence.chapters[0].parts.basis;bundle(f);assert.equal(find(await run(f),'chapter-structure').status,'failed')
})
test('ledger[] cannot hide a recognisable inverse calculation in the body',async()=>{
 const f=fixture({wrongCalculation:true});f.evidence.calculations=[];bundle(f);assert.equal(find(await run(f),'calculations').status,'failed')
})
test('a correct small ledger cannot hide an extra contradictory same-family claim',async()=>{
 const f=fixture();f.md+='\n目标回报率1.8%至2.2%的合理价弹性为-18%至+11%。\n';f.html=f.html.replace('</main>','<p>目标回报率1.8%至2.2%的合理价弹性为-18%至+11%。</p></main>');bundle(f);const r=await run(f);assert.equal(find(r,'calculations').status,'failed');assert.match(find(r,'calculations').detail,/unbound/)
})
test('correct ledger numbers cannot mask incorrect bound visible prose',async()=>{
 const f=fixture();f.evidence.calculations[0].scenarios[2].change='-18.00%';bundle(f);assert.equal(find(await run(f),'calculations').status,'failed')
})
test('unsupported arbitrary formula code is rejected, never evaluated',async()=>{
 const f=fixture();f.evidence.calculations[0].kind='eval';f.evidence.calculations[0].formula='process.exit()';bundle(f);assert.equal(find(await run(f),'calculations').status,'failed')
})
test('a tolerance override is not accepted',async()=>{
 const f=fixture({wrongCalculation:true});f.evidence.calculations[0].tolerance=100;bundle(f);assert.equal(find(await run(f),'calculations').status,'failed')
})
test('changed artifact bytes and ledger hash mismatch cannot pass',async()=>{
 const f=fixture();f.artifacts[0].sha256='b'.repeat(64);assert.ok((await run(f)).every(x=>x.status==='failed'))
 const g=fixture();g.evidence.reportSha256.html='b'.repeat(64);g.artifacts[3]=artifact('craft-evidence.json',JSON.stringify(g.evidence));assert.ok((await run(g)).slice(3).every(x=>x.status==='failed'))
})
test('format consistency rejects an altered HTML number outside ledger calculations',async()=>{
 const f=fixture();f.md=f.md.replace('未知边界','未知边界和100');f.html=f.html.replace('未知边界','未知边界和200');bundle(f);assert.equal(find(await run(f),'format-consistency').status,'failed')
})
test('format consistency reads actual PDF rather than trusting its SHA label',async()=>{
 const f=fixture(),g=fixture({wrongCalculation:true});f.pdf=g.pdf;bundle(f);assert.equal(find(await run(f),'format-consistency').status,'failed')
})
test('missing controlled browser is unverified, not PASS',async()=>{
 const r=await run(fixture());assert.equal(find(r,'browser').status,'unverified');assert.match(find(r,'browser').detail,/unavailable/)
})
test('complex composited background is unverified rather than guessed AA',{skip:!existsSync(browserPath)},async()=>{
 const r=await run(fixture({css:'#yield-base{background-image:linear-gradient(white,#eee)}'}),browserOptions);assert.equal(find(r,'browser').status,'unverified');assert.ok(JSON.parse(find(r,'browser').detail).metrics.every(x=>x.unsupportedCount>0))
})
test('actual CSS-hidden ledger part cannot count as rendered evidence',{skip:!existsSync(browserPath)},async()=>{
 const r=await run(fixture({css:'section #ch1-roles{display:none}'}),browserOptions);assert.equal(find(r,'browser').status,'failed');assert.ok(JSON.parse(find(r,'browser').detail).metrics.every(x=>x.boundVisibleTextMismatches.includes('ch1-roles')))
})
test('report scripts are rejected without execution',{skip:!existsSync(browserPath)},async()=>{
 const r=await run(fixture({tail:'<script>throw new Error("must not run")</script>'}),browserOptions);assert.equal(find(r,'browser').status,'failed');assert.match(find(r,'browser').detail,/scripts are forbidden/)
})
test('network and local file resource requests are blocked, never treated as normal PASS',{skip:!existsSync(browserPath)},async()=>{
 const f=fixture({tail:'<img src="http://127.0.0.1:9/forbidden"><img src="https://example.invalid/no-network"><iframe src="file:///etc/passwd"></iframe>'});const r=await run(f,browserOptions);const b=JSON.parse(find(r,'browser').detail);assert.notEqual(find(r,'browser').status,'passed');assert.ok(b.blockedRequestSchemes.includes('http'));assert.ok(b.blockedRequestSchemes.includes('https'));assert.equal(b.scope.includes('all requests blocked'),true)
})
test('artifact cannot supply a browser executable path through the ledger',async()=>{
 const f=fixture();f.evidence.browserExecutablePath='/bin/sh';bundle(f);assert.ok((await run(f)).slice(3).every(x=>x.status==='failed'))
})
test('cancelled evaluation does not start any inspection',async()=>{
 const c=new AbortController();c.abort();assert.ok((await run(fixture(),{...browserOptions,signal:c.signal})).every(x=>x.status==='unverified'))
})

test('ancestor opacity cannot be cleared by an opaque child background',{skip:!existsSync(browserPath)},async()=>{
 const r=await run(fixture({css:'body{opacity:.1}main{background:white}'}),browserOptions);assert.equal(find(r,'browser').status,'unverified');assert.ok(JSON.parse(find(r,'browser').detail).metrics.every(x=>x.unsupportedCount>0))
})

test('new HTML gets separately bound retained PNGs even when visible pixels match',{skip:!existsSync(browserPath)},async()=>{
 const first=fixture(),second=fixture({tail:'<!-- different immutable HTML identity for cache coverage -->'});
 const a=JSON.parse(find(await run(first,browserOptions),'browser').detail),b=JSON.parse(find(await run(second,browserOptions),'browser').detail);
 assert.notEqual(hash(first.html),hash(second.html));
 for(let i=0;i<2;i++){assert.notEqual(a.screenshots[i].path,b.screenshots[i].path);assert.equal(b.screenshots[i].htmlSha256,hash(second.html));assert.equal(hash(readFileSync(b.screenshots[i].path)),b.screenshots[i].viewportScreenshotSha256)}
})
test('a symlink at an existing screenshot identity cannot be followed or yield PASS',{skip:!existsSync(browserPath)},async()=>{
 const f=fixture({tail:'<!-- unique screenshot symlink regression '+process.pid+' -->'}),before=find(await run(f,browserOptions),'browser');
 assert.equal(before.status,'passed');const path=JSON.parse(before.detail).screenshots[0].path,saved=path+'.test-save';
 renameSync(path,saved);symlinkSync(saved,path);
 try {const r=find(await run(f,browserOptions),'browser');assert.equal(r.status,'unverified');assert.match(r.detail,/unavailable/);assert.equal(lstatSync(path).isSymbolicLink(),true)}
 finally {unlinkSync(path);renameSync(saved,path)}
})

function closingFixture(title='结论与行动'){
 const f=fixture();f.md=f.md.replace('## 总结','## '+title);f.html=f.html.replace('<h2>总结</h2>','<h2>'+title+'</h2>');return bundle(f)
}
function wrappingFixture(lineHeight='1.3'){
 const f=fixture({css:'h1{font:700 32px/'+lineHeight+' "Noto Sans CJK SC",sans-serif;width:250px}'});
 const title='正常折行标题测试正常折行标题测试正常折行标题测试';f.md=f.md.replace('Synthetic report',title);f.html=f.html.replace('Synthetic report',title);return bundle(f)
}
test('r11 legal terminal closing and action heading is not a seventh analysis chapter',async()=>{
 const r=await run(closingFixture());assert.equal(find(r,'chapter-structure').status,'passed',find(r,'chapter-structure').detail);assert.equal(find(r,'closing-structure').status,'passed')
})
test('r11 numbered closing cannot disguise an omitted analysis chapter',async()=>{
 const r=find(await run(closingFixture('第二章 结论与行动')),'chapter-structure');assert.equal(r.status,'failed');assert.match(r.detail,/第二章结论与行动/)
})
test('r11 early closing before declared chapters is not metadata',async()=>{
 const f=closingFixture();f.md=f.md.replace('## 第一章 定价','## 结论与行动\n\n提前下结论。\n\n> 收束金句：尚未分析。\n\n## 第一章 定价');f.html=f.html.replace('<section id="chapter-1">','<h2>结论与行动</h2><p>提前下结论。</p><blockquote>收束金句：尚未分析。</blockquote><section id="chapter-1">');bundle(f);
 const r=find(await run(f),'chapter-structure');assert.equal(r.status,'failed');assert.match(r.detail,/closingNotExempted/)
})
test('r11 duplicate terminal closing does not create multiple exemptions',async()=>{
 const f=closingFixture();f.md=f.md.replace('## 来源披露','## 结语\n\n另一个结尾。\n\n> 收束金句：再结束。\n\n## 来源披露');f.html=f.html.replace('<h2>来源披露</h2>','<h2>结语</h2><p>另一个结尾。</p><blockquote>收束金句：再结束。</blockquote><h2>来源披露</h2>');bundle(f);assert.equal(find(await run(f),'chapter-structure').status,'failed')
})
test('r11 a closing followed by undeclared analysis cannot bypass coverage',async()=>{
 const f=closingFixture();f.md+='\n## 后续分析\n\n新增分析内容。';f.html=f.html.replace('</main>','<h2>后续分析</h2><p>新增分析内容。</p></main>');bundle(f);const r=find(await run(f),'chapter-structure');assert.equal(r.status,'failed');assert.match(r.detail,/后续分析/)
})
test('r11 empty terminal title is not sufficient closing content',async()=>{
 const f=closingFixture();f.md=f.md.replace(/## 结论与行动[\s\S]*?## 来源披露/,'## 结论与行动\n\n## 来源披露');f.html=f.html.replace(/<h2>结论与行动<\/h2>[\s\S]*?<h2>来源披露<\/h2>/,'<h2>结论与行动</h2><h2>来源披露</h2>');bundle(f);assert.equal(find(await run(f),'chapter-structure').status,'failed')
})
test('r11 renamed terminal analysis with role/basis blocks is not exempted',async()=>{
 const f=closingFixture();f.md=f.md.replace('## 结论与行动','## 结论与行动\n\n角色对照：这是新增分析章节。');f.html=f.html.replace('<h2>结论与行动</h2>','<h2>结论与行动</h2><p>角色对照：这是新增分析章节。</p>');bundle(f);const r=find(await run(f),'chapter-structure');assert.equal(r.status,'failed');assert.match(r.detail,/closingNotExempted/)
})
test('r11 real MD h1 to HTML h2 mismatch still fails with actual extra title',async()=>{
 const f=fixture();f.html=f.html.replace('<h1>Synthetic report</h1>','<h2>Synthetic report</h2>');bundle(f);const r=find(await run(f),'chapter-structure');assert.equal(r.status,'failed');assert.match(r.detail,/Syntheticreport/);assert.match(r.detail,/HTML analysis/)
})
test('r11 literal CommonMark asterisks removed by custom HTML remain a real format mismatch',async()=>{
 const f=fixture();f.md+='\n**方案对照（角色）：**说明。';f.html=f.html.replace('</main>','<p>方案对照（角色）：说明。</p></main>');bundle(f);const r=find(await run(f),'format-consistency');assert.equal(r.status,'failed');assert.match(r.detail,/MD body and HTML/)
})
test('r11 normal wrapped CJK glyphs with intersecting font boxes do not overlap',{skip:!existsSync(browserPath)},async()=>{
 const r=find(await run(wrappingFixture(),browserOptions),'browser');assert.equal(r.status,'passed',r.detail);const b=JSON.parse(r.detail);assert.ok(b.metrics.every(m=>m.overlapCount===0&&m.geometryUnsupportedCount===0))
})
test('r11 line-height zero real same-node glyph collision still fails',{skip:!existsSync(browserPath)},async()=>{
 const r=find(await run(wrappingFixture('0'),browserOptions),'browser');assert.equal(r.status,'failed',r.detail);const b=JSON.parse(r.detail);assert.ok(b.metrics.every(m=>m.overlapCount>0));assert.ok(b.metrics.some(m=>m.overlaps.some(p=>p.sameTextNode&&p.intersectionPixels>3)))
})
test('r11 small positive line-height actual ink collision still fails',{skip:!existsSync(browserPath)},async()=>{
 const r=find(await run(wrappingFixture('.35'),browserOptions),'browser');assert.equal(r.status,'failed',r.detail);assert.ok(JSON.parse(r.detail).metrics.every(m=>m.overlapCount>0))
})
test('r11 independently positioned text glyphs colliding are not ignored',{skip:!existsSync(browserPath)},async()=>{
 const f=fixture({css:'#ch1-roles,#ch1-basis{position:absolute;left:30px;top:80px}'});const r=find(await run(f,browserOptions),'browser');assert.equal(r.status,'failed',r.detail);assert.ok(JSON.parse(r.detail).metrics.some(m=>m.overlaps.some(p=>!p.sameTextNode&&p.intersectionPixels>3)))
})
test('r11 unsupported transformed glyph geometry cannot return PASS',{skip:!existsSync(browserPath)},async()=>{
 const f=fixture({css:'#ch1-risk{transform:rotate(.2deg)}'});const r=find(await run(f,browserOptions),'browser');assert.notEqual(r.status,'passed');assert.ok(JSON.parse(r.detail).metrics.every(m=>m.geometryUnsupportedCount>0))
})

test('r11 explicit zyt source label may describe Beike as the supplier',async()=>{
 const f=fixture();f.md=f.md.replace('- zyt：待补。','| 政研通CLI（贝壳交付数据，dataView=internal） | 已采用：平台口径。 |');f.html=f.html.replace('<li>zyt：待补。</li>','<li>政研通CLI（贝壳交付数据，dataView=internal）：已采用：平台口径。</li>');bundle(f);
 const r=find(await run(f),'source-disclosure');assert.equal(r.status,'passed',r.detail)
})
test('r11 combined Wind zyt beike label cannot count as three channel disclosures',async()=>{
 const f=fixture();f.md=f.md.replace('- Wind：未采用。\n- zyt：待补。\n- beike：未配置。','- Wind / zyt / beike：已采用。');f.html=f.html.replace('<li>Wind：未采用。</li>\n<li>zyt：待补。</li>\n<li>beike：未配置。</li>','<li>Wind / zyt / beike：已采用。</li>');bundle(f);assert.equal(find(await run(f),'source-disclosure').status,'failed')
})
test('r11 supplier comment status cannot stand in for the primary channel status',async()=>{
 const f=fixture();f.md=f.md.replace('- zyt：待补。','- 政研通CLI（贝壳未采用）：平台口径。');f.html=f.html.replace('<li>zyt：待补。</li>','<li>政研通CLI（贝壳未采用）：平台口径。</li>');bundle(f);const r=find(await run(f),'source-disclosure');assert.equal(r.status,'failed');assert.match(r.detail,/missing channel status: zyt/)
})
