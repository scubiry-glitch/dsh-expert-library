# 智见客户门户

这是独立于 DSH 插件构建与部署的客户应用。公网已启用合作伙伴中心 OIDC 登录；三个已开通的测试账号使用各自隔离实例，访问会话、数据、工作区和报告。其他身份进入待开通队列。`/preview` 只展示无客户数据的布局预览；`/demo/loading` 展示不连接会话接口的恢复动效候选方案，见 [静态演示记录](../../docs/deployment/customer-portal/LOADING-DEMO-20261018.md)。当前客户页的轮询、工作区读取和页面验证见 [2026-10-11 优化记录](../../docs/deployment/customer-portal/OPTIMIZATION-20261011.md)。

“设置与用量”从模型网关实时读取登录账号的日 token 额度及最近七天有调用的记录。部署时将 `MODEL_USAGE_URL` 设为模型网关 loopback HTTP origin，并将 `MODEL_USAGE_TOKEN_FILE` 指向双方服务账号可读、浏览器不可读的只读接口凭据文件；两项须同时配置。详细验收见 `../../docs/deployment/customer-portal/S5-USAGE-20261008.md`。

当模型网关在账号配置中设置 `tokensPerPoint` 时，此处改用积分显示每日已用、额度、剩余和近七日用量，换算比例只由网关下发。未启用的账号继续显示 token。积分是当下比例对 token 账本的折算展示，比例调整会重算历史展示，不构成固定价格的财务账单。

会话输入区的“联网”选项默认“按需询问”。首次调用 `customer_web_search` 或 `customer_web_fetch` 时，智见展示拟发送的公开搜索词或网页地址并等待用户选择；选择开启或关闭后，状态由隔离 DSH 实例持久化在工作空间之外，后续可在本会话直接切换。客户会话的通用 `web_search`/`web_fetch` 工具被隐藏并在执行处拦截；搜索与抓取只经过模型网关。回答引用网页时须附来源链接和查询时间，搜索不可用时说明未核实。发布顺序为专家库插件、模型网关、客户门户，并在每个隔离实例重启后核对授权边界；只更新页面无法拦截旧实例的通用网页工具。

账号管理员从 `/app` 左下角进入 `/manage`，按智见数据、领域包、专家库三个分区管理当前账号的独立实例。管理 API 每次验证登录角色、实例绑定及写入 CSRF，分享链接不能使用。实现与部署见 [`CAPABILITY-MANAGEMENT-20261023.md`](../../docs/deployment/customer-portal/CAPABILITY-MANAGEMENT-20261023.md)。

## 运行

要求 Node.js 22+。从本目录执行：

```bash
npm run build
PUBLIC_ORIGIN=http://127.0.0.1:18460 DSH_BACKEND_URL=http://127.0.0.1:3080 npm start
```

打开 `http://127.0.0.1:18460/login` 查看当前入口，打开 `/preview` 查看登录后的三视图空状态。`npm run test` 验证配置、后端地址使用和公开路由；`DSH_BACKEND_URL=... npm run check:backend` 只在服务端检测现有审阅路由是否可达，不在页面里展示 DSH 地址。

部署环境按 `.env.example` 设置 `PUBLIC_ORIGIN=https://zhijian.meizu.life` 和 `DSH_BACKEND_URL`。当两个服务不在同一台机器，后者必须是受限私网地址或经认证的服务隧道地址；不能把现有 DSH 内部端口开放给公网。可选的 `DSH_BACKENDS_JSON` 为各客户的隔离实例设置服务端别名。BFF 到独立 DSH 网关的最小客户操作接口已验证，当前仅三个显式开通的测试账号可在公网创建会话与首问。

`RESEARCH_ENABLED_BACKENDS` 是研究功能的显式发布名单，默认空。先配置独立实例别名与网关凭据，再逐个验收模型首答、重启恢复、双账号隔离和用量来源，最后把通过验收的别名加入逗号分隔名单。仅配置 `DSH_BACKENDS_JSON` 不会把研究按钮开放给客户。

