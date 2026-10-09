# 插件宿主中心客户端与本地管理（L04-A/B、L05–L07、U04）

内部 SDK 位于 `src/host/pack-center-client.ts`、`pack-center-connection.ts`、`pack-center-transport.ts`，复用 `pack-store.ts`。新增 manager、持久 operations、受保护 routes 与 host 适配器，已接插件入口和设置页「领域包中心」。浏览器只调用白名单本地 API，不直接调用 SDK。全部在隔离工作树实施，不修改 DSH 核心，尚未安装到生产。

## 配置与信任

每个部署点使用独占目录，固定配对 `<deploymentRoot>/private` 与 `<deploymentRoot>/inventory`。工厂拒绝任意交叉配对、相同/嵌套目录及非规范路径；私密目录和文件必须由当前 UID 持有，分别为 0700 与 0600，不自动修复已有宽权限、符号链接或多硬链接文件。Linux `/proc/self/fd` 与 util-linux `flock` 是前置。

`createPackCenterClient` 接收 `origin`、`connectionRoot`、`inventoryRoot`、实际 `capabilities`，以及可选的 `builtinVersions` / `validateActivation`。配置不含机器 token。`origin` 是部署管理员预先配置的纯 HTTPS origin，可以是明确配置的内网中心或独立域名；不接受路径、用户信息、查询或片段，不从浏览器传入任意 URL。测试专用 `allowLoopbackHttp` / `testCa` 不得出现在正式设置或 RPC 请求里；TLS 校验始终开启。

绑定步骤：

1. 管理员在独立中心建立部署点并签发一次性绑定码。
2. 通过独立可信渠道获取 `expectedCenterId` 和 `trustedSigningKeys`（keyId → Ed25519 SPKI 公钥 PEM）。不是先读 exchange 返回值再自动信任。
3. 调用 `bind({ bindingCode, expectedRevision, expectedCenterId, trustedSigningKeys })`。输入与当前 revision 先校验，再且只交换一次；响应中的中心身份、公钥指纹、机器 scope 和有效期均核对后原子保存。
4. HTTP 层再次白名单投影 `getConnection()` / `bind()` / `unbind()` 元数据，不含 token、公钥正文或私密路径；`connection.bound` 表示本地保留了凭据，不是远端在线/未撤销承诺。

机器凭据、身份和 pins 位于私密 `connection.json` 单一 canonical 文档；使用 revision CAS、跨进程 flock、fsync+rename，损坏文件保留且拒绝隐式覆盖。不存在明文凭据的设置字段或浏览器存储。改写文件格式也会被视为损坏，不应手工编辑该文件。

`CENTER_BIND_UNCONFIRMED` 意味着一次性码可能已经消耗、中心可能已签发新凭据，本地保存也可能处于不确定提交状态：**先重新读取本地 revision，再由中心管理员核对并撤销未确认凭据，最后签发新码**。不得自动重试、盲目复用码或撤销不明确的凭据。旧绑定只在新文档完整提交时替换；同 revision 并发只有一个赢家。

## 拉取、缓存与本地操作

