import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const moduleUrl = new URL('../lib/state.js', import.meta.url).href
const stagedModuleUrl = new URL('../lib/staged-plan.js', import.meta.url).href
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function worker(code, args = []) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {withTeamLock} from ${JSON.stringify(moduleUrl)}; import * as fs from 'node:fs/promises'; import {join} from 'node:path'; const root=process.argv[1]; const lock=join(root,'.locks','team.lock'); ${code}`, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const done = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`worker exceeded 5s: ${output}`)) }, 5000)
    child.once('error', error => { clearTimeout(deadline); reject(error) })
    child.once('exit', code => { clearTimeout(deadline); code === 0 ? resolve(output) : reject(new Error(`worker exit ${code}: ${output}`)) })
  })
  return { child, done }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'team-orphan-lock-'))
  await mkdir(join(root, '.locks'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  const dead = worker('', [root]); await dead.done
  assert.throws(() => process.kill(dead.child.pid, 0), error => error.code === 'ESRCH')
  return { root, deadPid: dead.child.pid, lock: join(root, '.locks', 'team.lock') }
}

test('a fresh lock owned by a real exited PID is recovered promptly, without the old 60-second grace', async t => {
  const f = await fixture(t)
  await writeFile(f.lock, `${f.deadPid}\n${Date.now()}\n`)
  const start = Date.now()
  const child = worker(`await withTeamLock('team:'+root+':team',async()=>{ await fs.writeFile(join(root,'entered'),'yes') });`, [f.root])
  await child.done
  assert.ok(Date.now() - start < 2500, 'confirmed orphan should recover well inside the unchanged 30-second HTTP deadline')
  assert.equal(await readFile(join(f.root, 'entered'), 'utf8'), 'yes')
  await assert.rejects(stat(f.lock), { code: 'ENOENT' })
})

test('an old live-PID lock is never stolen; contender enters only after its owner releases', async t => {
  const f = await fixture(t), content = `${process.pid}\n1\nlive-owner\n`
  await writeFile(f.lock, content)
  await utimes(f.lock, new Date(0), new Date(0))
  const child = worker(`await fs.writeFile(join(root,'ready'),'yes'); await withTeamLock('team:'+root+':team',async()=>{ await fs.writeFile(join(root,'entered'),'yes') });`, [f.root])
  t.after(() => child.child.kill('SIGKILL'))
  for (let i = 0; i < 100; i++) { if (await stat(join(f.root, 'ready')).catch(() => false)) break; await delay(5) }
  await delay(100)
  assert.equal(await readFile(f.lock, 'utf8'), content)
  await assert.rejects(stat(join(f.root, 'entered')), { code: 'ENOENT' })
  await unlink(f.lock)
  await child.done
  assert.equal(await readFile(join(f.root, 'entered'), 'utf8'), 'yes')
  await assert.rejects(stat(join(f.root, '.locks', '.recovery')), { code: 'ENOENT' })
})

test('EPERM probing an owner fails closed even for an old lock', async t => {
  const f = await fixture(t), content = `${f.deadPid}\n1\npermission-denied\n`
  await writeFile(f.lock, content)
  await utimes(f.lock, new Date(0), new Date(0))
  const child = worker(`const originalKill=process.kill; process.kill=(pid,signal)=>{if(pid===Number(process.argv[2]))throw Object.assign(new Error('denied'),{code:'EPERM'});return originalKill(pid,signal)}; const prior=await fs.readFile(lock,'utf8'); const release=(async()=>{await new Promise(r=>setTimeout(r,150)); if(await fs.readFile(lock,'utf8')!==prior)throw Error('EPERM lock stolen'); await fs.writeFile(join(root,'preserved'),'yes'); await fs.unlink(lock)})(); await withTeamLock('team:'+root+':team',async()=>{}); await release;`, [f.root, String(f.deadPid)])
  await child.done
  assert.equal(await readFile(join(f.root, 'preserved'), 'utf8'), 'yes')
  await assert.rejects(stat(join(f.root, '.locks', '.recovery')), { code: 'ENOENT' })
})

test('two processes recovering one fresh orphan never overlap their critical sections', async t => {
  const f = await fixture(t)
  await writeFile(f.lock, `${f.deadPid}\n${Date.now()}\norphan\n`)
  await writeFile(join(f.root, 'count'), '0')
  const code = `while(!await fs.stat(join(root,'go')).catch(()=>false))await new Promise(r=>setTimeout(r,2)); for(let i=0;i<5;i++)await withTeamLock('team:'+root+':team',async()=>{const sentinel=await fs.open(join(root,'critical'),'wx');try{const n=Number(await fs.readFile(join(root,'count'),'utf8'));await new Promise(r=>setTimeout(r,20));await fs.writeFile(join(root,'count'),String(n+1));}finally{await sentinel.close();await fs.unlink(join(root,'critical'));}});`
  const children = [worker(code, [f.root]), worker(code, [f.root])]
  t.after(() => { for (const item of children) item.child.kill('SIGKILL') })
  await writeFile(join(f.root, 'go'), 'yes')
  await Promise.all(children.map(child => child.done))
  assert.equal(await readFile(join(f.root, 'count'), 'utf8'), '10')
  const claims = await readdir(join(f.root, '.locks', '.recovery'))
  assert.ok(claims.length >= 1 && claims.length <= 8)
  assert.ok(claims.every(name => name.endsWith('.claim')), 'no ordinary temporary files remain')
})

test('an exited reaper is recovered through a new bounded claim generation', async t => {
  const f = await fixture(t), content = `${f.deadPid}\n${Date.now()}\norphan\n`
  await writeFile(f.lock, content)
  const identity = await stat(f.lock)
  const digest = createHash('sha256').update(JSON.stringify([identity.dev, identity.ino, content])).digest('hex')
  const recovery = join(f.root, '.locks', '.recovery')
  await mkdir(recovery)
  await writeFile(join(recovery, `${digest}.claim`), `${f.deadPid}\n1\nfailed-reaper\n`)
  await worker(`await withTeamLock('team:'+root+':team',async()=>{await fs.writeFile(join(root,'entered'),'yes')});`, [f.root]).done
  assert.equal(await readFile(join(f.root, 'entered'), 'utf8'), 'yes')
  assert.equal((await readdir(recovery)).length, 2)
})

test('ordinary release preserves a replacement lock with a different ownership nonce', async t => {
  const f = await fixture(t)
  const child = worker(`await withTeamLock('team:'+root+':team',async()=>{await fs.unlink(lock);await fs.writeFile(lock,process.argv[2])});`, [f.root, `${process.pid}\n1\nreplacement-owner\n`])
  await child.done
  assert.equal(await readFile(f.lock, 'utf8'), `${process.pid}\n1\nreplacement-owner\n`)
})

test('orphan removal I/O refusal surfaces promptly instead of retrying forever', async t => {
  const f = await fixture(t)
  await writeFile(f.lock, `${f.deadPid}\n${Date.now()}\norphan\n`)
  const child = worker(`const {createRequire,syncBuiltinESMExports}=await import('node:module'); const builtin=createRequire(import.meta.url)('node:fs/promises'); const original=builtin.unlink; builtin.unlink=async path=>{if(path===lock)throw Object.assign(new Error('controlled unlink denied'),{code:'EACCES'});return original(path)};syncBuiltinESMExports();let caught;try{await withTeamLock('team:'+root+':team',async()=>{throw Error('should not enter')})}catch(error){caught=error}finally{builtin.unlink=original;syncBuiltinESMExports()}if(caught?.code!=='EACCES')throw Error('expected EACCES, received '+caught);console.log('refusal surfaced');`, [f.root])
  assert.match(await child.done, /refusal surfaced/)
})

test('staged-plan locking recovers a fresh legacy JSON lock owned by an exited process', async t => {
  const f = await fixture(t), planLock = join(f.root, 'plans', 'plan-fixture.lock')
  await mkdir(join(f.root, 'plans'))
  await writeFile(planLock, JSON.stringify({ pid: f.deadPid, acquiredAt: Date.now() }))
  const start = Date.now()
  await worker(`const {withStagedPlanLock}=await import(${JSON.stringify(stagedModuleUrl)}); await withStagedPlanLock(root,'plan-fixture',async()=>{await fs.writeFile(join(root,'entered'),'yes')});`, [f.root]).done
  assert.ok(Date.now() - start < 2500)
  assert.equal(await readFile(join(f.root, 'entered'), 'utf8'), 'yes')
  await assert.rejects(stat(planLock), { code: 'ENOENT' })
  assert.equal((await readdir(join(f.root, 'plans', '.recovery'))).filter(n => n.endsWith('.claim')).length, 1)
})

test('staged-plan locking honors a live legacy owner even after the old age threshold', async t => {
  const f = await fixture(t), planLock = join(f.root, 'plans', 'plan-fixture.lock')
  await mkdir(join(f.root, 'plans'))
  const content = JSON.stringify({ pid: process.pid, acquiredAt: 1 })
  await writeFile(planLock, content)
  await utimes(planLock, new Date(0), new Date(0))
  const child = worker(`const {withStagedPlanLock}=await import(${JSON.stringify(stagedModuleUrl)}); await fs.writeFile(join(root,'ready'),'yes');await withStagedPlanLock(root,'plan-fixture',async()=>{await fs.writeFile(join(root,'entered'),'yes')});`, [f.root])
  t.after(() => child.child.kill('SIGKILL'))
  for (let i=0;i<100;i++) { if(await stat(join(f.root,'ready')).catch(()=>false))break;await delay(5) }
  await delay(100)
  assert.equal(await readFile(planLock, 'utf8'), content)
  await assert.rejects(stat(join(f.root,'entered')), {code:'ENOENT'})
  await unlink(planLock)
  await child.done
  await assert.rejects(stat(join(f.root,'plans','.recovery')), {code:'ENOENT'})
})
