---
name: domain-pack-update
description: 领域包助手的版本更新流程；用户要求修改或升级已有领域包时使用。
---

# 更新领域包

## 参考资料与凭据

- [领域包样例与开发指南](https://packs.meizu.life/guides/partner-sample-pack)：核对 V2 包结构与引用关系。
- [包中心开发者 API 使用文档](https://packs.meizu.life/guides/api-usage)：核对版本更新、提交和授权方式。
- [本机包中心创作接口细节](/var/lib/zhijian/customer-dsh-zhijian-demo-c/workspace/knowledge/skills/pack-center-domain-pack/references/pack-center-api.md)：核对当前部署的 ZIP 上传、草稿、校验与送审流程。

提交到包中心时，运行进程从账号 C 的权限为 `0600` 的 `/var/lib/zhijian/customer-dsh-zhijian-demo-c/.credentials.yaml` 读取 `refs.PACK_CENTER_DEVELOPER_TOKEN`，只在内存中组装 `Authorization: Bearer` 请求头。先检查该项存在且格式正确；缺失时停止写请求，主动告诉用户“包中心开发者凭据未配置”，询问其通过账号 C 的安全凭据通道配置新密钥后再继续。不要要求用户在群聊或普通对话中发送明文；若旧密钥曾在群里发出，提示先轮换。密钥正文不写入 Skill、包、命令参数、日志或回复。个人开发者凭据仅授权创作接口，不代表审核或发布权限。

用户只问更新流程、所需条件或能力说明时，直接解释步骤与状态门槛；不扫描具体账号或发布记录，也不执行写入。下面的实例核对只在用户要求检查或实际更新指定包时执行。

用户说包名称即可发起更新，不要求其提供组织 ID、包 ID、提交 ID 或旧版本。先从目标账号绑定连接的 `connection.organizationId` 取得默认组织；在该组织查询 `GET /api/submissions?organizationId=<org>&groupBy=pack`，结果含 `name`、`packId`、最新 `submission` 与 `release`，有 `nextCursor` 时用 `afterPack` 翻页。优先匹配当前账号已启用包的显示名；再用包列表名称精确匹配，找不到再尝试部分匹配。列表的 `name` 可能是旧注册名；遇到疑似改名包，应核对提交详情的 `snapshot.preview.packMeta.name`。默认组织没有匹配时，可按 `/api/me` 的 `principal.memberships` 查询用户可访问的其他组织。若多个包同名或部分匹配结果不唯一，列出包名称、组织和版本供用户选择，不能猜测后写入。唯一匹配后，按包 ID 查询提交历史，自动选出可用的 `previousSubmissionId` 和下一个版本；从本地已启用包或来源目录核对内容。只有找不到唯一目标或缺少修改内容时才追问。

若用户已给出包 ID、版本及来源目录，查询该包的现有提交与发布记录，并只检查该来源；不要递归扫描整个工作区或其他账号。先确认稳定的修订基线，再处理差异。

先核对包中心现有提交、发布记录与目标账号正在启用的版本，确定原包 ID、组织和一条已结束当前状态迁移的 `previousSubmissionId`。当前服务端仅拒绝以 `draft`、`validating`、`pending_review` 为修订基线；`withdrawn` 可用于一次性测试包的修订，但它并不代表已发布，不能据此声称完成发布版本升级。正式包优先以已审核、已发布的提交为基线。对照用户反馈与会话失败证据列出修改点和文件位置。建立新版本与新草稿，保留必要的分发、依赖和权限设定；不覆盖已发布快照。

按 V2 契约修改专家、场景、方法、知识、工具与门禁引用，运行加载器校验、对比差异、检查 ZIP 根目录及摘要。用户要求提交时按包中心接口上传、创建草稿、校验、送审；网络结果不明时先查提交状态，再用原幂等键重试。独立核对审核、发布与目标账号的安装和激活状态，只有用户要求启用时才执行启用。逐项报告版本、差异、提交状态与尚未完成的门槛。
