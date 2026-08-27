# beike-pack roster gate 修复记录（2026-08-23）

## 问题
`expert_review_apply`（框架 B · 贝壳生态与居住服务）组队失败：
```
roster:required-capability-unsatisfied — scenario "beike-ecosystem" requires
capability "beike.review" at minProficiency 1 but no rostered expert claims it
```

## 根因（双层）
1. **场景要求专家认领 `beike.review`**（src/v2/beike-pack.ts `beikeScenarioV2`，
   且是重复的两条 requiredCapabilities），但专家经 `zhijianMetaToExpertV2`
   投影时只认领 `zhijian.review` + `realestate.*.review` —— 包内从未注入
   设计注释所称的 universal capability。
2. **workspace overlay merge 后序覆盖先序**：运行时 `resolveRuntimePack`
   发现顺序为 beike → … → zhijian-realestate → pipeline-domains，
   `zhijian-realestate` overlay 的专家（无 `beike.review`）覆盖了 beike
   overlay 的专家，即使 beike 包内注入了也会被覆盖。

## 修复（src/v2/beike-pack.ts）
1. 新增 `beikeExpertToV2`：投影时给每位 beike 专家 stamp `beike.review`
   能力标记（保留给未来 tool/知识路由），`buildBeikeDomainPack` 使用之。
2. `beikeScenarioV2` 的 `requiredCapabilities` 改为
   `[{ capability: 'zhijian.review', minProficiency: 1, cardinality: 1 }]`：
   roster gate 用**所有专家必然认领**的共享能力，不依赖 overlay 顺序；
   去掉重复条目。

## 验证
- `pnpm build` 重建 lib，`node scripts/build-beike-pack.mjs` 重新发射 pack。
- 模拟完整运行时链（base zhijian + workspace overlays）：
  - 修复前：bk-033 等 5 位候选均无 `beike.review` → gate FAIL
  - 修复后：`zhijian.review` claiming=184 → ROSTER GATE PASS ✓
- `expert_review_apply` 组队成功：智见点评·租赁平台安全能力（杨现领/左晖/
  柴强/廖俊平/徐斌，框架 B，t1-t6 DAG）。

## 涉及文件
- `src/v2/beike-pack.ts`（含 lib 重建产物 `lib/v2/beike-pack.js`）
- `domain-packs/beike/`（重新发射，generated/pack.sha256 已更新）

## 遗留问题（已修复 2026-08-23 下午）
**模板 gate/deliverable 绑定 + 渲染节点拆分 + 技能绑定（三条设计落地）**：

### A. 渲染与生成独立节点（智见点评框架模板）
- `src/v2/zhijian-pack.ts` `frameworkTeamTemplate`：t2 融合合成（去"与渲染"字样）+
  新增 **t3 渲染与生成（HTML5 → PDF/PPT → 视频）**，依赖 t2，描述内置三步走
  （finesse-ui → weasyprint/pdf + pptfast → video-shotcraft）与**完成后检查点**
  （汇报交付物 + 等待用户确认是否继续，不静默结束）。
- gates（data-citation / compliance-anonymization）与 deliverable 从 t2 改绑 **t3**——
  **顺带修复昨日 `gate-artifact-missing @t2` bug**：gate 现落在有 artifact 的最终
  渲染任务上，而非 fan-out 后无 artifact 的中间任务。

### B. collab research-report 模板同样增加渲染节点
- `src/collab/templates.ts`：report 模板新增 t4 渲染与生成（三技能 + 检查点），
  deliverables 含 t4；ppt-gen 模板原有 t4 渲染节点保持不变。

### C. 内置通用专家技能绑定（persona 注入）
- `src/expert-library/builtin-experts.ts`：designer 与 docs-coordinator 的 principles
  增加 finesse-ui / pptfast / video-shotcraft 渲染方法论 + 完成后检查点约定，
  `adaptV1Expert` 将其投射为 V2 persona.style，成员唤醒即携带。

### 验证
- `pnpm build` + `node scripts/build-{builtin,beike,zhijian}-pack.mjs` 全部重新生成。
- 运行时编译验证：`zhijian.team.B` 现为 t1 研判 → t2 融合 → t3 渲染；
  gates/deliverable 绑 t3；三技能 + 检查点全部命中。
- `pnpm typecheck` 干净；测试套件 **636/636 PASS**（更新了 5 个测试文件断言：
  v2-review-apply-compile / v2-collab-templates / v2-pack-migration /
  v2-task-gates / v2-compiler / v2-zhijian-pack）。
