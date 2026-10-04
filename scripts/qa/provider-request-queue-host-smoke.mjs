/** Actual Host stream waterfall, cross-scope admission, cancellation and routing. */
import { probePlugin, runPresetSettingsHostSmoke } from './preset-settings-host-smoke.mjs'
const adapter = `
      if(options.system?.startsWith('queue-fixture:')){
        assert.ok(ctx.agents.get(options.sessionId),'queue fixture must use a real live Agent');
        const label=options.system.slice('queue-fixture:'.length);
        queueEntries.push(label);queueActive++;queueMax=Math.max(queueMax,queueActive);
        try{
          if(label==='captain')await new Promise(resolve=>{releaseQueueFirst=resolve});
          yield {type:'block-start',index:0,blockType:'text'};
          yield {type:'text-delta',index:0,text:'queued local response'};
          yield {type:'block-end',index:0,block:{type:'text',text:'queued local response'}};
          yield {type:'finish',reason:{kind:'stop'}};
        }finally{queueActive--}
        return;
      }
`
const fixture = `
    await ctx.settings.update(ns,{providerRequestConcurrency:{[kimi.provider]:1}});
    assert.equal(ctx.settings.get(ns).providerRequestConcurrency[kimi.provider],1);
    const consume=async(agent,label,signal)=>{
      const chunks=[];
      for await(const chunk of agent.ctx.llm.stream({...kimi,sessionId:agent.id,system:'queue-fixture:'+label,messages:[],signal}))chunks.push(chunk);
      assert.equal(chunks.at(-1).type,'finish');return chunks;
    };
    const first=consume(captain,'captain',new AbortController().signal);
    await until(()=>queueActive===1,'first actual provider stream entered');
    const beforeMemberRequests=requests.length;
    queueProbeEnabled=true;
    const second=wake(captain,researcher,kimi,'kimi-researcher');second.catch(()=>{});
    const cancel=new AbortController();
    const canceled=assert.rejects(consume(captain,'canceled',cancel.signal),/queue canceled/);
    cancel.abort(new Error('queue canceled'));await canceled;
    await pause(30);
    assert.deepEqual(queueEntries,['captain'],'scoped member must wait behind captain; canceled request must not dispatch');
    assert.equal(requests.length,beforeMemberRequests,'real member request must not reach adapter while captain owns capacity');
    releaseQueueFirst();await Promise.all([first,second]);queueProbeEnabled=false;
    assert.deepEqual(queueEntries,['captain','member']);assert.equal(queueMax,1);assert.equal(queueActive,0);
    const queueProbe={actualHostWaterfall:true,hostSettingsConsumed:true,captainAndMemberScopesShareLimit:true,fifo:true,canceledRequestNeverDispatched:true,maxConcurrentAdapterStreams:queueMax,dispatchOrder:queueEntries.slice(),modelNetworkCalls:0};
`
function enhanced(workspace, nonce) {
  let source = probePlugin(workspace, nonce)
  const replace = (anchor, value) => {
    if(source.split(anchor).length !== 2)throw Error('QUEUE_PROBE_ANCHOR_CHANGED')
    source=source.replace(anchor,value)
  }
  replace('  let captainSessionId;', '  let captainSessionId,queueActive=0,queueMax=0,releaseQueueFirst,queueProbeEnabled=false; const queueEntries=[];')
  replace('    async *stream(options){', '    async *stream(options){'+adapter+`
      if(queueProbeEnabled && options.sessionId!==captainSessionId){assert.equal(queueActive,0,'real member adapter overlaps captain');queueMax=Math.max(queueMax,queueActive+1);queueEntries.push('member')}
`)
  replace('    await wake(captain,member,required,name);return member;', "    if(name!=='kimi-researcher')await wake(captain,member,required,name);return member;")
  const anchor="    const researcher=await add(captain,'kimi-researcher','researcher',kimi);"
  replace(anchor,anchor+fixture)
  replace('return {hostAndScopedPresetMounted:true','return {queueProbe,hostAndScopedPresetMounted:true')
  return source
}
runPresetSettingsHostSmoke({probePlugin:enhanced,kind:'provider-request-queue-real-host-smoke'})
  .then(value=>process.stdout.write(JSON.stringify(value,null,2)+'\n'))
  .catch(error=>{process.stderr.write(String(error.message).replace(/token=[^\s"']+/g,'token=[REDACTED]')+'\n');process.exitCode=1})
