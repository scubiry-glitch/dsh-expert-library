import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkContentReview, checkDataChannelStatus, checkDeepResearchPass, checkDeepResearchReviewer, checkEvidenceMerge, checkOutlineCandidates, checkReportSourceLedger, checkReviewedReportCopy, checkSelectedOutline, checkPointFigures, checkRenderReferences, checkReportSourcePreflight, requiredOutlineMaterials } from '../lib/deep-research-gates.js'

test('writer source preflight rejects the upstream structure defects before renderer work', () => {
  const outline = ['一 市场矛盾', '二 供给机制', '三 租金验证', '四 反方情景', '五 决策行动'].map(title => `## ${title}\n### 证据\n### 推导`).join('\n')
  const chapters = '## 卷首速览\n本轮问题、判断和边界说明。\n## 总论\n本轮研究的关键机制和待核条件。\n' + ['一 市场矛盾', '二 供给机制', '三 租金验证', '四 反方情景', '五 决策行动'].map(title => `## ${title}\n正文。`).join('\n')
  assert.throws(() => checkReportSourcePreflight(chapters.replace('## 卷首速览', '## 速览'), outline), /DEEP_RESEARCH_SOURCE_OPENING/)
  const disclosure = '### 来源披露\n- Wind：未调用。\n- 政研通：通道失败。\n- 贝壳：仅趋势。\n'
  const closing = '### 总结与行动\n判断仍需观察。\n> 若触发条件失效，应暂停。\n'
  assert.throws(() => checkReportSourcePreflight(chapters, outline), /DEEP_RESEARCH_SOURCE_DISCLOSURE/)
  assert.throws(() => checkReportSourcePreflight(`${chapters}\n${disclosure}`, outline), /DEEP_RESEARCH_SOURCE_CLOSING/)
  assert.throws(() => checkReportSourcePreflight(`${chapters}\n## 六 未声明分析章\n正文。\n${closing}\n${disclosure}`, outline), /DEEP_RESEARCH_SOURCE_CHAPTERS/)
  assert.throws(() => checkReportSourcePreflight(`${chapters}\n## 报告薄弱点（显式声明）\n正文。\n${closing}\n${disclosure}`, outline), /DEEP_RESEARCH_SOURCE_CHAPTERS/)
  assert.doesNotThrow(() => checkReportSourcePreflight(`${chapters}\n${closing}\n${disclosure}`, outline))
  const formatted = disclosure.replace('Wind：未调用', '**Wind EDB**：**未调用**').replace('贝壳：仅趋势', '**贝壳 / beike**：**仅小样本、时点快照**')
  assert.doesNotThrow(() => checkReportSourcePreflight(`${chapters.replace('## 总论', '## 总论：问题边界')}\n${closing}\n${formatted}`, outline))
  assert.doesNotThrow(() => checkReportSourcePreflight(`${chapters}\n${closing.replace('> 若触发条件失效，应暂停。', '**收束句**：若触发条件失效，应暂停。')}\n${formatted}`, outline))
})

const names = ['问题与反常识', '机制与证据', '情景与反方', '战略收口', '行动与复盘']
const outline = `选择: A\n候选稿SHA256: ${'a'.repeat(64)}\n\n${names.map(name => `## ${name}\n### 角度一\n### 视角二\n反常识结论：待核验。`).join('\n\n')}\n`
const report = names.map(name => `## ${name}\n来源：报告 10%\n`).join('\n')
const fragments = names.map(name => `<figure class="fig" data-chapter="${name}"><span class="num tnum">10%</span></figure>`).join('\n')
const spec = '```json figure-spec\n' + JSON.stringify({ figures: names.map(name => ({ chapter: name, selector: '.fig', claim: '结论', sourceQuote: '来源：报告 10%', data: ['10%'] })) }) + '\n```'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

test('phase 2 data preflight keeps channel failures distinct from usable data', () => {
  const probes = ['北京', '上海'].flatMap(city => ['wind', 'beike', 'zyt'].map(channel => ({
    city, channel, status: 'failed', tool: 'fixture-probe', request: city + '/' + channel,
    reason: '隔离测试中的模拟故障', attemptedAt: '2026-10-06T00:00:00Z',
    receiptSha256: 'b'.repeat(64), errorCode: 'FIXTURE_UNAVAILABLE', fallback: '公开来源且标条件分析',
  })))
  const artifact = value => '```json channel-status\n' + JSON.stringify(value) + '\n```'
  const data = { cities: ['北京', '上海'], probes, researchMode: 'CONDITIONAL' }
  checkDataChannelStatus(artifact(data), '## 北京与上海的对照')
  assert.throws(() => checkDataChannelStatus(artifact({ ...data, researchMode: 'FULL' }), '北京 上海'), /DEEP_RESEARCH_DATA_PREFLIGHT/)
  assert.throws(() => checkDataChannelStatus(artifact({ ...data, probes: probes.slice(1) }), '北京 上海'), /DEEP_RESEARCH_DATA_PREFLIGHT/)
  assert.throws(() => checkDataChannelStatus(artifact({ ...data, probes: probes.map((row, i) => i ? row : { ...row, receiptSha256: undefined }) }), '北京 上海'), /DEEP_RESEARCH_DATA_PREFLIGHT/)
})

