/**
 * Live end-to-end verification for dsh-expert-library.
 *
 * Drives the real compiled plugin (lib/) through the full scenario flow —
 * expert_teams_scenario_apply → create team → add expert members (persona +
 * preset model route + knowledge guide) → seed task DAG — with only the
 * external boundaries mocked (subagent spawning, LLM routing, agent registry).
 * Team state lands on a real filesystem under a temp workspace, exactly like
 * production. Run: `node scripts/live-verify.mjs` from the project root.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyPlugin } from '../lib/index.js'

const VERIFY_WORKSPACE = mkdtempSync(join(tmpdir(), 'expl-verify-'))
console.log(`[verify] workspace: ${VERIFY_WORKSPACE}`)

// ── knowledge pack fixture: one expert pack + one shared pack ───────────────
const knowledgeRoot = join(VERIFY_WORKSPACE, 'knowledge')
mkdirSync(join(knowledgeRoot, 'experts', 'researcher'), { recursive: true })
writeFileSync(join(knowledgeRoot, 'experts', 'researcher', 'research-checklist.md'), '# Checklist\n- define questions first\n')
mkdirSync(join(knowledgeRoot, 'shared'), { recursive: true })
writeFileSync(join(knowledgeRoot, 'shared', 'team-glossary.md'), '# Glossary\n- attempt_id: execution capability\n')

// ── mock boundaries ─────────────────────────────────────────────────────────
const registered = new Map()
const systemPromptSections = []
let startContinuableCalls = 0

const mockCaptain = {
  id: 'captain-session-1',
  session: {
    header: { cwd: VERIFY_WORKSPACE, seedLength: 0 },
    events: [],
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' } }),
    append: () => { /* harness may not know our event types; ignore */ },
  },
  options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  steer: () => {},
}

const ctx = {
  logger: { debug: () => {}, warn: (m) => console.log(`[warn] ${m}`) },
  tools: { register: (tool) => { registered.set(tool.name, tool) } },
  systemPrompt: { section: (section) => { systemPromptSections.push(section) } },
  llm: {
    resolveCallConfig: async ({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort }),
  },
  subagents: {
    getProvider: (name) => name === 'spawn' ? { prepareContinuable: () => {}, capabilities: { persona: true, toolFilter: true } } : undefined,
    list: () => ['spawn'],
    registerContinuableSetup: () => {},
    startContinuable: async ({ request }) => {
      startContinuableCalls += 1
      const persona = request.persona ?? ''
      const model = request.agentOptions?.model ?? '?'
      ctx.subagents.lastPersona = persona
      return { childId: `mock-child-${startContinuableCalls}`, persona, model }
    },
    followup: async () => true,
    interrupt: () => {},
    listChildren: async () => [],
    listDescendants: async () => [],
  },
  agents: { get: () => undefined },
  on: () => () => {},
  get: () => undefined,
  effect: (fn) => { fn(); return () => {} },
}

// ── run the real plugin entry ────────────────────────────────────────────────
applyPlugin(ctx, {
  stateDir: '.expert-teams',
  memberProvider: 'spawn',
  maxMembers: 8,
  knowledgeDir: 'knowledge',
  promptSectionOrder: 118,
})

const toolNames = [...registered.keys()].sort()
console.log(`[verify] registered ${toolNames.length} tools: ${toolNames.join(', ')}`)

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// ── run the scenario ────────────────────────────────────────────────────────
const scenario = registered.get('expert_teams_scenario_apply')
const exec = { agent: mockCaptain, signal: new AbortController().signal }

const result = await scenario.execute({
  scenario: 'documentation',
  goal: '写一篇 200 字短文介绍专家库系统（验证用）',
}, exec)

console.log(`\n[verify] scenario_apply result:`)
console.log(JSON.stringify(result, null, 2))

check('scenario id preserved', result.scenario_id === 'documentation')
check('team id sanitized', result.team_id === 'documentation-team' || /^[\w-]+$/.test(result.team_id), result.team_id)
check('experts assembled', result.members.length === 2, result.members.map(m => `${m.expert_id}->${m.member_name}`).join(', '))
check('expert member names', result.members.every(m => m.member_name !== ''))
check('preset model route applied', result.members.every(m => m.model === 'deepseek-official/deepseek-v4-flash'))
check('task DAG seeded', result.tasks.length === 3, result.tasks.map(t => t.task_id).join(', '))
check('deliverable present', typeof result.deliverable === 'string' && result.deliverable.length > 0)
check('tools registered', registered.has('expert_teams_create') && registered.has('expert_teams_add_member') && registered.has('expert_teams_status'))
check('system prompt section', systemPromptSections.length === 1 && systemPromptSections[0].name === 'expert-library:usage')
check('members spawned via mock provider', startContinuableCalls === 2)

// ── durable state on the real filesystem ────────────────────────────────────
const stateRoot = join(VERIFY_WORKSPACE, '.expert-teams')
const teamDir = join(stateRoot, result.team_id)
const teamFile = join(teamDir, 'team.json')
check('team dir created', existsSync(teamDir) && existsSync(join(teamDir, 'inbox')))
check('team.json persisted', existsSync(teamFile))

const team = JSON.parse(readFileSync(teamFile, 'utf8'))
check('team.json valid id', team.id === result.team_id)
check('scenarioId recorded', team.scenarioId === 'documentation')
check('members persisted', team.members.length === 2, team.members.map(m => `${m.name}@${m.provider}/${m.model}`).join(', '))
check('member llm route snapshot', team.members.every(m => m.provider === 'deepseek-official' && m.model === 'deepseek-v4-flash'))
check('tasks persisted with deps', team.tasks.length === 3
  && team.tasks[1].dependencies.join() === 't1'
  && team.tasks[2].dependencies.join() === 't2')

// ── expert add_member with knowledge guide (fresh team, second captain) ─────
const probeCaptain = {
  ...mockCaptain,
  id: 'captain-session-2',
  session: { ...mockCaptain.session, header: { ...mockCaptain.session.header } },
}
const probeExec = { agent: probeCaptain, signal: new AbortController().signal }
const create = registered.get('expert_teams_create')
const addMember = registered.get('expert_teams_add_member')
const createResult = await create.execute({ name: 'Knowledge Probe', description: 'probe' }, probeExec)
const added = await addMember.execute({ expert: 'researcher', name: '研究员甲' }, probeExec)
check('expert add_member by id', added.expert_id === 'researcher' && added.member_name === '研究员甲')
check('expert persona used for spawn', ctx.subagents.lastPersona?.includes('professional research analyst'))

// persona was captured by the mock startContinuable
const probeTeam = JSON.parse(readFileSync(join(stateRoot, createResult.team_id, 'team.json'), 'utf8'))
check('probe team member role from expert', probeTeam.members[0]?.role === 'research analyst')

// ── cleanup ─────────────────────────────────────────────────────────────────
rmSync(VERIFY_WORKSPACE, { recursive: true, force: true })
console.log(`\n[verify] cleanup done.`)

if (failures.length > 0) {
  console.error(`\nFAILED ${failures.length}: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('\nALL CHECKS PASSED ✔')
