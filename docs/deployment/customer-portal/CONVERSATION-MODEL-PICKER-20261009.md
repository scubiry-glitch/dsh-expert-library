# 客户会话模型选择发布（2026-10-09）

## 行为

- `/app` 对话输入框下方显示当前账号绑定的工作空间和当前会话模型。
- 候选项来自该账号 DSH 实例的可解析模型目录；选择只写入当前会话的下一次模型路由，不修改账号全局默认值。
- 预览和只读分享不可切换；BFF 校验账号、会话归属和写权限，DSH 网关再校验会话归属与模型目录。

## 生产发布

- 2026-10-09 14:26–14:29（Asia/Singapore），更新客户页 `server.mjs`、`dsh-gateway.mjs`、`dist/index.html`、`dist/app.js`、`dist/style.css`，以及 A/B/C DSH 插件的 `lib/index.js` 和 `lib/host/customer-gateway.js`。A/B 只应用模型接口增量，保留各自已有的插件功能版本。
- 备份目录：`/opt/zhijian/customer-model-picker-backup-20261009T0627Z/`。
- 重启前确认三个实例没有进行中的团队任务；依次重启 A/B/C 和客户页。首次上线的模型读取接口因 DSH `resolveAgent` 返回结构处理错误而返回 503，已修复、重新发布并验证。

## 验证与限制

- 类型检查和模型网关、账号隔离、只读/协作分享用例通过。
- A/B/C 的实际网关读取均返回 `deepseek-official/deepseek-flash`，各有 4 个候选模型；C 的指定会话亦返回同一当前模型。对该会话执行一次“选择当前相同模型”的写入，返回 200，随后读取仍为相同模型与原有 `high` 推理档位；未切换到其他模型。
- 公网页面和静态脚本返回 200；无凭据模型接口返回 401，非法选择请求返回 400。
- 2026-10-09 获用户授权后，为 C 账号接入主账户现有的 GLM 服务。C 会话候选新增 `glm/glm-4.7`、`glm/glm-5.3`、`zai/glm-5.3`、`zai/glm-5.3-flash`；A/B 候选未变。`glm-5.3[1m]` 因会话模型选择接口暂不接受方括号，不加入 C 的候选列表。
- C 的 GLM 请求统一经过本机 `zhijian-model-gateway.service` 的固定 `/glm/v1/messages` 和 `/zai/chat/completions` 路由。只允许 C 账号的代理凭据调用，模型受白名单限制；与 DeepSeek 共用账号额度账本。主账户上游密钥仅存于网关服务专用文件，C 运行时仅保存自己的代理凭据。
- 网关单元测试 7 项通过。用 C 的独立测试会话实际调用 `glm/glm-5.3` 与 `zai/glm-5.3-flash` 均得到回复，两个请求在 C 额度账本中记录为 `complete`。指定用户会话 `3971aa6d-feba-4262-a9b1-7f651e32c789` 的当前模型仍为 `deepseek-official/deepseek-flash`，并可读到上述四个 GLM 候选。
- 主账户的主对话默认模型仍是 DeepSeek，专家库默认模型为 `zai/glm-5.3-flash`；客户会话切换只影响其自身后续消息。

## 回退

从备份目录恢复相应客户页文件与 A/B/C 插件两个文件，依次重启对应 DSH 服务和 `zhijian-customer-portal.service`。保留账号数据和会话数据。

若只回退 C 的 GLM 接入：先从 C 的 `settings.yaml` 移除 GLM/ZAI provider 配置，并从 `secure-backups/credentials-before-glm-20261009.yaml` 恢复仅含 DeepSeek 代理凭据的 `.credentials.yaml`；再恢复 `/opt/zhijian/model-gateway/server.mjs.before-glm-20261009` 与 `/etc/zhijian/model-gateway.json.before-glm-20261009`，移除网关单元 drop-in 中的两个 GLM 密钥环境变量并重启网关。C 的 GLM 模型列表和网关路由需一起回退，避免产生不可用候选。
