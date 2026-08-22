# zhijian-realestate（智见点评·房地产领域包）v1.0.0

32 位房地产领域专家基线（BK-002 ~ BK-033，五大领域），由
`scripts/build-zhijian-pack.mjs` 从 智见点评_skill_20260819.zip 确定性生成。

- `pack.json` + 各实体目录：`loadPackFromDir` 可装载的 DomainPackV2 布局
  （metadata-only pack.json + 每实体一个 JSON，文件名 == 实体 id）。
- `source/raw-profiles/`：原始 Profile JSON，逐字节保留（sha-256 见
  `source/SOURCE-MANIFEST.json`）。
- `generated/`：派生视图（V1 金样、总表、校验报告、树摘要），可随时重建。
- 重建：`pnpm build && node scripts/build-zhijian-pack.mjs`；漂移检查：
  `node scripts/build-zhijian-pack.mjs --check`。
- BK-034（陈杰，2026-08-20 加入工作区副本）**未合并**：记录为 1.1.0 延期
  升级，见 `source/SOURCE-MANIFEST.json` 的 deferredUpgrades。
