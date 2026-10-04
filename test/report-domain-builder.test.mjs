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
  writeFileSync(join(out,'craft-evidence.json'),JSON.stringify(evidence,null,2))
  const artifacts = ['md','html','pdf'].map(id => {const b=readFileSync(join(out,'report.'+id));assert.equal(sha(b),inventory.reportSha256[id]);return{id,sha256:sha(b),content:b.toString('base64'),encoding:'base64'}})
  const raw=Buffer.from(JSON.stringify(evidence));artifacts.push({id:'ledger',sha256:sha(raw),content:raw.toString('base64'),encoding:'base64'})
  const results=await evaluateReportCraftV2(artifacts,{id:'zhijian-report-craft-core-v2',materialPackId:'zhijian-report-craft-v2',materialDigest:'a'.repeat(64),style:variant,md:'md',html:'html',pdf:'pdf',craftEvidence:'ledger'})
  writeFileSync(join(out,'checks.json'),JSON.stringify(results,null,2))
  for (const id of ['chapter-structure','calculations','pdf-structure','format-consistency','browser']) {
    const check=results.find(r=>r.id==='report-craft-'+id);assert.equal(check.status,'passed',JSON.stringify(check))
  }
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