S1 认证需要同时设置 `OIDC_ISSUER`、`OIDC_CLIENT_ID`、`ACCOUNT_DB_PATH`；少一个就拒绝启动。独立应用使用 OIDC 授权码、PKCE、state、nonce 和签名 ID Token 校验，再查本地显式开通的 `issuer+subject` 与账号成员关系。浏览器会话和 CSRF 在数据库中只存摘要；撤销成员资格会立即使原会话失效。`/api/sessions` 只返回登录账号的会话索引，未绑定客户运行实例前不会创建 DSH 会话。SQLite 数据库保存在独立的持久化私有目录，不随应用发布包覆盖；运行时固定 Node 22.23.2。

会话分享从顶部“分享”创建 `/share#token=...` 链接，默认 7 天，可设置 1～365 天；持有链接者无需 OIDC 登录。访问凭证只在创建时返回，数据库只存 SHA-256 摘要，每次请求都验证到期、撤销、创建者成员资格及会话范围。只读链接可查看该会话的对话、工作区和数据；协作链接还可发消息、回答提问和操作工作区，相关模型调用计入分享方账号额度。历史只读预览只能创建只读链接。分享面板可查看记录并撤销链接；访客无法查看其他会话、用量或修改会话元数据。链接凭证放在 URL fragment 中，由页面向同源 API 发送 Bearer 头，不进入 HTTP 请求路径。

## 与 yy 现有入口的关系

当前两套入口部署在同一台服务器，复用 DSH 程序与专家库插件代码，但运行时和会话数据分开。`yy.meizu.life` 进入原 `dsh-web.service`（本机 3080，`web` profile）；`zhijian.meizu.life` 进入独立 `zhijian-customer-portal.service`（本机 18460）。客户应用只把已授权账号的研究请求路由到对应的独立 DSH 实例：三个测试账号分别使用 `zhijian-dsh-demo-a/b/c.service`（本机 3191/3192/3193）、独立运行用户、DSH home、工作区和会话记录。服务端拒绝把 `default` 后端用于客户研究操作，因此客户会话不会合并进 yy 的原会话。

客户实例的 `workspace/` 是生成文件的工作目录；会话历史保存在同一实例 DSH home 的 `sessions/`，所以工作目录为空不表示会话为空。当前隔离是同机不同进程与用户的隔离，不是物理主机隔离；原 yy 进程目前以 root 运行，主机管理员或该特权进程仍有能力读取客户实例文件。若要求抵御原服务或主机管理员，需迁移到不同主机或更强的隔离边界。

首次验证成功但未开通的身份进入待开通清单，页面明确提示等待管理员；不会自动加入别人的账号。运维可在私有服务器上向 `npm run provision` 的 stdin 传一条 JSON 指令：`create-account`（含 `slug`、`workspaceId`、`backendRef`）、`list-pending`、`add-member`（含 `accountId`、`issuer`、`subject`、`displayName`）、`deactivate-member`（含 `accountId`、`userId`）。须在服务账号的 `ACCOUNT_DB_PATH` 下操作，用户身份值不作为命令行参数传入。

**隔离结论：**DSH Workspace 只限制部分写入，默认沙箱仍可只读访问同一进程可读的其他目录。不同外部客户须使用独立 DSH 进程/容器和运行身份；客户页可以共享一个登录与账号 BFF。S1 代码完成本地验证不等于已通过该隔离闸门。

开发机可用 `node scripts/smoke-isolated-hosts.mjs` 验证两个真实隔离 DSH Host 与 BFF 的空白会话、跨账号直链和 CSRF；所需环境变量和当前结果见 [S1 隔离与网关](../../docs/deployment/customer-portal/S1-ISOLATION-AND-GATEWAY.md)。该脚本不调用模型。

`npm run build` 从现有 `assets/review/portraits/coordinator.webp` 复制已使用的插画到独立产物；配色与排版沿用现有协作室及已确认的用户层 demo。构建产物在 `dist/`，运行时不读取旧页面源码。`npm run package` 生成可单独复制到客户页服务器的 `release/` 目录，包含服务器、OIDC 依赖、配置模块和静态产物。

