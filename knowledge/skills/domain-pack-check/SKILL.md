---
name: domain-pack-check
description: 领域包助手的检查流程；用户要求检查领域包结构、运行效果或提出优化建议时使用。
---

# 检查领域包

## 参考资料

- [领域包样例与开发指南](https://packs.meizu.life/guides/partner-sample-pack)：检查 V2 包结构与引用关系。
- [包中心开发者 API 使用文档](https://packs.meizu.life/guides/api-usage)：需要核对提交、校验或发布状态时使用。
- [本机包中心创作接口细节](/var/lib/zhijian/customer-dsh-zhijian-demo-c/workspace/knowledge/skills/pack-center-domain-pack/references/pack-center-api.md)：核对当前部署接口与状态定义。

用户只问检查方法或能力说明时，直接解释检查范围；只有用户要求检查指定包或会话时才读取文件、日志并运行校验。若目标不明，先确认目标。

包名称或当前会话链接就是可接受的目标，不要求用户寻找组织 ID、包 ID、提交 ID。已启用包先按显示名称在当前账号解析；查包中心提交时，默认组织取目标账号绑定连接的 `connection.organizationId`，用 `GET /api/submissions?organizationId=<org>&groupBy=pack` 的 `name` 匹配名称并取得内部 `packId` 与最新提交 ID；有 `nextCursor` 时用 `afterPack` 翻页。列表名称可能落后于包的显示名：找不到时核对疑似包的 `snapshot.preview.packMeta.name`，也可用账号当前启用包的名称映射。默认组织没有匹配时，再按 `/api/me` 的 `principal.memberships` 查其他可访问组织。精确匹配优先，部分匹配只能在结果唯一时使用；同名或多候选时展示名称、组织、版本，让用户选择。会话链接应先查实际使用记录，不能仅凭包名称或账号启用清单猜测会话用了哪个包。

若用户只要求核对包中心里指定包或提交的状态、校验结果、审核或发布进度，先按上文解析名称；取得内部组织和包 ID 后查询 `GET /api/submissions?organizationId=...&packId=...`，再对目标提交查询 `GET /api/submissions/<id>`。需要鉴权时，从账号 C 的 `/var/lib/zhijian/customer-dsh-zhijian-demo-c/.credentials.yaml` 读取 `refs.PACK_CENTER_DEVELOPER_TOKEN`，只在内存中用于请求头，不输出密钥。取得详情后直接回答；不要递归搜索整个工作区，不要为普通状态查询写本地证据文件，也不要运行加载器。只有用户要求检查包内容、会话运行证据或找不到明确目标时，才按下文展开范围。

`customer_mention_call` 若已返回目标包的静态检查结果，直接基于该结果回答，不重复扫描文件或运行加载器；只有用户要求会话执行证据、日志或更深入的专项核查时再继续读取。

确认目标包及版本；若用户说“这个会话”，先找当前会话真实使用的包与执行证据，不能从账号启用清单推定已使用。读取包文件并执行加载器结构校验，检查场景、专家、技能、方法、知识 Provider、工具 Provider、输出模板和质量策略的引用闭合、口径一致性及可执行性。结合失败日志或会话结果区分静态问题与运行时问题。

每条建议给出文件位置、具体证据、影响和最小修法；说明检查的版本及范围。只读检查不创建草稿或修改包。用户要求修复或升级时转到更新流程，完成后重新验证。
