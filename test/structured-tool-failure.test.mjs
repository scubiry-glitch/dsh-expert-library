import test from 'node:test'
import assert from 'node:assert/strict'
import { structuredFailureOutput, shellOperationKey, StructuredFailureBudget, installStructuredToolFailureGuard } from '../lib/structured-tool-failure.js'
const result = (text, extra={}) => ({isError:false,value:{exitCode:0,stdout:{text,truncated:false},...extra},content:[{type:'text',text}]})
const failure = result('{"ok":false,"error":"service temporarily unavailable"}')
test('complete single/multiline/repeated error envelopes are business failures',()=>{
 for(const text of ['{"ok":false,"error":"down"}','{\n"ok":false,\n"error":{"code":"UNAVAILABLE"}\n}','{"ok":false,"error":"down"}\n\n{"ok":false,"error":"down"}\n'])assert.equal(structuredFailureOutput(result(text)),true)
})
test('prose, nested records, mixed success, malformed JSON and empty series are not inferred failures',()=>{
 for(const text of ['example: {"ok":false,"error":"down"}','{"ok":true,"data":{"ok":false,"error":"down"}}','{"ok":false,"error":"down"}\n{"ok":true}','{"series":[]}','{"ok":false}','{"ok":false,"error":""}','{bad',''])assert.equal(structuredFailureOutput(result(text)),false,text)
})
test('native errors, nonzero exit, aborted/timed out/truncated/background results remain native',()=>{
 for(const r of [{isError:true,content:[]},result(failure.content[0].text,{exitCode:2}),result(failure.content[0].text,{aborted:true}),result(failure.content[0].text,{timedOut:true}),result(failure.content[0].text,{stdout:{text:failure.content[0].text,truncated:true}}),{isError:false,value:{kind:'background'},content:[]}])assert.equal(structuredFailureOutput(r),false)
})
test('operation identity ignores descriptions but distinguishes command, cwd and background semantics',()=>{
 const key=extra=>shellOperationKey({name:'bash',arguments:{command:'client query',...extra}})
 assert.equal(key({description:'try1'}),key({description:'try100',timeout:120000}))
 assert.notEqual(key({}),key({workdir:'/different'}));assert.notEqual(key({}),key({run_in_background:true}));assert.notEqual(key({}),key({command:'client other'}));assert.equal(shellOperationKey({name:'read',arguments:{command:'client query'}}),undefined)
})
test('failure budget isolates agents and commands, resets on success, admits bounded cooldown recovery',()=>{
 const b=new StructuredFailureBudget(),a={},other={};for(let i=0;i<3;i++)assert.equal(b.settled(a,'k',true,1000+i),i+1)
 assert.equal(b.denied(a,'k',1003),true);assert.equal(b.denied(other,'k',1003),false);assert.equal(b.denied(a,'other',1003),false)
 assert.equal(b.denied(a,'k',301002),false);assert.equal(b.settled(a,'k',true,301003),1);b.settled(a,'k',false,301004);assert.equal(b.denied(a,'k',301005),false)
})
function fixture(){const hooks={};installStructuredToolFailureGuard({on(name,fn){hooks[name]=fn}});const agent={};return {hooks,exec:{agent,name:'bash',arguments:{command:'client query'},signal:new AbortController().signal}}}
test('pipeline flags structured failures and denies fourth unchanged dispatch while preserving original evidence',async()=>{
 const {hooks,exec}=fixture();const allow=async()=>({kind:'allow'}),accept=async()=>({kind:'accept'})
 for(let i=0;i<3;i++){assert.equal((await hooks['tools/pre-execute'](exec,allow)).kind,'allow');const post=await hooks['tools/post-execute'](exec,failure,accept);assert.equal(post.kind,'block');assert.deepEqual(post.feedback[0],failure.content[0]);assert.match(post.feedback[1].text,/shell exit 0 did not establish business success/)}
 assert.equal((await hooks['tools/pre-execute']({...exec,arguments:{...exec.arguments,description:'try differently'}},allow)).kind,'deny')
 assert.equal((await hooks['tools/pre-execute']({...exec,agent:{}},allow)).kind,'allow')
 assert.equal((await hooks['tools/pre-execute']({...exec,name:'read'},allow)).kind,'allow')
})
test('upstream denials, rewritten results and native errors are not weakened or recounted',async()=>{
 const {hooks,exec}=fixture();const denial={kind:'deny',reason:'existing gate'};assert.equal(await hooks['tools/pre-execute'](exec,async()=>denial),denial)
 for(const decision of [{kind:'block',feedback:[]},{kind:'accept',content:[]},{kind:'accept',value:{ok:true}}])assert.equal(await hooks['tools/post-execute'](exec,failure,async()=>decision),decision)
 const accept={kind:'accept'};assert.equal(await hooks['tools/post-execute'](exec,{isError:true,content:[]},async()=>accept),accept)
})
