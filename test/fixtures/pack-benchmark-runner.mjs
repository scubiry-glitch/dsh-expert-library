import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [, , caseFile, receipt, runId, trial] = process.argv
const testCase = JSON.parse(readFileSync(caseFile, 'utf8'))
const repairRoundFields = testCase.fixtureRepairRoundCases
  ? testCase.fixtureRepairRoundCases[Number(trial) - 1] : { repairRounds: 0 }
const path = join(dirname(receipt), `${runId}.txt`)
const gatePath = join(dirname(receipt), `${runId}.gates.json`)
mkdirSync(dirname(receipt), { recursive: true })
writeFileSync(path, `fixture artifact for ${testCase.id} / ${runId}\n`)
writeFileSync(gatePath, JSON.stringify({ fixture: true, gates: testCase.requiredGates }, null, 2))
const now = new Date().toISOString()
writeFileSync(receipt, JSON.stringify({ mode: 'fixture', sessionId: `fixture-session-${runId}`,
  status: 'completed', startedAt: now, endedAt: now,
  artifacts: testCase.requiredArtifacts.map(kind => ({ kind, path })),
  gates: testCase.requiredGates.map(id => ({ id, hard: true, pass: true, evidencePath: gatePath })),
  ...repairRoundFields, dataChecks: { verifiedClaims: 3, totalClaims: 3, driftCount: 0 },
  formatChecks: { passed: 2, total: 2 }, taskChecks: { completed: 3, total: 3 },
  expertRubric: { score: 100 } }, null, 2))
