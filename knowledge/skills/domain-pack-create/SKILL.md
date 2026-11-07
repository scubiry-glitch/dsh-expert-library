---
name: domain-pack-create
description: 领域包助手的新建流程；用户要求制作新领域包时使用。
---

# 创建领域包

## 参考资料与凭据

- [领域包样例与开发指南](https://packs.meizu.life/guides/partner-sample-pack)：确定 V2 包结构与引用关系。
- [包中心开发者 API 使用文档](https://packs.meizu.life/guides/api-usage)：核对创作接口与授权方式。
- [本机包中心创作接口细节](/var/lib/zhijian/customer-dsh-zhijian-demo-c/workspace/knowledge/skills/pack-center-domain-pack/references/pack-center-api.md)：核对当前部署的 ZIP 上传、草稿、校验与送审流程。

提交到包中心时，运行进程从账号 C 的权限为 `0600` 的 `/var/lib/zhijian/customer-dsh-zhijian-demo-c/.credentials.yaml` 读取 `refs.PACK_CENTER_DEVELOPER_TOKEN`，只在内存中组装 `Authorization: Bearer` 请求头。先检查该项存在且格式正确；缺失时停止写请求，主动告诉用户“包中心开发者凭据未配置”，询问其通过账号 C 的安全凭据通道配置新密钥后再继续。不要要求用户在群聊或普通对话中发送明文；若旧密钥曾在群里发出，提示先轮换。密钥正文不写入 Skill、包、命令参数、日志或回复。个人开发者凭据仅授权创作接口，不代表审核或发布权限。

用户只问创建流程、所需输入或能力说明时，直接给简明清单；不扫描账号、不制作文件，也不触发包中心写入。下面的制作步骤只在用户要求实际创建时执行。

用户可只给包名称、用途和来源资料；不要把组织 ID、包 ID、版本号作为普通用户的必填输入。未指定组织时，先从目标账号已绑定的 `pack-center/private/connection.json` 仅读取 `connection.organizationId` 作为默认组织；连接不存在时，查询 `/api/me` 的 `principal.memberships`，仅有一个可用组织才自动采用，否则请用户选组织名称。基于组织命名空间和包名称拟定安全、唯一的包 ID；没有版本约束的新包默认从 `0.1.0` 起。查同组织包名与 ID 是否已存在，若重名或目标不清楚才展示候选供用户选择。`groupBy=pack` 的 `name` 是包注册名，可能落后于修订后的 `pack.json` 显示名；核对疑似同包时也看当前启用包名称及提交详情的 `snapshot.preview.packMeta.name`。将实际采用的组织、包 ID 和版本写入执行结果，用户无需提前寻找这些内部标识。

若用户已给出具体来源目录或 ZIP、包 ID、组织和版本，先只检查该来源及对应包中心记录；不要递归扫描整个工作区或其他账号。来源已通过本机加载器校验时可复核结果并直接进入上传，不重新生成无关内容。

先确定目标组织、包 ID、名称、版本、使用场景和来源资料。读取包中心开发文档与同类已安装 V2 包，按实际需要组织 `pack.json`、专家、场景、方法、知识、工具与质量规则。引用须闭合：场景任务的 `tasks[].expert` 指向专家，`scenario.skill` 或任务描述指向技能，`outputTemplate` 与 `qualityPolicy` 分别决定交付形态和验收门禁；团队模板列出专家，专家的 `methods[]`、`knowledgeBindings[]` 和工具绑定指向对应供给。不要虚构 Provider 或把助手本身制成领域包。

完成后用加载器校验目录与引用，生成根目录含 `pack.json` 的 ZIP，核对文件清单及 SHA-256。用户要求提交时，按包中心创作接口上传固定 ZIP、创建草稿、校验并送审，每次写入使用独立幂等键。审核与发布须由有权者按正常流程完成。报告包 ID、版本、提交 ID、状态及下一步；草稿、待审、已发布和账号已启用分别表述。
