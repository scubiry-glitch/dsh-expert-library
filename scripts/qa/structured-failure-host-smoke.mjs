/** Actual Host dispatch regression, with a scoped deterministic shell fixture. */
import { probePlugin, runPresetSettingsHostSmoke } from './preset-settings-host-smoke.mjs'
const fixture = `
    let shellDispatches=0;
    captain.ctx.tools.register({name:'bash',description:'Deterministic local shell-result fixture; no process or network',
      parameters:{type:'object',properties:{command:{type:'string'},description:{type:'string'}},required:['command']},
      output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:value.stdout.text}]},
      execute:async args=>{shellDispatches++;return {exitCode:0,stdout:{text:args.command==='fixture healthy'?'{"ok":true,"value":1}':'{"ok":false,"error":"service temporarily unavailable"}',truncated:false},stderr:{text:'',truncated:false},aborted:false,timedOut:false}}});
    const dispatch=description=>captain.ctx.tools.execute({agent:captain,name:'bash',arguments:{command:'fixture unavailable',description},callId:'fixture-'+randomUUID(),signal:new AbortController().signal});
    for(let i=0;i<3;i++){const r=await dispatch('attempt '+i);assert.equal(r.isError,true,'JSON business failure must be visible as tool error');assert.match(JSON.stringify(r.content),/STRUCTURED_TOOL_FAILURE/);assert.match(JSON.stringify(r.content),/service temporarily unavailable/)}
    const blocked=await dispatch('renamed attempt');assert.equal(blocked.isError,true);assert.match(JSON.stringify(blocked.content),/REPEATED_STRUCTURED_TOOL_FAILURE/);assert.equal(shellDispatches,3,'fourth attempt must not enter shell body');
    const healthy=await captain.ctx.tools.execute({agent:captain,name:'bash',arguments:{command:'fixture healthy'},callId:'fixture-'+randomUUID(),signal:new AbortController().signal});assert.equal(healthy.isError,false);assert.equal(shellDispatches,4,'independent work remains executable');
    const failureGuardProbe={businessFailureIsToolError:true,originalErrorPreserved:true,fourthAttemptDeniedBeforeDispatch:true,changedDescriptionCannotReset:true,independentWorkAllowed:true,shellDispatches,networkCalls:0};
`
function enhanced(workspace,nonce){
 let source=probePlugin(workspace,nonce)
 const anchor='    const captain=handle.agent;'
 if(source.split(anchor).length!==2)throw Error('PROBE_ANCHOR_CHANGED')
 source=source.replace(anchor,anchor+fixture).replace('return {hostAndScopedPresetMounted:true','return {failureGuardProbe,hostAndScopedPresetMounted:true')
 return source
}
runPresetSettingsHostSmoke({probePlugin:enhanced,kind:'structured-failure-real-host-smoke'})
 .then(value=>process.stdout.write(JSON.stringify(value,null,2)+'\n'))
 .catch(error=>{process.stderr.write(String(error.message).replace(/token=[^\s"']+/g,'token=[REDACTED]')+'\n');process.exitCode=1})