- `listReleases({ packId?, limit?, beforeId? })`：SDK 使用宿主 Bearer 请求授权目录，失败直接报错。manager 保留同一绑定 revision 的进程内成功快照，失败显示 stale/errorCode，不伪造空目录或“已最新”；进程重启后没有历史目录快照，不声称缓存跨重启。
- `getRelease(releaseId)`：验证签名清单和报告摘要；差异不可用时保留 `BASELINE_UNAVAILABLE`，不把它变成“没有变化”。目录/差异/说明是元数据，不能替代安装时的签名和内容验证。
- `install({ releaseId, expectedGeneration, operationKey, target?, connectionRevision?, signal? })`：未安装版本重验授权并获取短期 grant，签名和确认的三项摘要一致后有界下载。HTTP 队列强制 target/revision。默认 64 MiB，上限可显式配置到 1 GiB；总期限覆盖响应体。禁止重定向、环境代理自动发现、Cookie、Origin、Sec-Fetch、自动重试；校验归档、内容树、结构与不可变身份后**仅缓存，不自动启用**。已安装且再次完整验证的同一版本可离线确认缓存，不重复下载；卸载后新安装仍须在线授权。
- `updateEnable` 是明确的下载并启用操作；启用预检失败时保存已验证缓存，返回 `installed_not_enabled`，原 active 保持不变，队列显示失败。之后启用须使用新 operationKey 和当前 generation；重试旧键只返回原部分失败回执。
- `replayInstall(input, activate = false)` 只读历史操作回执，无网络或新安装。操作类型、原 generation、releaseId 与完整 target 必须一致；永久保留的签名清单核对 manifest/artifact/content-tree 三项摘要。解绑、离线、撤销、下架及后来卸载都不触发重新分发或恢复旧 active。返回原 operation 及**当前** state。
- `enable` / `disable` / `rollback` 全部是显式本地操作，要求提供真实宿主 `validateActivation`。没有该适配器时拒绝操作，不能用空回调冒充 DSH 编译验收。回退到已安装版本、固定依赖与现有能力检查由 pack-store 执行，不联网。
- `localState()`、`localRelease()`、`activeSnapshot()`、本地 mutation 返回值是**宿主内部对象**，含库存路径，绝不能直接 JSON 返回浏览器。HTTP 使用 `src/pack-center-wire.ts` 独立 DTO，并再次投影、过滤敏感文本。

下载不持有状态锁。下载后采用固定锁序 **connection → inventory**：`withRevision` 持有连接锁直至本地提交完成，解绑/换绑只能排在线性化提交之前或之后，不会在它们完成后再用旧 revision 提交。取得连接锁并通过最后一次取消检查后，就进入不可取消的本地安装阶段（包括初始化、验包、等待库存锁和提交）；等待连接锁时的取消须等取得锁或锁超时才返回。不能把已提交状态误报为回滚。只清理本次独有暂存目录，不删除已安装库存。

`unbind({ expectedRevision })` 只清除本地 token，保留身份、历史 pins 和本地包，因此离线快照和本地操作仍可验证；它**不是**中心侧凭据撤销。中心管理员应另外撤销不再使用的凭据。离线操作不使用已过期/撤销的 token，也不临时访问中心或 Git。

同一目录对永久绑定一个 centerId；换中心必须新建部署目录，不允许清空凭据后接管已有库存。初次绑定要求 inventory 为空或不存在；私密连接缺失而库存已有 state、归档或孤儿文件时，返回 `CENTER_INVENTORY_NOT_EMPTY`，不会自动修复或迁移。同一中心迁移域名允许显式新绑定，旧凭据不会发送给新域名。公钥轮换可独立确认后追加，历史 pin 保留供离线版本验证，同 keyId 不允许重映射；没有自动删 pin 或跨中心迁移功能。

## 插件配置、页面与本地 API

管理员配置 `packCenterOrigin` 为纯 HTTPS origin；`packCenterDir` 为部署独占规范绝对路径，未填时仅使用 `<DSH_HOME>/expert-library-pack-center`。没有 DSH_HOME 和显式目录时禁用，不写插件安装目录或任意工作区。两项修改要求重启插件：当前进程保留旧本地库存、拒绝新远端/写操作并显示 `CENTER_RESTART_REQUIRED`，不悄悄切换到空目录。浏览器「来源设置」只显示配置地址，不能传入任意 URL。

客户端入口：设置 → 领域包中心 → **领域包目录 / 已安装 / 更新 / 来源设置**。保留原领域包预览和专家库管理页面。新页面的本地管理令牌仅驻留当前组件内存，刷新后重新输入；切换令牌卸载旧权限状态。机器凭据始终留宿主；一次性码提交后清空，公钥需独立核对再确认。legacy 包仅展示，仍走原管理/迁移流程。

