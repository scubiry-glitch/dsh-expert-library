/** Synthetic, offline report fixture; uses installed Python parsers/PDF and CJK font. */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
const hash = b => createHash('sha256').update(b).digest('hex')
function artifact(id, bytes) { const b=Buffer.from(bytes);return {id,taskId:'synthetic-report',attempt:1,path:'/never-read/'+id,sha256:hash(b),encoding:'base64',content:b.toString('base64')} }
const BUILD = String.raw`
import sys,sysconfig,json,base64
for key in ('purelib','platlib'):
 p=sysconfig.get_path(key)
 if p and p not in sys.path:sys.path.append(p)
from markdown_it import MarkdownIt
from bs4 import BeautifulSoup
import fitz,io
from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter
p=json.load(sys.stdin);render=MarkdownIt('commonmark',{'html':True}).enable('table')
soup=BeautifulSoup(render.render(p['md']),'html.parser');txt=soup.get_text(' ',strip=True)
doc=fitz.open();cover=doc.new_page(width=595,height=842);cover.insert_text((40,70),'Synthetic report cover',fontsize=16)
page=doc.new_page(width=595,height=842)
font=TTFont('/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',fontNumber=0)
sub=Subsetter();sub.populate(text=txt);sub.subset(font);fb=io.BytesIO();font.save(fb)
page.insert_font(fontname='report',fontbuffer=fb.getvalue())
unused=page.insert_textbox(fitz.Rect(40,40,555,710),txt,fontname='report',fontsize=10,lineheight=1.4)
if unused<0:raise ValueError('synthetic text exceeded body page')
page.insert_text((40,810),'98wiki | 1/1',fontsize=10)
back=doc.new_page(width=595,height=842);back.insert_text((40,70),'Synthetic report back',fontsize=16)
doc.set_toc([[1,h.get_text(),2] for h in soup.find_all('h2')])
print(json.dumps({'pdf':base64.b64encode(doc.tobytes(deflate=True,garbage=4)).decode(),'render':render.render(p['md'])}))
`
const generatedByMd = new Map()
export function createCraftV2Fixture(options={}) {
 if(typeof options==='string')options={style:options}
 const style=options.style??'credit-policy'
 const quote='> 章眼金句：先说明共同基准，再比较变化。'
 const roles='**角色对照**：卖方核对价格，买方核对租金。'
 const basis='**事实依据**：此例为合成测试，不是用户事实。'
 const base='共同基准：目标回报率为2.0%。'
 const s1='目标回报率1.8%时，相对共同基准合理价变化+11.11%。'
 const s2='目标回报率2.0%时，相对共同基准合理价变化0.00%。'
 const s3='目标回报率2.2%时，相对共同基准合理价变化'+(options.wrongCalculation?'-18.00%':'-9.09%')+'。'
 const inference='**推论与数据**：固定租金，使用P=R/y。\n\n'+[base,s1,s2,s3].join('\n\n')
 const opportunity='**机会**：统一基准便于比较。'
 const risk='**风险**：实际租金仍须另行核实。'
 let md='# Synthetic report\n\n## 第一章 定价\n\n'+[quote,roles,basis,inference,opportunity,risk].join('\n\n')+'\n\n## 总结\n\n共同基准、已知输入和未知边界需要分别确认。\n\n> 收束金句：先确认，再比较。\n\n## 来源披露\n\n- Wind：未采用。\n- zyt：待补。\n- beike：未配置。\n'
 if(options.missingChapterParts)md=md.replace(roles+'\n\n','')
 let built=generatedByMd.get(md)
 if(!built){
  const generated=spawnSync('python3',['-I','-c',BUILD],{input:JSON.stringify({md}),encoding:'utf8',timeout:30000,maxBuffer:32*1024*1024})
  assert.equal(generated.status,0,JSON.stringify({error:generated.error?.message,stderr:generated.stderr?.slice(-1000)}))
  built=JSON.parse(generated.stdout);generatedByMd.set(md,built)
 }
 const color=style==='credit-policy'?'#0e6a55':'#2e6b4f',bg=style==='credit-policy'?'#fcfdfb':'#f5f4eb'
 let body=built.render
 body=body.replace('<h2>第一章 定价</h2>','<section id="chapter-1"><h2>第一章 定价</h2>').replace('<h2>总结</h2>','</section><h2>总结</h2>')
 body=body.replace('<blockquote>','<blockquote id="ch1-quote">')
 for(const [prefix,id] of [['角色对照','ch1-roles'],['事实依据','ch1-basis'],['机会','ch1-opportunity'],['风险','ch1-risk']]) body=body.replace('<p><strong>'+prefix,'<p id="'+id+'"><strong>'+prefix)
 body=body.replace('<p><strong>推论与数据','<div id="ch1-inference"><p><strong>推论与数据')
 body=body.replace('<p>'+base,'<p id="yield-base">'+base).replace('<p>'+s1,'<p id="yield-one">'+s1).replace('<p>'+s2,'<p id="yield-two">'+s2).replace('<p>'+s3,'<p id="yield-three">'+s3)
 body=body.replace('<p id="ch1-opportunity">','</div><p id="ch1-opportunity">')
 const html='<!doctype html><html><head><meta charset="utf-8"><style>body{color:#20301f;background:'+bg+';font:16px sans-serif;margin:20px}main{max-width:1000px;margin:auto}h1,h2{color:'+color+'}blockquote{border-left:3px solid '+color+';margin:12px 0;padding:4px 12px}p{line-height:1.6}'+(options.css??'')+'</style></head><body><main id="report-body">'+body+'</main>'+(options.tail??'')+'</body></html>'
 const pdf=Buffer.from(built.pdf,'base64')
 const sp=(markdown,htmlId)=>({markdown,htmlId})
 const evidence={schemaVersion:1,reportSha256:{md:hash(md),html:hash(html),pdf:hash(pdf)},body:{htmlId:'report-body'},chapters:[{heading:'第一章 定价',htmlId:'chapter-1',parts:{quote:sp(quote,'ch1-quote'),roles:sp(roles,'ch1-roles'),basis:sp(basis,'ch1-basis'),inference:sp(inference,'ch1-inference'),opportunityRisk:{opportunity:sp(opportunity,'ch1-opportunity'),risk:sp(risk,'ch1-risk')}}}],calculations:[{id:'price-range',kind:'inverse-yield-range',baseYield:'2.0%',base:sp(base,'yield-base'),scenarios:[{yield:'1.8%',change:'+11.11%',claim:sp(s1,'yield-one')},{yield:'2.0%',change:'0.00%',claim:sp(s2,'yield-two')},{yield:'2.2%',change:options.wrongCalculation?'-18.00%':'-9.09%',claim:sp(s3,'yield-three')}]}]}
 const check={id:'zhijian-report-craft-core-v2',md:'report.md',html:'report.html',pdf:'report.pdf',craftEvidence:'craft-evidence.json',materialPackId:'zhijian-report-craft-v2',materialDigest:'a'.repeat(64),style}
 return rebuildCraftV2Fixture({md,html,pdf,evidence,check})
}
export function rebuildCraftV2Fixture(f){f.evidence.reportSha256={md:hash(f.md),html:hash(f.html),pdf:hash(f.pdf)};f.craftEvidence=JSON.stringify(f.evidence);f.artifacts=[artifact('report.md',f.md),artifact('report.html',f.html),artifact('report.pdf',f.pdf),artifact('craft-evidence.json',JSON.stringify(f.evidence))];return f}
