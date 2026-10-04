import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
test('passive summary exposes fatal turn errors and stops only when native sessions are inactive with durable blockers',()=>{
 const r=spawnSync('python3',['-I','-c',`import importlib.util
s=importlib.util.spec_from_file_location('observer','scripts/qa/round12-observer-summary.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
o={'sessions':[{'sessionId':'captain','name':'captain','assistantUsage':{'uniqueTurnSteps':2},'toolErrors':{'count':0},'secondsSinceLastEvent':10,'lastTurnEnd':{'kind':'error','code':'AUTH','error':'403 five-hour usage limit'},'openTurn':None}], 'teams':[{'id':'team','runtimeSummary':{'blockedMembers':1,'captainBlocked':True}}],'artifacts':{'fileCount':0},'usageTotals':{}}
l={'sessions':[{'sessionId':'captain','running':False}],'checkedAt':'now','goal':None}
a={'status':'PASS'}
r=m.summarize(o,l,a,{},0);assert r['stopObservationReason']=='non_running_runtime_block';assert r['sessions'][0]['lastTurnEnd']['code']=='AUTH';assert r['acceptance']=='NOT_EVALUATED_BY_OBSERVER'
l['sessions'][0]['running']=True;assert m.summarize(o,l,a,{},0)['stopObservationReason'] is None
l['sessions'][0]['running']=False;o['teams']=[];assert m.summarize(o,l,a,{},0)['stopObservationReason'] is None
l['goal']={'phase':'complete'};assert m.summarize(o,l,a,{},0)['stopObservationReason']=='non_running_goal_complete'
assert m.summarize(o,l,a,{'status':'paused_for_next_optimization'},0)['stopObservationReason']=='frozen_failed_sample'
print('PASS')`],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'PASS')
})