固定前缀 `/plugins/dsh-expert-library/manage/center`：

| 方法与路径 | 行为 |
|---|---|
| `GET /connection`、`POST /bind`、`POST /unbind` | 脱敏连接、一次绑定、解绑保留本地内容 |
| `GET /catalog`、`GET /releases/:id` | 授权目录、固定发布详情/摘要/报告/差异摘要 |
| `GET /installations` | 本地 generation、版本、完整性与启用状态 |
| `POST /check-updates`、`GET /updates` | 手动元数据检查、读取最后结果；不安装或切换 |
| `POST /operations` | 持久记录固定请求，返回 HTTP 202 与 operationId |
| `GET /operations`、`GET /operations/:id` | 刷新恢复和真实阶段轮询 |
| `POST /operations/:id/retry` | 显式重试原请求，不更换目标或 generation |

每次请求均独立验证 manage token/严格 loopback 规则，并强制 `x-pack-center-ui: 1`；检查 Host、Origin、Fetch Metadata 与重复安全头，不开放 CORS/OPTIONS。任何 `forwarded`、`x-forwarded-*`、`x-real-ip`、`cf-connecting-ip`、`via` 头的存在（含空值）都取消本地免令牌，重复转发头也拒绝。反代部署应保留真实 Host 并提供转发头，不可把公网请求伪装成无转发标记的本机直连。管理令牌优先通过宿主凭据环境 `DSH_EXPERT_LIBRARY_MANAGE_TOKEN` 提供；这是本地管理员令牌，不是中心机器凭据。写请求只接 JSON（64 KiB、10 秒正文期限），严格拒绝未知字段。鉴权失败返回 403。成功 `{ok:true,data}`；失败只含固定 code，可选固定 reason，不含原始异常、宿主路径或凭据。

`POST /operations` 支持 install/update_enable/enable/disable/rollback/uninstall。全部强制 operationKey、expectedGeneration；远端两类另外强制 releaseId、connectionRevision、manifest/artifact/content-tree 三摘要；本地 enable/uninstall 只需 releaseId，disable 只需 packId，rollback 两 ID 都要。确认后不自动改选新版，不自动重试写请求。

## 持久队列与运行边界

`<packCenterDir>/operations` 使用 0700/0600、fsync+rename、事务 flock 和单执行器 flock，多进程不重复执行。阶段为 queued/preparing/authorizing/downloading/verifying/installing/activating/committing/recovering/completed/failed/interrupted；显示阶段而非编造百分比。重启继续未开始任务；中断运行任务只查本地回执，无确定回执则标 interrupted，等待显式重试。存储损坏不覆盖，启动/后台故障由状态接口明确报告。绑定已提交后队列启动失败仍返回新绑定 revision 和队列错误，不能伪装绑定未发生。

首版保守限制：最多保留 256 个 operation，达到上限拒绝新增，不自动删除历史；尚无归档/清理 UI。目录缓存最多 32 个查询页，仅进程内保存；更新检查逐包最多 20 页、每页 100 条，达到边界明确报错，不宣称已遍历完。无自动检查、自动全量升级或中心推送安装。

`pack-center-host.ts` 将纯本地 `activeSnapshot` 接入 runtimeConfig，启动和正常运行加载不请求远端（恢复排队的新安装属于明确管理操作）。启用前以真实 builtin、Zhijian、每个已注册工作区的 collaboration base 以及实际 workspace/vendor 选择做合并预检；兼容版本读取本插件 package.json，内置依赖版本来自真实 base。运行路径每次重新验证本地 active，异常不降级换版本。旧库存不删除，已编译快照保留。

仍待总验收：两个真实隔离 DSH、实际 provider 与长任务惰性资源生命周期、完整浏览器升级/回退、迁移和运维恢复演练。真实 HTTP/Chromium 测试壳及宿主客户端目录**不是两个 DSH 进程**，不能因此标记整个 Goal 完成。
