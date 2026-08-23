# beike（贝壳生态领域包）v1.0.0

7 位贝壳生态相关专家（交叉投影：BK 居住服务派 5 位 + 左晖 e08-08 +
一濛 e04-05），由 `scripts/build-beike-pack.mjs` 确定性生成（复用 zhijian/bank
发射器与模板/质量/方法构建器，专家实体按 id 引用共享注册表，不重复注册）。

- 场景：`beike-ecosystem`（贝壳生态与居住服务）、`beike-rental-supply-chain`
  （长租与租赁供应链）。
- 知识库：`beike.99wiki`（本地 99wiki 的 projects/贝壳x江苏银行、贝壳合作方案、
  VLC租房平台 + feishu 贝壳纪要）。
- 口径：贝壳成出口径（bk-031 陶琦）与克而瑞/中指/统计局均有差异，须标注；
  陶琦 bk-031 为内测对比项，对外交付不引用。
- 重建：`pnpm build && node scripts/build-beike-pack.mjs`；
  漂移检查：`node scripts/build-beike-pack.mjs --check`。
