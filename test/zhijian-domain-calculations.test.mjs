/** Bounded arithmetic/policy regressions for the actual domain-owned inspector.
 * Added paragraphs deliberately do not regenerate a PDF; assertions concern the
 * named arithmetic/policy result only. Full-bundle tests live in skill-craft-domain-pack.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {evaluateReportCraftV2} from '../domain-packs/zhijian-realestate/checks/report-craft-checker-v2.mjs'
import {createCraftV3Fixture,rebuildCraftV3Fixture} from './support/report-craft-v3-fixture.mjs'
const hash=b=>createHash('sha256').update(b).digest('hex')
const span=(markdown,htmlId)=>({markdown,htmlId})
const q=(id,label,value,unit)=>({value,unit,claim:span(`<span id="${id}">${label}${value}${unit}</span>`,id)})
function append(f,id,body){const raw=`<p id="${id}">${body}</p>`;f.md+='\n\n'+raw+'\n';f.html=f.html.replace('</main>',raw+'</main>');return span(raw,id)}
const raw=q=>q.claim.markdown
function cash({result='8',omitCash=false,extra=false}={}){const f=createCraftV3Fixture(),price=q('buy','用款购价','20','万元'),fee=q('fee','用款费用','1','万元'),cash=q('cash','自有资金','5','万元'),loan=q('loan','新贷','8','万元'),out=q('gap','净回款缺口',result,'万元');const claim=append(f,'balance',[price,fee,cash,loan,out].map(raw).join('；')+(extra?'，另需装修储备3万元':''));f.evidence.calculations.push({id:'balance',kind:'cash-balance',uses:[price,fee],sources:omitCash?[loan]:[cash,loan],result:out,claims:[claim]});return f}
function rent({period='月',rentUnit='元/月',amount='5000',multiple='300',result='150',visiblePeriod=period}={}){const f=createCraftV3Fixture(),r=q('rent','租金',amount,rentUnit),m=q('multiple',visiblePeriod+'租倍数',multiple,'倍'),out=q('price','估值',result,'万元'),claim=append(f,'rent-calc',[r,m,out].map(raw).join('；'));f.evidence.calculations.push({id:'rental',kind:'rent-multiple',rent:r,multiple:m,period,result:out,claims:[claim]});return f}
function interest({result='1.60',durationUnit='月'}={}){const f=createCraftV3Fixture(),principal=q('principal','过桥计息本金','100','万元'),rate=q('rate','期间利率','0.8','%/月'),periods=q('periods','计息期间','2',durationUnit),out=q('cost','过桥费用',result,'万元'),claim=append(f,'interest',[principal,rate,periods,out].map(raw).join('；'));f.evidence.calculations.push({id:'interest',kind:'simple-interest',principal,rate,periods,result:out,claims:[claim]});return f}
async function run(f){rebuildCraftV3Fixture(f);return evaluateReportCraftV2(f.artifacts,f.check,{browserExecutablePath:'/no-browser-for-bounded-test'})}
const get=(rows,id)=>rows.find(r=>r.id==='report-craft-'+id)
async function checkCalc(f,status,match){const r=get(await run(f),'calculations');assert.equal(r.status,status,r.detail);if(match)assert.match(r.detail,match)}

test('domain schema2 retains correct shared-base inverse-yield calculation',async()=>checkCalc(createCraftV3Fixture(),'passed'))
test('cash balance subtracts all declared funding sources',async()=>checkCalc(cash(),'passed'))
test('cash balance rejects the omitted own-funds subtraction',async()=>checkCalc(cash({result:'13'}),'failed',/requires 8/))
test('a small correct cash ledger cannot conceal a displayed omitted source',async()=>{const f=cash({result:'13',omitCash:true});await checkCalc(f,'failed',/undeclared numeric/);})
test('equal-valued omitted funding input is not hidden by numeric set membership',async()=>{const f=cash({result:'13',omitCash:true});f.md=f.md.replace('自有资金5万元','自有资金1万元');f.html=f.html.replace('自有资金5万元','自有资金1万元');f.evidence.calculations[1].claims[0].markdown=f.evidence.calculations[1].claims[0].markdown.replace('自有资金5万元','自有资金1万元');await checkCalc(f,'failed',/omitted repeated amount/);})
test('cash claim extra unlisted cash use is rejected',async()=>checkCalc(cash({extra:true}),'failed',/undeclared numeric/))
test('displayed input identity and currency unit must agree with ledger',async()=>{const f=cash();f.evidence.calculations[1].uses[0].unit='元';await checkCalc(f,'failed',/printed together/);})
test('duplicate input span cannot double-count a cash use',async()=>{const f=cash({result:'28'});f.evidence.calculations[1].uses.push(f.evidence.calculations[1].uses[0]);await checkCalc(f,'failed',/distinct visible/);})
test('monthly rent multiple does not multiply by twelve',async()=>checkCalc(rent(),'passed'))
test('annual rent multiple converts monthly input explicitly',async()=>checkCalc(rent({period:'年',multiple:'25'}),'passed'))
test('annual input with monthly multiple divides by twelve',async()=>checkCalc(rent({rentUnit:'元/年',amount:'60000'}),'passed'))
test('monthly multiple double annualisation fails',async()=>checkCalc(rent({result:'1800'}),'failed',/requires 150/))
test('declared annual multiple cannot bind monthly labelled prose',async()=>checkCalc(rent({period:'年',multiple:'25',visiblePeriod:'月'}),'failed',/basis/))
test('simple interest requires principal rate and matching period',async()=>checkCalc(interest(),'passed'))
test('missing principal cannot be replaced by a fee conclusion',async()=>{const f=interest();delete f.evidence.calculations[1].principal;await checkCalc(f,'failed',/principal/);})
test('mixing monthly rates and yearly duration fails',async()=>checkCalc(interest({durationUnit:'年'}),'failed',/periods differ/))
test('output rounding is tied to actual display precision',async()=>{await checkCalc(interest({result:'1.604'}),'failed',/display rounding/);await checkCalc(interest({result:'1.6'}),'passed');})
test('ledger cannot select arbitrary evaluation code',async()=>{const f=cash();f.evidence.calculations[1].kind='eval';await checkCalc(f,'failed',/no general evaluator/);})
for(const [name,body,pattern] of [['funding','自有资金5万元，新贷8万元，净回款缺口13万元。',/unbound cash-balance/],['rent','月租倍数300倍，绝对估值150万元。',/unbound rent-multiple/],['bridge','过桥费用7万元，月利率1.05%。',/unbound simple-interest/]])test('unlisted '+name+' paragraph cannot borrow inverse-yield PASS',async()=>{const f=createCraftV3Fixture();append(f,'unlisted',body);await checkCalc(f,'failed',pattern);})

function replaceClaim(f, calculationIndex, transform){const c=f.evidence.calculations[calculationIndex],before=c.claims[0].markdown,after=transform(before);f.md=f.md.replace(before,after);f.html=f.html.replace(before,after);c.claims[0].markdown=after;return f}
test('cash claim allows contextual year, Chinese/ISO dates and note numbers',async()=>{const f=cash();replaceClaim(f,1,s=>s.replace('>', '>第12项（注3），研究年份2026年，测算时点2026年8月1日，资料日期2026-08-01；'));await checkCalc(f,'passed');})
test('same bare number with an additional undeclared unit cannot borrow declared coverage',async()=>{const f=cash();replaceClaim(f,1,s=>s.replace('</p>','；另有支出1元</p>'));await checkCalc(f,'failed',/incompatible unit/);})
test('interest duration remains checked while dated context is ignored',async()=>{const f=interest();replaceClaim(f,1,s=>s.replace('>', '>2026年8月1日方案第2项（注1）；'));await checkCalc(f,'passed');})
function bridgeTotal({includeInterest=true,changeReference=false,wrongTotal=false}={}){const f=includeInterest?interest():createCraftV3Fixture();let cost=includeInterest?f.evidence.calculations[1].result:q('uncalculated-interest','过桥利息','1.60','万元');if(!includeInterest)append(f,'uncalculated',raw(cost));if(changeReference){cost=q('unrelated-interest','其他金额','1.60','万元');append(f,'unrelated',raw(cost));}const fee=q('service-fee','服务费','0.40','万元'),total=q('total-fee','过桥总费用',wrongTotal?'2.40':'2.00','万元'),claim=append(f,'fee-total','过桥利息1.60万元；'+raw(fee)+'；'+raw(total));f.evidence.calculations.push({id:'fee-total',kind:'money-sum',terms:[cost,fee],result:total,claims:[claim]});return f;}
test('bridge fee combines verified interest and a separately disclosed service fee',async()=>checkCalc(bridgeTotal(),'passed'))
test('money sum recomputes fee total and rejects an incorrect output',async()=>checkCalc(bridgeTotal({wrongTotal:true}),'failed',/requires 2/))
test('money sum cannot replace missing bridge principal with an uncomputed interest amount',async()=>checkCalc(bridgeTotal({includeInterest:false}),'failed',/unbound simple-interest/))
test('equal amount from an unrelated element cannot establish a verified interest dependency',async()=>checkCalc(bridgeTotal({changeReference:true}),'failed',/unbound simple-interest/))
test('generic monetary sum can add non-interest fees',async()=>{const f=createCraftV3Fixture(),a=q('a','费用甲','0.4','万元'),b=q('b','费用乙','3000','元'),out=q('total','费用合计','0.7','万元'),claim=append(f,'sum',[a,b,out].map(raw).join('；'));f.evidence.calculations.push({id:'sum',kind:'money-sum',terms:[a,b],result:out,claims:[claim]});await checkCalc(f,'passed');})

function primary(){const f=createCraftV3Fixture(),claim=append(f,'tax','合成辖区的示例税率1.2%，仅供测试数据。'),excerpt='测试条文规定在指定条件下采用示例税率。',url='https://agency.example.gov.cn/test-policy.html',source=append(f,'tax-source',`合成辖区；研究时点2026-08-01；测试公告〔2026〕1号；发布2026-01-01；生效2026-02-01；${url}；${excerpt}`);f.evidence.policyClaims=[{id:'tax',status:'primary-text',claim,asOf:'2026-08-01',jurisdiction:'合成辖区',source:{url,documentNumber:'测试公告〔2026〕1号',publishedAt:'2026-01-01',effectiveAt:'2026-02-01',excerpt,claim:source}}];return f}
async function checkPolicy(f,status,match){const r=get(await run(f),'policy-evidence');assert.equal(r.status,status,r.detail);if(match)assert.match(r.detail,match)}
test('complete policy provenance binding passes only its stated structural scope',async()=>checkPolicy(primary(),'passed',/No network retrieval or legal truth/))
test('a headline without operative text cannot serve as primary law',async()=>{const f=primary();delete f.evidence.policyClaims[0].source.excerpt;await checkPolicy(f,'failed',/excerpt/);})
test('policy source asOf preceding effective date fails',async()=>{const f=primary();f.evidence.policyClaims[0].asOf='2026-01-15';await checkPolicy(f,'failed',/not published\/effective/);})
test('a ledger URL absent from the actual visible source is rejected',async()=>{const f=primary();f.evidence.policyClaims[0].source.url='https://other.example.gov.cn/new.html';await checkPolicy(f,'failed',/visible/);})
test('an explicit unverified conditional assumption is not promoted to current law',async()=>{const f=createCraftV3Fixture(),claim=append(f,'conditional','本地税率1.2%为未核验假设，原文待核实，不能据此确定现行税额。');f.evidence.policyClaims=[{id:'conditional',status:'conditional',claim,asOf:'2026-08-01',jurisdiction:'本地',reason:'尚未取得官方原文及适用条件'}];await checkPolicy(f,'passed');})
test('conditional label only in ledger cannot conceal a definite tax assertion',async()=>{const f=createCraftV3Fixture(),claim=append(f,'conditional','本地现行税率1.2%。');f.evidence.policyClaims=[{id:'conditional',status:'conditional',claim,asOf:'2026-08-01',jurisdiction:'本地',reason:'尚未取得官方原文及适用条件'}];await checkPolicy(f,'failed',/actual report/);})
for(const [name,body,expected,pattern] of [
 ['assumption alone','本地税率1.2%为假设，仅用于测算。','failed',/unverified/],
 ['unverified current-law assumption','假设本地现行税率为1.2%，原文待核实。','failed',/must not assume/],
 ['unverified hypothetical scenario explicitly not current law','本地税率1.2%为未核验假设，不作为现行税率依据。','passed',null],
])test('conditional policy: '+name,async()=>{const f=createCraftV3Fixture(),claim=append(f,'conditional',body);f.evidence.policyClaims=[{id:'conditional',status:'conditional',claim,asOf:'2026-08-01',jurisdiction:'本地',reason:'尚未取得官方原文及适用条件'}];await checkPolicy(f,expected,pattern);})
test('unlisted tax claims cannot pass an empty policy ledger',async()=>{const f=createCraftV3Fixture();append(f,'tax','现行契税按90平方米分档。');await checkPolicy(f,'failed',/unbound policy/);})
test('old ledger is rejected by the new pack without mutating historical semantics',async()=>{const f=createCraftV3Fixture();f.evidence.schemaVersion=1;delete f.evidence.policyClaims;const rows=await run(f);assert.ok(rows.filter(r=>['chapter-structure','calculations','format-consistency','browser','policy-evidence'].some(id=>r.id==='report-craft-'+id)).every(r=>r.status==='failed'));})

// The exact published R11 MD/HTML/PDF are optional external regression inputs;
// their immutable hashes are checked before an in-memory schema-only adaptation.
const root=process.env.DSH_R11_AUDIT_JSON
if(root)test('fixed R11 A1 is rejected beyond its correct inverse-yield subcalculation',async()=>{
 const audit=JSON.parse(readFileSync(root)),entries=audit.files,bytes={}
 for(const role of ['md','html','pdf','ledger']){bytes[role]=readFileSync(entries[role].path);assert.equal(hash(bytes[role]),entries[role].sha256,'fixed R11 '+role+' hash')}
 const f=createCraftV3Fixture();f.md=bytes.md.toString();f.html=bytes.html.toString();f.pdf=bytes.pdf;f.evidence=JSON.parse(bytes.ledger);f.evidence.schemaVersion=2;f.evidence.policyClaims=[]
 const rows=await run(f);assert.equal(get(rows,'calculations').status,'failed');assert.match(get(rows,'calculations').detail,/unbound (cash-balance|rent-multiple|simple-interest)/);assert.equal(get(rows,'policy-evidence').status,'failed');assert.match(get(rows,'policy-evidence').detail,/unbound policy/);
 for(const role of ['md','html','pdf','ledger'])assert.equal(hash(readFileSync(entries[role].path)),entries[role].sha256,'original remains unchanged')
})
