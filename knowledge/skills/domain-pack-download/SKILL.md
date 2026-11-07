---
name: domain-pack-download
description: 领域包助手的下载与启用流程；用户要求获取包文件、安装或启用已发布版本时使用。
---

# 下载领域包

## 参考资料与凭据

- [包中心开发者 API 使用文档](https://packs.meizu.life/guides/api-usage)：核对发布记录与接口权限。
- [本机包中心创作接口细节](/var/lib/zhijian/customer-dsh-zhijian-demo-c/workspace/knowledge/skills/pack-center-domain-pack/references/pack-center-api.md)：核对当前部署的发布状态。

下载、安装和启用只使用目标账号已授权的凭据机制。密钥或访问令牌不写入 Skill、包、命令参数、日志或回复。

账号 C 的发布件下载凭据位于 `/var/lib/zhijian/customer-dsh-zhijian-demo-c/pack-center/private/connection.json` 的 `connection.credentialToken`，可信签名公钥位于同一连接的 `connection.trustedSigningKeys`。只在进程内读取，不打印连接文件或凭据。下载接口使用该连接的 `connection.origin`：先 `POST /api/v1/releases/<releaseId>/download-grants`，再使用响应的一次性 grant 请求其 `artifactPath`（通常为 `/api/v1/releases/<releaseId>/artifact`），请求头包含机器凭据和 `X-Pack-Download-Grant`。按现有客户端 `/root/zhijian/dsh-expert-library/src/host/pack-center-client.ts` 与传输层 `/root/zhijian/dsh-expert-library/src/host/pack-center-transport.ts` 的校验规则验证签名、发布身份、字节数及 SHA-256。开发者创作令牌不能用于 `/api/v1` 发布件下载。明确给出 releaseId 时只检查该 release 和目标账号连接，不探测无关宿主接口或扫描整个工作区。

用户只问下载流程或能力说明时，直接解释可选交付形态与权限条件；不下载文件、不安装、不启用。下面的实际下载步骤只在用户要求取得指定包时执行。

用户可只说包名称与“最新已发布版本”，无需提供包 ID、release ID 或组织 ID。先在目标账号已安装/已启用清单中按显示名称查找，再从其授权可见的发布目录按名称查找；需要查创作提交时，绑定连接的 `connection.organizationId` 是默认组织，`GET /api/submissions?organizationId=<org>&groupBy=pack` 提供名称、包 ID 和最新 release，有 `nextCursor` 时用 `afterPack` 翻页。目录或包列表的名称可能是旧注册名；找不到时核对当前已启用包名称及提交详情的 `snapshot.preview.packMeta.name`。默认组织没有匹配时按 `/api/me` 的 `principal.memberships` 查其他可访问组织。唯一匹配后取得实际 release ID，并核对发布状态；同名、多组织或多个可能版本时列出名称、组织、版本供用户选择。若未指定版本，选择该账号可见的最新兼容已发布版本，不能把待审草稿当成下载件。

先确认用户要的是领域包 ZIP、包中心发布件、当前账号本地缓存、还是月报成品；并确定包 ID、版本和目标账号。读取包中心 release 状态，只有 `published` 才能作为已发布包交付。开发者 API 令牌不等于机器下载或账号安装权限；使用目标账号已有的授权通道，不绕过权限。

下载后校验文件大小、清单、SHA-256 与 release 摘要。下载到缓存、安装、启用分别执行和核对；启用须核对账号当前版本，必要时保留可回滚版本。提供可访问的下载链接或经过登记的文件，不把服务器本地路径当成用户可下载地址。报告包 ID、版本、发布状态、摘要及目标账号是否已安装、已启用。
