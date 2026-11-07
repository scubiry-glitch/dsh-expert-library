# C 账号 GLM 模型目录调整（2026-10-30）

- 用户最终确认：调整 C 账号的全部会话，不只调整链接中的单条会话。GLM 系列只保留 `zai/glm-5.3-flash`，原有 DeepSeek 模型继续可用。
- 在 `/var/lib/zhijian/customer-dsh-zhijian-demo-c/settings.yaml` 中移除 `glm` provider（`glm-4.7`、`glm-5.3`），并从 `zai` provider 移除 `glm-5.3`。配置备份现位于 `/opt/zhijian/backups/c-account-model-20261030/settings.yaml.backup-flash-only-20261030T144506Z`。
- 调整前检查 C 账号投影缓存，38 条会话当前选中 `glm-5.3`。确认这些会话无运行中的任务后，通过 C 账号网关将其下一次模型选择设为 `zai/glm-5.3-flash`；38 次请求均返回 200。原选择列表备份现位于 `/opt/zhijian/backups/c-account-model-20261030/model-selection-before-flash-20261030T144352Z.json`。
- C 服务自动重新读取模型配置；私有模型接口现返回 4 个 DeepSeek 模型及 `zai/glm-5.3-flash`，不含 `glm-5.3` 或 `glm-4.7`。由于另有一条 Flash 会话正在运行，未重启 C 服务。
- 先前仅针对 `case-018` 设置的客户页白名单已撤回，门户代码及环境文件从 `.backup-conversation-model-allowlist-20261030T143945Z` 恢复并重启；该会话本身已选中 `zai/glm-5.3-flash`。

## 2026-11-02 故障与修复

- 上次备份最初留在 C 账号运行目录且由 root 持有、权限为 0600。DSH 文件监听器尝试监听 `settings.yaml.backup-flash-only-20261030T144506Z` 时发生 `EACCES`，导致 C 服务反复退出，客户页因此短暂提示“读取对话暂时失败”。
- 已将本次生成的两份备份移至上方 `/opt/zhijian/backups/c-account-model-20261030/`，避免被 C 服务监听。指定会话 `case-004` 的私有消息接口随后返回 200、30 条消息，活动接口显示未运行。
