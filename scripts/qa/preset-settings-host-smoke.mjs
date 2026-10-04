/**
 * Actual Host + scoped preset + continuable spawn model-routing regression.
 * Run after building the candidate: node scripts/qa/preset-settings-host-smoke.mjs
 * Only local deterministic adapters run. No production profile or session is read.
 * stdout is a redacted JSON receipt; stderr contains bounded startup progress.
 */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const hostModules = '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const moduleUrl = path => JSON.stringify(pathToFileURL(path).href)
const exec = promisify(execFile)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** Retain errors and the loader's inactive-service rows, never login banners. */
export function safeHostDiagnostics(output) {
  return String(output).replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)
    .filter(line => /error|failed|cannot|missing|unknown|invalid|not found|ERR_|invariant|SyntaxError|TypeError|at file:|pending \(waiting for services?:|fiber state/i.test(line))
    .map(line => line
      .replace(/https?:\/\/\S+/g, '[URL REDACTED]')
      .replace(/\b(?:token|sid|nonce|api[_ -]?key|password|secret|cookie|authorization)\b["']?\s*[:=].*/gi, '[SENSITIVE FIELD REDACTED]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]+/g, '[KEY REDACTED]')
      .slice(0, 600))
    .slice(-16)
}

// Reuse the qualification controller's exact identity algorithm. Its import is
// inert: no production Client is constructed and -B forbids bytecode writes.
async function qualificationIdentity(workspace) {
  const source = [
    'import importlib.util,json,pathlib,sys',
    'sys.dont_write_bytecode=True',
    'root=pathlib.Path(sys.argv[1])',
    'spec=importlib.util.spec_from_file_location("preset_probe_identity",root/"scripts/qa/round12-real-rerun.py")',
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'result={"runtime":module.runtime_at(root),"domain":module.domain_identity(root)}',
    'if len(sys.argv)>2: result["installedDomain"]=module.domain_identity(pathlib.Path(sys.argv[2]))',
    'print(json.dumps(result,separators=(",",":")))',
  ].join('\n')
  const result = await exec('python3', ['-B', '-c', source, repo, ...(workspace === undefined ? [] : [workspace])], {
    cwd: repo, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, timeout: 30000, maxBuffer: 1024 * 1024,
  })
  return JSON.parse(result.stdout)
}

export function probePlugin(workspace, nonce) {
  return `
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LlmAdapter } from ${moduleUrl(join(hostModules, 'dsh-llm/lib/index.js'))};
import { scopeOf } from ${moduleUrl(join(hostModules, 'dsh-scope/lib/index.js'))};
import { deliverToMember } from ${moduleUrl(join(repo, 'lib/members.js'))};
import { resolveLibrary } from ${moduleUrl(join(repo, 'lib/expert-library/registry.js'))};
import { EXPERT_LIBRARY_SETTINGS_NAMESPACE as ns } from ${moduleUrl(join(repo, 'lib/settings.js'))};
import * as expertToolsPreset from ${moduleUrl(join(repo, 'lib/preset.js'))};
export const name='preset-settings-host-probe';
export const inject=['tools','webServer','agents','subagents','llm','agentPresets','settings'];
const workspace=${JSON.stringify(workspace)},teamId='preset-settings-probe';
const oldRoute={provider:'deepseek-official',model:'deepseek-v4-flash',reasoningEffort:'max'};
const kimi={provider:'kimi-coding',model:'kimi-for-coding'};
// This synthetic model only exists in the in-memory adapter; it is not a live Kimi model claim.
const hot={provider:'kimi-coding',model:'local-settings-hot-v2'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){const deadline=Date.now()+15000;while(Date.now()<deadline){if(await check())return;await pause(20)}throw Error('Timed out: '+label)}
const state=async()=>JSON.parse(await readFile(join(workspace,'expert-teams',teamId,'team.json'),'utf8'));
const route=value=>({provider:value.provider,model:value.model,...(value.reasoningEffort===undefined?{}:{reasoningEffort:value.reasoningEffort})});
export function apply(ctx){
  const requests=[],labels=new Map(),expected=new Map(),adapterFailures=[];
  let captainSessionId;
  class Adapter extends LlmAdapter{
    providerInfo(provider){return {id:provider,name:'Local deterministic routing fixture'}}
    async listModels(provider){return (provider===oldRoute.provider?[oldRoute.model]:[kimi.model,hot.model]).map(id=>({provider,id,name:'Local fixture: '+id}))}
    async resolveModel(provider,model){
      assert.ok((await this.listModels(provider)).some(row=>row.id===model),'unrecognized fixture model');
      return {provider,id:model,name:'Local routing fixture',context:{contextWindow:128000},
        ...(provider===oldRoute.provider?{reasoning:{efforts:[{id:'max',name:'Maximum'}],defaultEffort:'max'}}:{})};
    }
    async *stream(options){
      try{
        const live=ctx.agents.get(options.sessionId);assert.ok(live,'real LLM request requires a live Agent');
        const required=expected.get(options.sessionId);assert.ok(required,'unexpected model request; fixture only wakes named members');
        assert.deepEqual(route(options),required,'actual adapter request must use the expected frozen member route');
        assert.ok(options.messages.some(message=>message.role==='system'),'real model request must have a system prompt');
        const member=options.sessionId!==captainSessionId;
        if(member){
          assert.ok(options.tools.some(tool=>tool.name==='expert_teams_quality_review'),'real member request must carry member tools');
          assert.ok(!options.tools.some(tool=>tool.name==='expert_teams_add_member'),'member may not delegate');
        }else assert.ok(options.tools.some(tool=>tool.name==='expert_teams_add_member'),'captain settlement preserves scoped captain tools');
        requests.push({label:labels.get(options.sessionId),...route(options),
          inputSha256:createHash('sha256').update(JSON.stringify(options.messages)).digest('hex'),
          liveAgent:true,systemMessage:true,member,source:'LlmAdapter.stream GenerateOptions'});
      }catch(error){adapterFailures.push(error.message);throw error}
      yield {type:'block-start',index:0,blockType:'text'};
      yield {type:'text-delta',index:0,text:'Local deterministic routing probe complete.'};
      yield {type:'block-end',index:0,block:{type:'text',text:'Local deterministic routing probe complete.'}};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter([oldRoute.provider,kimi.provider],new Adapter()));
  const call=(captain,name,args)=>{
    const scope=scopeOf(captain.ctx);assert.ok(scope,'captain must have a real agent scope');
    const definition=captain.ctx.tools.get('expert_teams_'+name,scope);
    assert.ok(definition,'missing scoped tool '+name);
    assert.notEqual(definition,ctx.tools.get('expert_teams_'+name),'captain must resolve scoped preset tool, not Host definition');
    return definition.execute(args,{agent:captain,signal:new AbortController().signal});
  };
  const wake=async(captain,member,required,label)=>{
    labels.set(member.member_id,label);expected.set(member.member_id,required);
    const before=requests.length;
    assert.equal(await deliverToMember(ctx,captain,member.member_id,'Execute one local deterministic routing probe.',new AbortController().signal),true);
    await until(()=>requests.slice(before).some(request=>request.label===label)||adapterFailures.length>0,'actual member model request');
    assert.deepEqual(adapterFailures,[]);
    const live=ctx.agents.get(member.member_id);if(live)await live.whenIdle();
    assert.deepEqual(adapterFailures,[]);
    assert.ok(requests.slice(before).some(request=>request.label===label));
    return requests.slice(before).find(request=>request.label===label);
  };
  const add=async(captain,name,expert,required)=>{
    const before=requests.filter(request=>request.member).length;
    const member=await call(captain,'add_member',{name,...(expert===undefined?{role:'local fixture member'}:{expert})});
    const live=ctx.agents.get(member.member_id);if(live)await live.whenIdle();
    assert.deepEqual(adapterFailures,[],'quiet member bootstrap must not attempt an unexpected model request');
    assert.equal(requests.filter(request=>request.member).length,before,'quiet member bootstrap must not generate a model request');
    assert.deepEqual({provider:member.provider,model:member.model}, {provider:required.provider,model:required.model});
    assert.equal(member.reasoning_effort,required.reasoningEffort);
    await wake(captain,member,required,name);return member;
  };
  let run;
  const exercise=async()=>{
    assert.deepEqual(ctx.llm.listProviders().map(value=>value.id).sort(),[oldRoute.provider,kimi.provider].sort(),'only local adapters may be registered');
    assert.equal(ctx.settings.describe().filter(value=>value.ns===ns).length,1,'Host owns exactly one settings namespace');
    const library=await resolveLibrary(ctx,workspace,'knowledge');
    for(const id of ['researcher','security-reviewer'])assert.deepEqual(library.experts.get(id).model,oldRoute,'fixture must start from real baked Deepseek expert route');
    captainSessionId='preset-settings-captain-'+randomUUID();
    labels.set(captainSessionId,'captain-settlement');expected.set(captainSessionId,kimi);
    const handle=await ctx.agents.create({sessionId:captainSessionId,
      agentOptions:kimi,meta:{cwd:workspace,agentPreset:'standard'},
      setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'standard');agentCtx.plugin(expertToolsPreset,{
        stateDir:'expert-teams',memberProvider:'spawn',memberModel:oldRoute,memberMaxDepth:0,maxMembers:8,maxActiveMembers:8})}});
    const captain=handle.agent;
    await until(()=>captain.ctx.tools.get('expert_teams_add_member',scopeOf(captain.ctx))!==ctx.tools.get('expert_teams_add_member'),'scoped preset registration');
    await call(captain,'create',{name:teamId,description:'Synthetic routing regression only; no business task or network inference'});
    const oldMember=await add(captain,'old-researcher','researcher',oldRoute);
    await ctx.settings.update(ns,{defaultModel:kimi,expertModelOverrides:{researcher:kimi,'security-reviewer':kimi},maxMembers:8,maxActiveMembers:8});
    const researcher=await add(captain,'kimi-researcher','researcher',kimi);
    await add(captain,'kimi-security-reviewer','security-reviewer',kimi);
    await add(captain,'kimi-default-member',undefined,kimi);
    // Same captain and same tool definitions, without a remount or restart.
    await ctx.settings.update(ns,{defaultModel:hot,expertModelOverrides:{researcher:hot}});
    await add(captain,'hot-researcher','researcher',hot);
    await add(captain,'hot-default-member',undefined,hot);
    await wake(captain,oldMember,oldRoute,'old-researcher-after-hot-update');
    await wake(captain,researcher,kimi,'kimi-researcher-after-hot-update');
    const durable=(await state()).members.map(member=>({name:member.name,...route(member)}));
    assert.deepEqual(route(durable.find(member=>member.name==='old-researcher')),oldRoute);
    assert.deepEqual(route(durable.find(member=>member.name==='kimi-researcher')),kimi);
    assert.deepEqual(route(durable.find(member=>member.name==='hot-researcher')),hot);
    assert.equal(ctx.settings.describe().filter(value=>value.ns===ns).length,1,'scoped preset must never register the Host namespace again');
    assert.deepEqual(adapterFailures,[]);
    return {hostAndScopedPresetMounted:true,scopedToolIdentityVerified:true,settingsNamespaceRegistrations:1,
      originalBuiltinRoutes:{researcher:oldRoute,'security-reviewer':oldRoute},
      assertions:{expertOverrideResearcher:true,expertOverrideSecurityReviewer:true,defaultModelOverridesPresetMemberModel:true,
        hotUpdateWithoutCaptainRemount:true,oldDeepseekMemberFrozen:true,previousKimiMemberFrozen:true,actualGenerateRequests:true,quietMemberBootstrap:true},
      requests,memberGenerateRequests:requests.filter(request=>request.member),captainSettlementRequests:requests.filter(request=>!request.member),
      durableMembers:durable,paidModelCalls:0,modelNetworkCalls:0,
      limitations:['Deterministic in-memory adapters exercise Host request routing, not remote model availability or model reasoning.',
        'local-settings-hot-v2 is a synthetic model id, used solely to prove settings hot updates.',
        'The probe directly invokes the registered scoped tool definitions; it does not test model choice of tool calls or approval UI.']};
  };
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/plugins/preset-settings-host-smoke',handler:async(req,res)=>{
    if(req.headers['x-smoke-nonce']!==${JSON.stringify(nonce)}){res.writeHead(403);res.end();return}
    try{
      const action=new URL(req.url,'http://localhost').searchParams.get('action');
      let result;
      if(action==='ready'){
        assert.ok(ctx.tools.get('expert_teams_add_member'));assert.ok(ctx.settings.get(ns));
        result={ready:true};
      }else if(action==='run'&&req.method==='POST'){run??=exercise();result=await run}
      else{res.writeHead(404);res.end();return}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
    }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}))}
  }}));
}
`
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

export async function runPresetSettingsHostSmoke(options = {}) {
  const runtimePaths = ['lib/index.js', 'lib/preset.js', 'lib/preset-settings.js', 'lib/settings.js', 'lib/tools.js', 'lib/team-core.js', 'lib/members.js']
  const identity = async () => Object.fromEntries(await Promise.all(runtimePaths.map(async path => [path, sha256(await readFile(join(repo, path)))])))
  const before = await identity()
  const qualifiedBefore = await qualificationIdentity()
  const root = await mkdtemp(join(tmpdir(), 'preset-settings-real-host-'))
  const workspace = join(root, 'workspace'), dshHome = join(root, 'dsh-home'), probeRoot = join(root, 'probe-plugin')
  const profile = 'preset-settings-smoke', profileRoot = join(dshHome, 'profiles', profile)
  const port = await freePort(), nonce = randomBytes(24).toString('hex')
  // Do not forward API keys, production DSH_HOME, or production session paths.
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', DSH_HOME: dshHome, CI: '1', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }
  let child, hostOutput = '', cookie
  const progress = message => process.stderr.write('PRESET_SETTINGS_HOST ' + message + '\n')
  const command = async (file, args) => {
    try { return await exec(file, args, { cwd: root, env, timeout: 240000, maxBuffer: 8 * 1024 * 1024 }) }
    catch (error) { throw new Error('ISOLATED_COMMAND_FAILED: ' + JSON.stringify({ command: file, code: error.code,
      diagnostics: safeHostDiagnostics(String(error.stderr ?? '') + '\n' + String(error.stdout ?? '')) })) }
  }
  const stop = async () => {
    if (!child) return
    const previous = child; child = undefined
    try { process.kill(-previous.pid, 'SIGTERM') } catch {}
    await Promise.race([new Promise(resolve => previous.exitCode !== null || previous.signalCode !== null ? resolve() : previous.once('close', resolve)), pause(5000)])
    if (previous.exitCode === null && previous.signalCode === null) {
      try { process.kill(-previous.pid, 'SIGKILL') } catch {}
      await new Promise(resolve => previous.once('close', resolve))
    }
  }
  const request = async (action, method = 'GET') => {
    const response = await fetch('http://127.0.0.1:' + port + '/plugins/preset-settings-host-smoke?action=' + action, {
      method, headers: { 'x-smoke-nonce': nonce, ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(action === 'run' ? 120000 : 1500),
    })
    const body = await response.text()
    assert.equal(response.status, 200, action + ': ' + body.slice(0, 1800))
    return JSON.parse(body)
  }
  try {
    await mkdir(workspace, { recursive: true }); await mkdir(probeRoot, { recursive: true })
    await cp(join(repo, 'domain-packs', 'zhijian-realestate'), join(workspace, 'domain-packs', 'zhijian-realestate'), { recursive: true, errorOnExist: true, force: false })
    assert.deepEqual((await qualificationIdentity(workspace)).installedDomain, qualifiedBefore.domain, 'Installed fixture pack must match the candidate')
    await writeFile(join(probeRoot, 'package.json'), JSON.stringify({ name: 'preset-settings-host-probe', version: '0.0.0', type: 'module', main: 'index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(probeRoot, 'index.mjs'), (options.probePlugin ?? probePlugin)(workspace, nonce))
    await writeFile(join(probeRoot, 'cordis.patch.yml'), '- insert:\n    - id: preset-settings-probe\n      name: preset-settings-host-probe\n')
    // Keep credentials: Host connection/authorization explicitly inject it.
    // Its file and dotenv sources resolve only in temporary DSH_HOME/workspace;
    // the allowlisted environment above forwards no production credentials.
    // Exact production route names belong exclusively to the local probe adapter.
    const isolationPatch = join(root, 'isolation.patch.yml')
    await writeFile(isolationPatch, ['llm-deepseek', 'llm-pi-ai', 'session-title-llm', 'session-telemetry-otel'].map(id => '- id: ' + id + '\n  disabled: true\n').join(''))
    progress('initializing isolated profile')
    await command('dsh', ['--from-default-profile', 'web', '--profile', profile, '--help'])
    progress('installing candidate and local probe into isolated profile')
    await command('dsh', ['plugin', '--profile', profile, 'add', repo])
    await command('dsh', ['plugin', '--profile', profile, 'add', probeRoot])
    // Same optional-peer compatibility seam as the established rc.8 Host probes.
    const peerDir = join(profileRoot, 'node_modules', '@deepseek-ai')
    await mkdir(peerDir, { recursive: true })
    await symlink(join(repo, 'node_modules/@deepseek-ai/dsh-settings'), join(peerDir, 'dsh-settings'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
    progress('starting isolated Host with real model adapters disabled')
    child = spawn('dsh', ['--profile', profile, '--patch', isolationPatch, '--host', '127.0.0.1', '--port', String(port)], { cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let spawnError
    child.once('error', error => { spawnError = error })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { hostOutput = (hostOutput + chunk).slice(-16000) })
    const started = Date.now(); let ready = false, lastError
    while (Date.now() - started < 180000) {
      if (spawnError) throw new Error('HOST_SPAWN_' + (spawnError.code ?? 'ERROR'))
      if (child.exitCode !== null) throw new Error('HOST_EXIT_' + child.exitCode + ': ' + JSON.stringify(safeHostDiagnostics(hostOutput)))
      try {
        if (!cookie) {
          const match = hostOutput.match(/https?:\/\/[^\s?]+\/\?token=([^\s]+)/)
          if (!match) throw new Error('Isolated Host browser authentication not ready')
          const login = await fetch('http://127.0.0.1:' + port + '/?token=' + encodeURIComponent(match[1]), { redirect: 'manual', signal: AbortSignal.timeout(1500) })
          cookie = login.headers.get('set-cookie')?.split(';')[0]; await login.body?.cancel()
          assert.ok(cookie, 'Isolated Host browser cookie not ready')
        }
        await request('ready'); ready = true; break
      } catch (error) { lastError = error }
      await pause(500)
    }
    if (!ready) throw new Error('HOST_NOT_READY: ' + String(lastError?.message).slice(0, 1000)
      + '; diagnostics=' + JSON.stringify(safeHostDiagnostics(hostOutput)))
    const startupMs = Date.now() - started
    progress('checking real scoped spawn requests and settings hot updates')
    const result = await request('run', 'POST')
    await stop()
    assert.deepEqual(await identity(), before, 'Candidate runtime changed during probe')
    const qualifiedAfter = await qualificationIdentity(workspace)
    assert.deepEqual(qualifiedAfter.runtime, qualifiedBefore.runtime, 'Qualified runtime changed during probe')
    assert.deepEqual(qualifiedAfter.domain, qualifiedBefore.domain, 'Candidate domain pack changed during probe')
    assert.deepEqual(qualifiedAfter.installedDomain, qualifiedBefore.domain, 'Installed domain pack changed during probe')
    return { kind: options.kind ?? 'preset-settings-real-host-smoke', status: 'PASS', generatedAt: new Date().toISOString(),
      isolated: true, productionTouched: false, realProviderAdaptersDisabled: true, credentialPluginDisabled: false,
      isolatedCredentialStore: true, credentialStoreIsolation: { dshHome: 'temporary fixture directory', credentialEnvironmentForwarded: false },
      businessApiCalls: 0, realLlmCalls: 0, candidateRuntimeSha256: qualifiedBefore.runtime.sha256,
      candidateRuntimeFileCount: qualifiedBefore.runtime.fileCount, domainPackIdentity: qualifiedBefore.domain,
      startupMs, candidateCriticalModules: before, ...result, stopped: true, cleaned: true }
  } finally {
    await stop()
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPresetSettingsHostSmoke().then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => {
    // Never dump execFile objects or Host output: they may contain local login tokens.
    process.stderr.write(String(error?.code === 'ERR_ASSERTION' ? error.message : error?.code ? 'HOST_SMOKE_' + error.code : error?.message ?? 'HOST_SMOKE_FAILED').replace(/token=[^\s"']+/g, 'token=[REDACTED]') + '\n')
    process.exitCode = 1
  })
}
