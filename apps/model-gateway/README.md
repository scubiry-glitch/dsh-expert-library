# 智见模型调用网关

客户 DSH 实例只保存各自的随机代理凭据，DeepSeek 上游密钥由独立的 `zhijian-model-gateway` 服务保管。服务只监听 `127.0.0.1`，只接受 `POST /chat/completions`，按代理凭据识别账号、接受主会话 `session-UUID` 和成员裸 UUID；成员调用缺少会话头时记作该账号的 `unattributed`，继续按账号统一计费和限额。格式错误的非空会话头仍被拒绝。网关将 `max_tokens` 限制到 8192、单次请求体限制到 4 MB，并强制上游返回流式 usage。超过大小门的请求会被完整排空后拒绝，避免连接悬挂。上游请求地址固定，不接受浏览器或 DSH 指定的任意目标。

SQLite `model_calls` 记录账号、会话、UTC 日期、输入、缓存读取、输出及总 token；请求开始先按消息 JSON 字节数的 1/3 加最大输出做预留，结束后用提供方 usage 结算。原先按 1 字节预留 1 token，使 DSH 大上下文在仍有实际额度时被误拒绝；预留是估算值，单轮实际用量可能高于预留，结算始终以提供方 usage 为准。流中没有可信 usage 时保留预留额，服务意外退出时 pending 记录仍占额度。测试账号的每日上限由部署配置决定；这是运行参数，后续由产品确定正式额度。只读 `/internal/usage` 在 loopback 与独立服务器间凭据双重限制下为客户页提供本账号用量；仍无客户自助修改额度和管理员界面。

服务通过 `MODEL_GATEWAY_CONFIG` 指定账号 ID、代理凭据 SHA-256 和每日额度，通过 `MODEL_GATEWAY_KEY_FILE` 读取只供服务账号访问的上游凭据，通过 `MODEL_GATEWAY_DB` 指定私有 SQLite 路径。原始代理凭据只在各账号 DSH 的凭据存储中，原始上游凭据不进入 DSH 或 Git。当前服务文件在 `/etc/systemd/system/zhijian-model-gateway.service`；客户实例通过 `DEEPSEEK_BASE_URL=http://127.0.0.1:3190` 调用。

运行验证：`npm test`；真实实例首问与公网 BFF 联调结果见 [S1 运行实例记录](../../docs/deployment/customer-portal/S1-RUNTIME-STAGING-20261008.md)。
