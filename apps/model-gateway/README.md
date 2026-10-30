# 智见模型调用网关

客户 DSH 实例只保存各自的随机代理凭据，DeepSeek 上游密钥由独立的 `zhijian-model-gateway` 服务保管。服务只监听 `127.0.0.1`，提供 `POST /chat/completions` 及受限的 `POST /v1/tools/search`、`POST /v1/tools/fetch`。模型调用按代理凭据识别账号、接受主会话 `session-UUID` 和成员裸 UUID；成员调用缺少会话头时记作该账号的 `unattributed`。搜索和抓取必须携带主会话 ID，按账号及会话记录成功请求。格式错误的非空会话头会被拒绝。模型请求默认将 `max_tokens` 限制到 8192，可在部署配置中按账号设置 `maxOutputTokens`，或按账号及 `deepseek`、`glm`、`zai` 路线设置 `maxOutputTokensByProvider`；单次请求体限制到 8 MB，并强制上游返回流式 usage。超过大小门的请求会被完整排空后拒绝，避免连接悬挂。上游请求地址固定，不接受浏览器或 DSH 指定的任意目标。

搜索每次最多返回 5 项，且不请求网页正文；需核对原文时另走 Fetch，响应正文最多 30,000 字符。按 UTC 日、每个会话达到 20 次成功搜索或 10 次成功抓取后拒绝后续请求。Search/Fetch 的成功请求分别记录在 `web_search_calls`/`web_fetch_calls`，不并入 token 额度或当前积分展示；运营计费须单独对账。接口参数和收费口径见 [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/guides/search/)。

SQLite `model_calls` 记录账号、会话、UTC 日期、输入、缓存读取、输出及总 token；请求开始先按消息 JSON 字节数的 1/3 加最大输出做预留，结束后用提供方 usage 结算。原先按 1 字节预留 1 token，使 DSH 大上下文在仍有实际额度时被误拒绝；预留是估算值，单轮实际用量可能高于预留，结算始终以提供方 usage 为准。流中没有可信 usage 时保留预留额，服务意外退出时 pending 记录仍占额度。测试账号的每日上限由部署配置决定；这是运行参数，后续由产品确定正式额度。只读 `/internal/usage` 在 loopback 与独立服务器间凭据双重限制下为客户页提供本账号用量；仍无客户自助修改额度和管理员界面。

服务通过 `MODEL_GATEWAY_CONFIG` 指定账号 ID、代理凭据 SHA-256 和每日额度；账号的 `webSearchEnabled: true` 才能调用 Search/Fetch，未配置时默认拒绝。`MODEL_GATEWAY_KEY_FILE` 提供只供服务账号访问的上游凭据，`MODEL_GATEWAY_DB` 指定私有 SQLite 路径。原始代理凭据只在各账号 DSH 的凭据存储中，原始上游凭据不进入 DSH 或 Git。当前服务文件在 `/etc/systemd/system/zhijian-model-gateway.service`；客户实例通过 `DEEPSEEK_BASE_URL=http://127.0.0.1:3190` 调用。

## 积分换算

平台运营人员可在服务端私有 `MODEL_GATEWAY_CONFIG` 的**单个账号**记录中设置正整数 `tokensPerPoint`，例如 `1000` 表示该账号每 1,000 token 折算 1 积分；重启网关后生效。未配置的账号继续按 token 展示。浏览器及租户管理员都不能修改比例，也不能传入账号 ID 选账。

网关仍将模型上游回报的输入、缓存读取及输出 token 相加，按原有日 token 限额拦截请求。积分从账号的**每日总 token** 统一折算，精度为 0.01 积分：额度和已用分别向上取整，显示剩余为两者之差；不会对每次模型调用单独向上取整。`/internal/usage` 同时返回原始 token 和 `points` 字段，客户门户只向用户展示积分。更改比例会重新折算历史展示，因此当前积分是用量换算值，尚不是不可变的财务账单、充值余额或人民币价格；正式扣费和跨比例历史账单需另设带生效时间的价格快照与对账流程。

运行验证：`npm test`；真实实例首问与公网 BFF 联调结果见 [S1 运行实例记录](../../docs/deployment/customer-portal/S1-RUNTIME-STAGING-20261008.md)。
