# dsh-expert-library 项目指令

> 本文件由 dsh 维护；记忆系统路由见下方 marker 块。

<!-- unified-agent-memory:begin -->
## 统一记忆库路由（本项目）

- 本项目 = 专家库 `@zhijian/dsh-expert-library`
- 本项目的**事实 vault** = `/root/AgentMemory/expert-library/`
  → canonical 笔记在 `50-Agent-Context/`（**只读**），写事实走 `50-Agent-Context/Agent提交区/`
- 激活 vault 由 `~/.unified-memory.yaml` 的 `vault:` 决定；确认/切换：
  `dsh-memory list` / `dsh-memory use expert-library`（**切换后需重启 dsh**）
- 交叉检索其他项目（不改激活态）：`dsh-memory search <name> <query>`
- 通用规则（9 条，含凭据红线与唯一写通道）见各 Agent 全局指令文件：
  `~/.dsh/AGENTS.md`、`~/.codex/AGENTS.md`、`~/.claude/CLAUDE.md`
- **本目录是知识库本体（权威源）**；`/root/AgentMemory/expert-library/` 只是事实库，
  不复制正文，两者不得混淆。
<!-- unified-agent-memory:end -->
