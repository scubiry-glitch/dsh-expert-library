# builtin-library（通用内置库 V1 投影包）

8 位通用内置专家 + 10 个内置场景，由
`scripts/build-builtin-pack.mjs` 确定性生成（V1 retirement step 2 —— 通用
内置库的 V2 pack 归宿）。智见 bk-* 专家**不在本包内**（其归宿是
`domain-packs/zhijian-realestate/`）；运行时在装载本包后从 V1 注册表追加
bk-* 专家，行为与直接投影逐字节一致。

- `pack.json` + 各实体目录：`loadPackFromDir` / `loadPackFromDirSync`
  可装载的 DomainPackV2 布局（metadata-only pack.json + 每实体一个 JSON，
  文件名 == 实体 id）。
- 实体是 `adaptV1Expert` / `adaptV1ScenarioTeamTemplate` /
  `adaptV1Scenario` 的**逐字节投影**（自 `lib/` 导入，未分叉），因此
  运行时无论走 pack 路径还是 adaptV1 回退路径，编译出的计划 digest 一致。
- 重建：`pnpm build && node scripts/build-builtin-pack.mjs`；漂移检查：
  `node scripts/build-builtin-pack.mjs --check`。
