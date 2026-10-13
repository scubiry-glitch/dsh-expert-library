/** One-time, lock-safe migration of large legacy team.json files.
 * Usage: node compact-team-files.mjs /absolute/path/to/lib/state.js STATE_ROOT BACKUP_ROOT
 * Run as the DSH service owner after the new state.js is installed and restarted.
 */
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [modulePath, stateRoot, backupRoot] = process.argv.slice(2)
if (!modulePath || !stateRoot || !backupRoot || [modulePath, stateRoot, backupRoot].some(path => !path.startsWith('/'))) {
  throw new Error('expected absolute state module path, state root, and backup root')
}
const { readTeam, writeTeam, withTeamLock } = await import(pathToFileURL(resolve(modulePath)).href)
await mkdir(backupRoot, { recursive: true })
for (const entry of await readdir(stateRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue
  const file = join(stateRoot, entry.name, 'team.json')
  const info = await stat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!info || info.size < 1_000_000) continue
  await withTeamLock(`team:${stateRoot}:${entry.name}`, async () => {
    const before = await readFile(file)
    const original = await readTeam(stateRoot, entry.name)
    assert.ok(original, `missing valid team ${entry.name}`)
    const backup = join(backupRoot, `${entry.name}.json`)
    await copyFile(file, backup, constants.COPYFILE_EXCL)
    await writeTeam(stateRoot, original)
    try {
      const restored = await readTeam(stateRoot, entry.name)
      assert.deepEqual(restored, original)
    } catch (error) {
      const temporary = `${file}.restore-${process.pid}`
      await copyFile(backup, temporary)
      await rename(temporary, file)
      throw error
    }
    const after = (await stat(file)).size
    console.log(JSON.stringify({ team: entry.name, before: before.length, after,
      reductionPercent: Number(((1 - after / before.length) * 100).toFixed(1)) }))
  })
}
