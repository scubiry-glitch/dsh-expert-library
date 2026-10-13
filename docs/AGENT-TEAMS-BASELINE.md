# Agent Teams 基线门禁

这份记录是 A0 的可复现入口。状态样例位于 `test/fixtures/expert-teams-snapshots.json`；命令在仓库根目录执行。

```bash
node --version
pnpm --version
git rev-parse HEAD
pnpm typecheck
node --test --test-concurrency=1 'test/**/*.test.mjs'
pnpm check:pack
```

基线结果必须随每次 A0 复核记录提交、版本和退出码。构建产物、`work/` 交付物和凭据不得写入 fixture 或基线记录。

## 2026-09-26 复核记录

- Node `v22.23.2`；pnpm `11.22.0`。
- 基线源码提交：`d1d5cc3935132bdfa7e4c93562057374483c1b88`（本轮修复在其上工作树验证）。
- `pnpm typecheck`：exit 0。
- `pnpm build`：exit 0。
- `node --test --test-concurrency=1 'test/**/*.test.mjs'`：735/735 通过，exit 0。
- `pnpm check:pack`：exit 0；`pnpm check:builtin`：exit 0。
