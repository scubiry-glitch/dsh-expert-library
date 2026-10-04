import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { assertTeamRunnable, haltTeam, readTeam, resumeTeam } from '../lib/state.js'

test('team lock serializes read-modify-write across worker processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-team-lock-'))
  try {
    await mkdir(join(root, 'team'), { recursive: true })
    await writeFile(join(root, 'team', 'value'), '0')
    const stateModule = new URL('../lib/state.js', import.meta.url).href
    const worker = `import { withTeamLock } from ${JSON.stringify(stateModule)}; import { readFile, writeFile } from 'node:fs/promises'; const root=process.argv[1]; await withTeamLock('team:'+root+':team', async()=>{ const file=root+'/team/value'; const n=Number(await readFile(file,'utf8')); await new Promise(resolve=>setTimeout(resolve,40)); await writeFile(file,String(n+1)); });`
    await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', worker, root], { stdio: 'ignore' })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)))
    })))
    assert.equal(await readFile(join(root, 'team', 'value'), 'utf8'), '4')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('halt and resume are durable and require explicit reasons', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-halt-'))
  try {
    await mkdir(join(root, 'team'), { recursive: true })
    await writeFile(join(root, 'team', 'team.json'), JSON.stringify({
      id: 'team', name: 'T', captainSessionId: 'captain', createdAt: 1,
      members: [], tasks: [], taskSeq: 0,
    }))
    await assert.rejects(() => haltTeam(root, 'team', '  '), /halt reason must not be empty/)
    const halted = await haltTeam(root, 'team', 'operator pause')
    assert.equal(halted.halted, true)
    assert.throws(() => assertTeamRunnable(halted), /TEAM_HALTED/)
    assert.equal((await readTeam(root, 'team')).haltReason, 'operator pause')
    await assert.rejects(() => resumeTeam(root, 'team', ''), /resume reason must not be empty/)
    const resumed = await resumeTeam(root, 'team', 'operator resume')
    assert.equal(resumed.halted, false)
    assert.doesNotThrow(() => assertTeamRunnable(resumed))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