test('phase 2 evidence merge and source ledger pin reviewed bytes and chapter sources', () => {
  const input = [{ task: 'research_main', content: '主证据' }, { task: 'research_counter', content: '反方证据' }]
  const merge = {
    inputs: input.map(row => ({ task: row.task, sha256: digest(row.content) })),
    sources: [{ id: 'S1', title: '合成来源，仅用于测试', url: 'https://example.org/fixture', accessedAt: '2026-10-06' }],
    externalIncrements: Array.from({ length: 10 }, (_, i) => ({ id: 'E' + i, claim: '合成增量 ' + i, sourceId: 'S1', novelty: '测试增量 ' + i })),
    status: 'CONDITIONAL',
  }
  const evidence = '```json evidence-merge\n' + JSON.stringify(merge) + '\n```'
  checkEvidenceMerge(evidence, input)
  assert.throws(() => checkEvidenceMerge(evidence, [{ ...input[0], content: '已变更' }, input[1]]), /DEEP_RESEARCH_EVIDENCE_MERGE/)
  assert.throws(() => checkEvidenceMerge(evidence.replace('"E9"', '"E0"'), input), /DEEP_RESEARCH_EVIDENCE_MERGE/)

  const titles = ['问题', '机制', '证据', '反方', '行动']
  const selected = titles.map(title => `## ${title}\n### 子节一\n### 子节二`).join('\n')
  const parts = title => ({
    position: `本章定位说明${title}的关键判断和边界。`,
    roles: `角色方案对照说明${title}的责任分配。`,
    basis: `本章依据引用 S1 作为${title}的条件材料。`,
    inference: `推论说明${title}的测试估算为 10%。`,
    opportunity: `机会路径指出${title}的可观察触发条件。`,
    risk: `风险路径指出${title}的判断失效条件。`,
  })
  const body = titles.map(title => `## ${title}\n${Object.values(parts(title)).join('\n\n')}\n`).join('\n')
  const reportText = `## 卷首速览\n本轮只验证结构，不作为业务研究结论。\n## 总论\n本轮只验证结构与审阅门控。\n${body}\n### 总结与行动\n本轮结论只适用于隔离测试。\n> 没有真实数据就不能下业务结论。\n### 来源披露\n- Wind：未调用。\n- 政研通：通道失败。\n- 贝壳：未调用。\n`
  const ledger = { schemaVersion: 1, outlineSha256: digest(selected), evidenceSha256: digest(evidence), reportSha256: digest(reportText),
    chapters: titles.map(heading => ({ heading, parts: parts(heading), sourceIds: ['S1'], numericClaims: [{
      quote: parts(heading).inference, sourceId: 'S1', date: '2026-10-06', geography: '测试范围',
      unit: '%', caliber: '合成演示', kind: 'estimated',
    }] })) }
  checkReportSourcePreflight(reportText, selected)
  checkReportSourceLedger(JSON.stringify(ledger), reportText, selected, evidence)
  assert.throws(() => checkReportSourceLedger(JSON.stringify(ledger), reportText.replace('10%', '20%'), selected, evidence), /DEEP_RESEARCH_SOURCE_LEDGER/)
  const unlisted = reportText.replace(parts('问题').risk, parts('问题').risk + ' 另有 20% 未列入台账。')
  assert.throws(() => checkReportSourceLedger(JSON.stringify({ ...ledger, reportSha256: digest(unlisted) }), unlisted, selected, evidence), /DEEP_RESEARCH_SOURCE_NUMBERS/)
  const review = `报告SHA256: ${digest(reportText)}\n来源台账SHA256: ${digest(JSON.stringify(ledger))}\n结论: PASS\n${titles.map(title => `## ${title}\n已核对来源与五件套。`).join('\n')}`
  checkContentReview(review, reportText, selected, JSON.stringify(ledger))
  assert.throws(() => checkContentReview(review.replace('结论: PASS', '结论: REPAIR'), reportText, selected, JSON.stringify(ledger)), /DEEP_RESEARCH_CONTENT_REVIEW/)
  checkReviewedReportCopy(reportText, reportText)
  assert.throws(() => checkReviewedReportCopy(reportText + '\n', reportText), /DEEP_RESEARCH_REVIEWED_REPORT/)
})

