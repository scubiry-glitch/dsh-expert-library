import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { evaluateReportCraftV2 } from '../domain-packs/zhijian-realestate/checks/report-craft-checker-v2.mjs'
const cli = resolve('domain-packs/zhijian-realestate/scripts/build-report.py')
const sha = b => createHash('sha256').update(b).digest('hex')
const root = mkdtempSync(join(tmpdir(), 'report-domain-builder-test-'))
// A broad CJK subset catches decoders that return embedded character IDs
// rather than Unicode; small repetitive fixtures did not cover that case.
const glyphSample = Array.from({length:700},(_,i)=>String.fromCodePoint(0x4e00+i)).join('')
const paragraph = '这是合成报告的长段落，用于检查自动分页、中文字体和实际正文提取。正文应完整保留，工具不得改写内容。'
const md = '# 合成研究报告\n\n开篇**重点**与`sample_key`保持原文。\n\n## 第一章 可验证分析\n\n> 条件比结论更重要。\n\n### 角色对照\n\n| 角色 | 关注点 |\n|---|---|\n| 甲方 | 成本 |\n| 乙方 | 期限 |\n\n### 事实依据\n\n样本材料来自[公开来源](https://example.org/reference)，仅作渲染测试。\n\n### 推论与数据\n\n项目甲20万元，项目乙80万元，费用合计100万元。\n\n' + paragraph.repeat(60) + '\n\n### 机会\n\n保留后续验证空间。\n\n### 风险\n\n样本无法替代真实业务来源。\n\n## 第二章 边界检验\n\n> 证据的边界应当可见。\n\n### 角色对照\n\n- 研究者负责提出问题。\n- 审核者负责核实依据。\n\n### 事实依据\n\n此处重复一条普通事实。\n\n### 推论与数据\n\n1. 首先读取依据。\n2. 其次解释适用条件。\n\n### 机会\n\n边界清晰有助于后续使用。\n\n### 风险\n\n此处重复一条普通事实。\n\n## 结语\n\n这是合成报告的总结，不代表真实业务判断。\n\n> 以实际证据完成判断。\n'
const input = join(root, 'input.md'); writeFileSync(input, md)
function run(path, out, variant = 'credit-policy') {
  return spawnSync('python3', ['-I', cli, '--md', path, '--out-dir', out, '--variant', variant], {encoding:'utf8', timeout:60000, maxBuffer:1024*1024})
}
for (const variant of ['credit-policy', 'designer-paper']) test('single source multipage rendering, locators and actual domain checker: '+variant, async () => {
  const out = join(root, variant), built = run(input, out, variant)
  assert.equal(built.status, 0, built.stderr + built.stdout)
  const receipt = JSON.parse(built.stdout); assert.equal(receipt.qualityApproved, false); assert.ok(receipt.bodyPages > 3)
  assert.equal(readFileSync(input, 'utf8'), md); assert.equal(readFileSync(join(out,'report.md'),'utf8'),md)
  const inventory = JSON.parse(readFileSync(join(out,'anchors.json')))
  const index = JSON.parse(readFileSync(join(out,'anchors-index.json')))
  assert.deepEqual(index.reportSha256, inventory.reportSha256)
  assert.ok(index.anchors.every(a=>a.preview.length<=80 && !('markdown' in a)))
  assert.deepEqual(index.anchors.map(a=>a.htmlId),inventory.anchors.map(a=>a.span.htmlId))
  const lookup = (chapter, kind, start) => {
    const rows = inventory.anchors.filter(a => a.chapterId === chapter && a.kind === kind && a.span.markdown.startsWith(start))
    assert.equal(rows.length,1,JSON.stringify({chapter,kind,start,rows})); return rows[0].span
  }
  const chapters = inventory.chapters.slice(0,2).map(ch => ({...ch, parts: {
    quote: lookup(ch.htmlId,'blockquote','>'), roles: lookup(ch.htmlId,'section','### 角色对照'),
    basis: lookup(ch.htmlId,'section','### 事实依据'), inference: lookup(ch.htmlId,'section','### 推论与数据'),
    opportunityRisk: {opportunity:lookup(ch.htmlId,'section','### 机会'),risk:lookup(ch.htmlId,'section','### 风险')},
  }}))
  const q = value => ({value,unit:'万元',claim:lookup(chapters[0].htmlId,'quantity',value+'万元')})
  const calculation = {id:'synthetic-sum',kind:'money-sum',terms:[q('20'),q('80')],result:q('100'),claims:[lookup(chapters[0].htmlId,'p','项目甲')]}
  const evidence = {schemaVersion:2, reportSha256: inventory.reportSha256, body:inventory.body, chapters, calculations:[calculation], policyClaims:[]}
  const refs = value => Array.isArray(value) ? value.map(refs) : value && typeof value === 'object'
    ? ('markdown' in value && 'htmlId' in value ? {$anchor:value.htmlId} : Object.fromEntries(Object.entries(value).map(([k,v])=>[k,refs(v)]))) : value
  const bindings = {chapters:chapters.map(c=>({htmlId:c.htmlId,parts:refs(c.parts)})),calculations:refs([calculation]),policyClaims:[]}
  const bindingPath=join(out,'bindings.json'), assembledPath=join(out,'assembled.json')
  writeFileSync(bindingPath,JSON.stringify(bindings))
  const assemble = target => spawnSync('python3',['-I',resolve('domain-packs/zhijian-realestate/scripts/assemble-evidence.py'),'--build-dir',out,'--bindings',bindingPath,'--out',target],{encoding:'utf8'})
  const assembled=assemble(assembledPath);assert.equal(assembled.status,0,assembled.stderr+assembled.stdout)
  assert.deepEqual(JSON.parse(readFileSync(assembledPath)),evidence)
  assert.equal(JSON.parse(assembled.stdout).qualityApproved,false)
  assert.equal(assemble(assembledPath).status,2,'do not overwrite a prior ledger')
  const wrong = structuredClone(bindings);wrong.chapters[0].parts.quote={$anchor:'does-not-exist'}
  writeFileSync(bindingPath,JSON.stringify(wrong));const missing=assemble(join(out,'missing.json'))
  assert.equal(missing.status,2);assert.match(missing.stdout,/chapters\[0\].parts.quote/);assert.equal(existsSync(join(out,'missing.json')),false)
  wrong.chapters[0].parts.quote=chapters[0].parts.quote
  writeFileSync(bindingPath,JSON.stringify(wrong));assert.equal(assemble(join(out,'manual.json')).status,2,'manual spans must not slip through')
  writeFileSync(bindingPath,JSON.stringify(bindings))
  writeFileSync(join(out,'report.md'),md+'\nchanged');assert.equal(assemble(join(out,'stale.json')).status,2,'changed source must invalidate inventory')
  writeFileSync(join(out,'report.md'),md)
  writeFileSync(join(out,'craft-evidence.json'),JSON.stringify(evidence,null,2))
  const artifacts = ['md','html','pdf'].map(id => {const b=readFileSync(join(out,'report.'+id));assert.equal(sha(b),inventory.reportSha256[id]);return{id,sha256:sha(b),content:b.toString('base64'),encoding:'base64'}})
  const raw=Buffer.from(JSON.stringify(evidence));artifacts.push({id:'ledger',sha256:sha(raw),content:raw.toString('base64'),encoding:'base64'})
  const results=await evaluateReportCraftV2(artifacts,{id:'zhijian-report-craft-core-v2',materialPackId:'zhijian-report-craft-v2',materialDigest:'a'.repeat(64),style:variant,md:'md',html:'html',pdf:'pdf',craftEvidence:'ledger'})
  writeFileSync(join(out,'checks.json'),JSON.stringify(results,null,2))
  for (const id of ['closing-structure','chapter-structure','calculations','pdf-structure','format-consistency','browser']) {
    const check=results.find(r=>r.id==='report-craft-'+id);assert.equal(check.status,'passed',JSON.stringify(check))
  }
  // Keep real content mismatches and later analysis blocking after fixing the
  // extraction engine and replacing the generated back-cover heading.
  const changed = artifacts.map(a=>({...a}))
  const altered = Buffer.from(readFileSync(join(out,'report.html'),'utf8').replace('条件比结论更重要。','条件比结论更重要。错误增加100万元。'))
  changed[1]={id:'html',sha256:sha(altered),content:altered.toString('base64'),encoding:'base64'}
  const changedEvidence={...evidence,reportSha256:{...evidence.reportSha256,html:sha(altered)}}
  const changedRaw=Buffer.from(JSON.stringify(changedEvidence));changed[3]={id:'ledger',sha256:sha(changedRaw),content:changedRaw.toString('base64'),encoding:'base64'}
  const rejected=await evaluateReportCraftV2(changed,{id:'zhijian-report-craft-core-v2',materialPackId:'zhijian-report-craft-v2',materialDigest:'a'.repeat(64),style:variant,md:'md',html:'html',pdf:'pdf',craftEvidence:'ledger'})
  assert.equal(rejected.find(x=>x.id==='report-craft-format-consistency').status,'failed')
  const alteredPdf=spawnSync('python3',['-I','-c',`import sys,sysconfig,base64
for k in ('purelib','platlib'):sys.path.append(sysconfig.get_path(k))
import fitz
d=fitz.open(sys.argv[1]);d[1].insert_text((40,50),'9137',fontsize=12);print(base64.b64encode(d.tobytes()).decode())`,join(out,'report.pdf')],{encoding:'utf8',maxBuffer:32*1024*1024})
  assert.equal(alteredPdf.status,0,alteredPdf.stderr)
  const wrongPdf=Buffer.from(alteredPdf.stdout.trim(),'base64'),pdfArtifacts=artifacts.map(a=>({...a}))
  pdfArtifacts[2]={id:'pdf',sha256:sha(wrongPdf),content:wrongPdf.toString('base64'),encoding:'base64'}
  const wrongLedger=Buffer.from(JSON.stringify({...evidence,reportSha256:{...evidence.reportSha256,pdf:sha(wrongPdf)}}))
  pdfArtifacts[3]={id:'ledger',sha256:sha(wrongLedger),content:wrongLedger.toString('base64'),encoding:'base64'}
  const pdfRejected=await evaluateReportCraftV2(pdfArtifacts,{id:'zhijian-report-craft-core-v2',materialPackId:'zhijian-report-craft-v2',materialDigest:'a'.repeat(64),style:variant,md:'md',html:'html',pdf:'pdf',craftEvidence:'ledger'})
  assert.equal(pdfRejected.find(x=>x.id==='report-craft-format-consistency').status,'failed','a newly hashed PDF with an inserted value must still fail')
  // Every offered Span is validated independently, including duplicate prose and table cells.
  const inspect = spawnSync('python3',['-I','-c',`import json,re,sys,sysconfig
for k in ('purelib','platlib'): sys.path.append(sysconfig.get_path(k))
from bs4 import BeautifulSoup
from markdown_it import MarkdownIt
from pathlib import Path
p=Path(sys.argv[1]);i=json.loads((p/'anchors.json').read_text());s=BeautifulSoup((p/'report.html').read_text(),'html.parser');m=(p/'report.md').read_text();r=MarkdownIt('commonmark',{'html':True}).enable('table');n=lambda s:re.sub(r'\\s+','',s)
for a in i['anchors']:
 v=a['span'];nodes=s.find_all(id=v['htmlId']);assert len(nodes)==1;assert v['markdown'] in m;assert n(nodes[0].get_text())==n(BeautifulSoup(r.render(v['markdown']),'html.parser').get_text()),v
print(len(i['anchors']))`,out],{encoding:'utf8'});assert.equal(inspect.status,0,inspect.stderr)
  assert.equal(run(input,out,variant).status,2,'never overwrite an existing render')
})
test('broad embedded CJK subset is decoded from actual PDF pages',async()=>{
  const source=md.replace('## 结语',glyphSample+'\n\n- 合成外层清单\n  - 合成内层清单\n    - 合成第三层清单\n\n## 结语'), path=join(root,'glyphs.md'),out=join(root,'glyphs')
  writeFileSync(path,source);const built=run(path,out);assert.equal(built.status,0,built.stderr+built.stdout)
  const inventory=JSON.parse(readFileSync(join(out,'anchors.json')))
  const evidence={schemaVersion:2,reportSha256:inventory.reportSha256,body:inventory.body,chapters:[{heading:inventory.chapters[0].heading,htmlId:inventory.chapters[0].htmlId,parts:{}}],calculations:[],policyClaims:[]}
  const artifacts=['md','html','pdf'].map(id=>{const b=readFileSync(join(out,'report.'+id));return{id,sha256:sha(b),content:b.toString('base64'),encoding:'base64'}})
  const raw=Buffer.from(JSON.stringify(evidence));artifacts.push({id:'ledger',sha256:sha(raw),content:raw.toString('base64'),encoding:'base64'})
  const result=await evaluateReportCraftV2(artifacts,{id:'zhijian-report-craft-core-v2',materialPackId:'zhijian-report-craft-v2',materialDigest:'a'.repeat(64),style:'credit-policy',md:'md',html:'html',pdf:'pdf',craftEvidence:'ledger'})
  assert.equal(result.find(x=>x.id==='report-craft-format-consistency').status,'passed',JSON.stringify(result))
  assert.equal(result.find(x=>x.id==='report-craft-chapter-structure').status,'failed','text consistency must not approve missing chapter evidence')
})
test('unsupported resources, symlinks and missing required selection fail without outputs or input changes',()=>{
  for (const [name,text] of [['script','<script>alert(1)</script>'],['image','![remote](https://example.org/image.png)'],['local','[local](relative.txt)']]) {
    const path=join(root,name+'.md'),out=join(root,name);writeFileSync(path,md+'\n'+text)
    assert.equal(run(path,out).status,2);assert.equal(existsSync(out),false);assert.equal(readFileSync(path,'utf8'),md+'\n'+text)
  }
  const alias=join(root,'symlink.md');symlinkSync(input,alias);assert.equal(run(alias,join(root,'symlink-out')).status,2)
  const noVariant=spawnSync('python3',['-I',cli,'--md',input,'--out-dir',join(root,'no-variant')],{encoding:'utf8'});assert.equal(noVariant.status,2)
  assert.ok(!readdirSync(root).some(x=>x.startsWith('.report-build-')))
})
console.log('Retained synthetic renderer evidence: '+root)