客户会话区沿用原审阅页的头像、左右气泡、消息入场、传递纸片、等待回复动效、逐条回执、复制和长回复展开。客户端按游标追加消息，切换会话时重置视图；HTTP 接收、会话写入和助手回复是不同状态，发送结果不确定时保留原文和请求 ID 以便幂等重试。@ 菜单从当前账号实例的已授权数据源目录读取；@智见指智见数据源，未配置凭据时不可选。领域包与专家能力由账号实例的版本和授权决定。模型通过 `customer_ask_question` 提问时，客户页可勾选并补充自由文本，再回到同一轮对话。数据页从已验证的数据快照读取清单和表格；未配置数据源时保持空清单。当前 S2 状态见 [数据快照与提问卡记录](../../docs/deployment/customer-portal/S2-DATA-SNAPSHOTS-20261008.md)。

“发起任务”在新旧会话均可使用，普通对话保持原入口。`POST /api/sessions/:id/tasks` 接收带请求 ID 的银行房产价值报告或自定义目标，把任务写入账号数据库并派发给该账号的 DSH 实例；同一请求 ID 重试不会重复派发。`GET /api/sessions/:id/tasks` 返回会话内任务、回复状态和实际成果。银行报告只有在真实文件登记后才显示“成果可下载”。C 实例的 `customer_publish_document` 工具仅接受当前客户工作空间内经类型、大小和内容校验的 DOCX/PDF/Markdown，按会话归档并通过既有鉴权下载接口读取；浏览器不能提交本地路径。任务与文件接口都按账号和会话校验，只读分享不能发起任务。

会话输入框可添加最多 4 份附件，支持 PDF、DOCX、XLSX、TXT、MD、CSV、PNG、JPG 和 WebP，单份上限 8 MiB。上传先写入当前账号 DSH 实例中当前会话的 `customer-uploads/<session-id>/`；用户发送消息时才把文件路径交给 Agent，发送前移除附件会删除对应文件。上传与删除接口同时检查浏览器写权限和 DSH 会话归属；只读分享与历史预览不能操作附件。生产 Nginx 仅对附件接口允许 12 MiB 请求体，以容纳 base64 JSON 编码。

左侧会话列表支持标题搜索、按时间或自定义分组显示，并可切换紧凑排列。置顶会话独立显示在最上方；自定义分组及会话归属存于账号数据库，删除分组仅把会话移回“未分组”。排列密度、分组方式和折叠状态保存在浏览器中，按账号区分。会话的置顶、收藏、归档、改名和移动分组从行内“⋯”菜单操作。

新建会话可选择当前账号的工作空间和预设；空白会话可切换预设，开始对话后固定。左侧可按工作空间分组，并在“新建空间”中选择上级目录向下创建子目录（最多五级）。空间目录位于该账号 DSH 工作区的 `spaces/` 下，空间及会话归属按账号保存；原有会话仍在默认工作空间。工作空间目录用于组织会话和资料，不是针对有文件系统访问权的 Agent 的强制读取隔离；跨会话资料污染仍需靠来源约束和报告引用核验。

合成 OSA 会话的气泡下可显示结构化服务资料卡。BFF 只在 `zhijian-demo-c`、`客户专家Agent` 会话标题和可信的 `【CAgent 场景初始化】` 客户计划同时成立时附加卡片；旧版林女士初始化格式有定向兼容。卡片来源于 `osa-service-cards.mjs` 中带版本与有效期的演示资料快照，不触发 MCP 检索、贷款申请、客户转交或预约。普通 `/app` 会话不附卡；修改演示资料时须同步更新该快照和 `test/osa-service-cards*.test.mjs`，正式产品条件仍以机构核验为准。

域名、反代和 systemd 记录见 `../../docs/deployment/customer-portal/`。生产入口为 `https://zhijian.meizu.life/app`；`/preview` 仅用于无客户数据的布局检查。三个测试账号使用独立 DSH 实例，模型网关按账号与会话计量。扩大试点前仍需完成真实账号浏览器回归、账单对账和故障恢复演练，详见 [运行实例记录](../../docs/deployment/customer-portal/S1-RUNTIME-STAGING-20261008.md)。
