import type { TeamPlanWire } from './team-api.ts'
import css from './ActivityPanel.module.css'

/** Read-only graph from the Host's compiled task edges. The adjacent list owns bindings. */
export function ResearchDagGraph({ plan }: { plan: TeamPlanWire }) {
  const tasks = plan.preview.tasks
  const byId = new Map(tasks.map(task => [task.id, task]))
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const level = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!
    if (visiting.has(id)) return 0
    visiting.add(id)
    const value = 1 + Math.max(-1, ...(byId.get(id)?.dependsOn ?? []).filter(dep => byId.has(dep)).map(level))
    visiting.delete(id)
    depth.set(id, value)
    return value
  }
  for (const task of tasks) level(task.id)
  const layers = new Map<number, typeof tasks[number][]>()
  for (const task of tasks) layers.set(depth.get(task.id)!, [...(layers.get(depth.get(task.id)!) ?? []), task])
  const maxLayer = Math.max(0, ...layers.keys())
  const rows = Math.max(1, ...[...layers.values()].map(items => items.length))
  const width = 32 + (maxLayer + 1) * 170
  const height = 32 + rows * 70
  const points = new Map<string, { x: number; y: number }>()
  for (const [column, items] of layers) items.forEach((task, index) => points.set(task.id, {
    x: 16 + column * 170, y: 16 + index * 70 + (rows - items.length) * 35,
  }))
  return <div className={css.dagGraphViewport} data-plan-dag-graph>
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="计划 DAG：从左到右表示依赖，同列节点可并行">
      <title>计划 DAG</title><desc>从左到右表示依赖。同列任务在前置完成后可以并行。节点的专家和材料列在下方清单右侧。</desc>
      {tasks.flatMap(task => task.dependsOn.filter(dep => points.has(dep)).map(dep => {
        const source = points.get(dep)!, target = points.get(task.id)!
        return <path key={`${dep}/${task.id}`} className={css.dagGraphEdge} d={`M${source.x + 144},${source.y + 23} C${source.x + 157},${source.y + 23} ${target.x - 13},${target.y + 23} ${target.x},${target.y + 23}`}><title>{dep} → {task.id}</title></path>
      }))}
      {tasks.map(task => {
        const point = points.get(task.id)!
        return <g key={task.id} transform={`translate(${point.x},${point.y})`}>
          <rect width="144" height="46" rx="8" className={task.humanChoice === undefined ? css.dagGraphNode : css.dagGraphGate} />
          <text x="9" y="18" className={css.dagGraphId}>{task.id.length > 19 ? `${task.id.slice(0, 18)}…` : task.id}</text>
          <text x="9" y="36" className={css.dagGraphRole}>{task.humanChoice === undefined ? task.role : '用户确认门'}</text>
          <title>{task.id} · {task.subject ?? ''} · 前置：{task.dependsOn.join('、') || '无'}</title>
        </g>
      })}
    </svg>
  </div>
}