test('candidate and selected outline gates bind current materials and Host choice', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deep-outline-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const materialLines = (await requiredOutlineMaterials()).map(item => `${item.id} ${item.sha256}`).join('\n')
  const candidates = `## A 主基调\n## B 风险\n## C 对照\n${materialLines}`
  await checkOutlineCandidates(candidates)
  const team = { planRef: { scenarioId: '98wiki-deep-research' }, tasks: [] }
  const task = { planTask: { logicalId: 'outline_candidates' } }
  const evidence = content => ({ artifacts: [{ id: 'published:outline-candidates.md', content }] })
  await checkDeepResearchPass(root, team, task, evidence(candidates))
  await assert.rejects(checkDeepResearchPass(root, team, task, evidence(candidates.replace(/## C/u, '## D'))), /DEEP_RESEARCH_OUTLINE_CANDIDATES/)
  await assert.rejects(checkOutlineCandidates(candidates.replace(/## C/u, '## D')), /DEEP_RESEARCH_OUTLINE_CANDIDATES/)
  await assert.rejects(checkOutlineCandidates(candidates.replace((await requiredOutlineMaterials())[0].sha256, '0'.repeat(64))), /DEEP_RESEARCH_MATERIAL_NOT_BOUND/)
  const path = join(root, 'OUTLINE.md')
  await writeFile(path, outline)
  await checkSelectedOutline(outline, 'A', 'a'.repeat(64), path)
  await assert.rejects(checkSelectedOutline(outline, 'B', 'a'.repeat(64), path), /DEEP_RESEARCH_OUTLINE_CHOICE/)
  await writeFile(path, outline.replace(/### 视角二/gu, '视角二'))
  await assert.rejects(checkSelectedOutline(outline, 'A', 'a'.repeat(64), path), /DEEP_RESEARCH_OUTLINE_GATE/)
})

test('point figure gate enforces chapter count and report numeric provenance', () => {
  checkPointFigures(spec, fragments, outline, report)
  assert.throws(() => checkPointFigures(spec, fragments.replace('10%', '20%'), outline, report), /DEEP_RESEARCH_FIGURE_NEW_NUMBER/)
  assert.throws(() => checkPointFigures(spec, fragments.slice(0, fragments.lastIndexOf('\n')), outline, report), /DEEP_RESEARCH_FIGURE_FRAGMENT_COUNT/)
})

test('renderer gate binds both current examples and embeds reviewed figures', async () => {
  const refs = [
    ['designer-v1.html', 'zhijian-designer-v1.html', '.fig', '.fig'],
    ['credit-policy-v1.html', 'zhijian-credit-policy-v1.html', '.num.tnum', '.num.tnum'],
  ]
  const references = await Promise.all(refs.map(async ([id, filename, sourceSelector, outputSelector]) => ({
    id, sha256: digest(await readFile(join('domain-packs/zhijian-realestate/references', filename))),
    sourceSelector, outputSelector, chapter: names[0], reason: '采用该版式结构',
  })))
  const mapping = JSON.stringify({ references })
  const html = `<html><body>${fragments}</body></html>`
  await checkRenderReferences(mapping, html, outline, fragments)
  await assert.rejects(checkRenderReferences(mapping, '<html><body></body></html>', outline, fragments), /DEEP_RESEARCH_REFERENCE_BINDING|DEEP_RESEARCH_RENDER_FIGURE/)
  await assert.rejects(checkRenderReferences(mapping.replace(references[0].sha256, '0'.repeat(64)), html, outline, fragments), /DEEP_RESEARCH_REFERENCE_BINDING/)
})

test('v2 renderer review must be signed by the bound design critic', () => {
  const team = { planRef: { scenarioId: '98wiki-deep-research', templateVersion: '2.0' }, members: [
    { id: 'critic', capabilityScope: { expertId: 'design-critic' } },
    { id: 'market', capabilityScope: { expertId: 'bk-024' } },
  ] }
  const renderer = { planTask: { logicalId: 'renderer' } }
  checkDeepResearchReviewer(team, renderer, 'critic')
  assert.throws(() => checkDeepResearchReviewer(team, renderer, 'market'), /DEEP_RESEARCH_RENDER_REVIEWER/)
  assert.throws(() => checkDeepResearchReviewer(team, renderer, 'unknown'), /DEEP_RESEARCH_RENDER_REVIEWER/)
})

test('evidence merge resolves frozen consumer versions across same-attempt republications', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deep-pinned-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const team = { id: 'fixture', planRef: { scenarioId: '98wiki-deep-research' }, tasks: [] }
  const task = { id: 'merge', planTask: { logicalId: 'evidence_merge' }, dependencies: [], inputArtifacts: [], inputArtifactManifest: [] }
  const inputs = []
  for (const [logicalId, name] of [['research_main', 'research-main.md'], ['research_counter', 'research-counter.md']]) {
    const source = { id: logicalId, status: 'completed', attempt: 1, planTask: { logicalId },
      project: { path: logicalId, artifactsPath: `${logicalId}/artifacts` }, publishedArtifacts: [] }
    const dir = join(root, team.id, source.project.artifactsPath)
    await mkdir(dir, { recursive: true })
    for (const version of [1, 2, 3]) {
      const content = `${logicalId} synthetic version ${version}`
      const artifact = { id: `${logicalId}-${version}`, taskId: source.id, attempt: 1, reviewId: `published:${name}`,
        relativePath: `${version}.md`, sha256: digest(content), sizeBytes: Buffer.byteLength(content) }
      await writeFile(join(dir, artifact.relativePath), content)
      source.publishedArtifacts.push(artifact)
      if (version === 2) {
        const ref = { sourceTaskId: source.id, artifactId: artifact.id }
        task.inputArtifacts.push(ref)
        task.inputArtifactManifest.push({ ...ref, attempt: 1, reviewArtifactId: artifact.reviewId,
          sha256: artifact.sha256, versionPath: join(dir, artifact.relativePath) })
        inputs.push({ task: logicalId, sha256: digest(content) })
      }
    }
    team.tasks.push(source)
    task.dependencies.push(source.id)
  }
  team.tasks.push(task)
  const content = '```json evidence-merge\n' + JSON.stringify({ inputs,
    sources: [{ id: 'S1', title: 'Synthetic fixture', url: 'https://example.org/fixture', accessedAt: '2026-10-06' }],
    externalIncrements: Array.from({ length: 10 }, (_, i) => ({ id: `E${i}`, claim: `Fixture ${i}`, sourceId: 'S1', novelty: `Synthetic ${i}` })),
    status: 'CONDITIONAL' }) + '\n```'
  const evidence = { artifacts: [{ id: 'published:research-evidence.md', content }] }
  const check = (candidate = task, state = team) => checkDeepResearchPass(root, state, candidate, evidence)
  // v2 is pinned: neither the first v1 nor unpinned newer v3 may replace it.
  await check()
  await assert.rejects(check({ ...task, inputArtifacts: task.inputArtifacts.slice(1) }), /DEEP_RESEARCH_INPUT_NOT_PINNED/)
  await assert.rejects(check({ ...task, inputArtifacts: [...task.inputArtifacts, task.inputArtifacts[0]] }), /DEEP_RESEARCH_INPUT_NOT_PINNED/)
  await assert.rejects(check({ ...task, inputArtifacts: [...task.inputArtifacts, { sourceTaskId: 'research_main', artifactId: 'research_main-3' }] }), /DEEP_RESEARCH_INPUT_NOT_PINNED/)
  await assert.rejects(check({ ...task, dependencies: ['research_counter'] }), /not a dependency/)
  await assert.rejects(check({ ...task, inputArtifactManifest: task.inputArtifactManifest.map(row => ({ ...row, sha256: '0'.repeat(64) })) }), /INPUT_VERSION_CHANGED/)
  await assert.rejects(check(task, { ...team, tasks: [...team.tasks, { ...team.tasks[0], id: 'duplicate' }] }), /DEEP_RESEARCH_INPUT_NOT_PINNED/)
  // An audited follow-up keeps the plan's logical role but changes only this
  // consumer's exact frozen publication. Old source still exists in the team.
  const revisedTeam = structuredClone(team), revisedTask = revisedTeam.tasks.at(-1)
  const replacement = { ...structuredClone(revisedTeam.tasks[0]), id: 'research-main-revision', planTask: undefined }
  replacement.publishedArtifacts = replacement.publishedArtifacts.map(a => ({ ...a, taskId: replacement.id }))
  revisedTeam.tasks.push(replacement)
  revisedTask.dependencies[0] = replacement.id
  revisedTask.inputArtifacts[0].sourceTaskId = replacement.id
  revisedTask.inputArtifactManifest[0].sourceTaskId = replacement.id
  revisedTask.inputSourceOverrides = { research_main: replacement.id }
  await assert.rejects(check(revisedTask, revisedTeam), /missing source revision receipt/)
  revisedTask.inputRevisions = [{ logicalSource: 'research_main', replacementTaskId: replacement.id,
    nextManifest: structuredClone(revisedTask.inputArtifactManifest) }]
  await check(revisedTask, revisedTeam)
  revisedTask.inputRevisions[0].nextManifest[0].sha256 = '0'.repeat(64)
  await assert.rejects(check(revisedTask, revisedTeam), /revision publication changed/)
  await writeFile(task.inputArtifactManifest[0].versionPath, 'tampered')
  await assert.rejects(check(), /hash mismatch/)
})
