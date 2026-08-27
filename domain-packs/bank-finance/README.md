# bank-finance（银行金融领域包）v1.0.0

6 位银行金融领域专家基线（BANK-09，零售金融/银行经营），由
`scripts/build-bank-pack.mjs` 确定性生成（复用 zhijian-realestate 的发射器与
模板/质量/方法构建器，仅数据不同）。

- `pack.json` + 各实体目录：`loadPackFromDir` 可装载的 DomainPackV2 布局。
- `source/raw-profiles/`：原始 Profile JSON，逐字节保留（sha-256 见
  `source/SOURCE-MANIFEST.json`）。
- `quality-policies/bank.quality.json`：含 `pii-redaction` 硬门（手机号/
  身份证/银行卡号/账号 脱敏），银行数据不得带真实值外发。
- 重建：`pnpm build && node scripts/build-bank-pack.mjs`；
  漂移检查：`node scripts/build-bank-pack.mjs --check`。
