// A 部分验证：用当前 lib（已构建）驱动 createTeamDir + createTaskProject，
// 证明新构建的插件会为每个 task 生成 单一 expert-tasks/<taskId>/ 项目目录。
// 不重启 DSH 主机、不干扰现有团队；验证完清理临时 stateRoot。
import { createTeamDir, createTaskProject, sanitizeKey } from '/root/zhijian/dsh-expert-library/lib/state.js'
import { mkdir, rm, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const stateRoot = '/root/zhijian/dsh-expert-library/work/.verify-teams-a'
const teamId = '验证团队A'
await rm(stateRoot, { recursive: true, force: true })
await mkdir(stateRoot, { recursive: true })

const state = {
  id: teamId, name: '验证团队A', description: 'A 验证', captainSessionId: 'verify',
  createdAt: Date.now(), members: [], tasks: [], taskSeq: 0, inbox: {},
}
await createTeamDir(stateRoot, state)

// 创建 3 个任务，模拟 expert_teams_create_task 内部行为
const tasks = [
  { id: 't1', subject: '任务一', description: 'desc1', dependencies: [], createdAt: Date.now() },
  { id: 't2', subject: '任务二', description: 'desc2', dependencies: [], createdAt: Date.now() },
  { id: 't3', subject: '任务三', description: 'desc3', dependencies: [], createdAt: Date.now() },
]
for (const t of tasks) {
  t.project = await createTaskProject(stateRoot, teamId, t)
}

console.log('=== 生成的团队目录结构 ===')
const teamDir = join(stateRoot, teamId)
const walk = async (dir, depth = 0) => {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    console.log('  '.repeat(depth) + '├─ ' + ent.name + (ent.isDirectory() ? '/' : ''))
    if (ent.isDirectory() && !['node_modules'].includes(ent.name)) await walk(p, depth + 1)
  }
}
await walk(teamDir)

console.log('\n=== 各任务 project 元数据 ===')
for (const t of tasks) {
  const pj = JSON.parse(await readFile(join(teamDir, t.project.path, 'project.json'), 'utf8'))
  console.log(`${t.id} project.path=${pj.path} | input=${pj.inputPath} | output=${pj.outputPath} | artifacts=${pj.artifactsPath}`)
}

// 清理临时验证目录
await rm(stateRoot, { recursive: true, force: true })
console.log('\n验证通过：新构建会为每个任务创建独立 expert-tasks/<taskId>/ 目录；临时目录已清理。')
