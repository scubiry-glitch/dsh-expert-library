# pipeline-domains（pipeline 领域包）v1.0.0

19 位 pipeline 专家库归一化专家（E01 宏观 / E08 房地产 / E13 江苏银行，
公众人物实名），source 由 `scripts/sync-pipeline-experts.mjs` 从线上专家库同步，
包实体由 `scripts/build-pipeline-pack.mjs` 确定性生成（复用 zhijian/bank 发射器）。

- `quality-policies/pipeline.quality.json`：含 `pii-redaction` 硬门（银行敏感数据脱敏）。
- 重建：`pnpm build && node scripts/build-pipeline-pack.mjs`；
  漂移检查：`node scripts/build-pipeline-pack.mjs --check`；
  重新同步：`node scripts/sync-pipeline-experts.mjs [--namespaces E01,E08,E13]`。
