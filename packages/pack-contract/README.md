# Pack contract v1

独立 ESM 协议包，无 DSH 运行时或第三方运行依赖，要求 Node.js 22 或以上。`index.mjs` 可直接导入，`index.d.mts` 提供类型。执行 `node --test --experimental-test-isolation=none packages/pack-contract/test/*.test.mjs`，或在本目录运行 `npm test`。关闭测试进程隔离以便受限环境也能输出每一项实际断言结果；用例不共享可变状态，文件场景各用独立临时目录。

## 接口与校验边界

`validateReleaseManifest / validateSubmission / validateReport / validateOperation / validateDistributionScope / validatePrincipal` 返回 `{ ok, issues: [{ path, code, message }] }`。`assertContract(kind, value)` 返回原值或抛出带稳定 `code` 的 `ContractError`。全部对象默认拒绝未知字段、非 JSON 属性与自定义原型；数组拒绝稀疏和额外属性；协议、规范化、摘要算法版本固定为 1，领域包 schema 固定为 2。计数与 generation 只接受非负安全整数且拒绝负零，摘要必须是 64 位小写十六进制，来源 commit 是 40 或 64 位小写十六进制。版本采用严格 SemVer，拒绝 `v1.0.0`、缺段、空白和前导零。

发布清单是不可变身份/兼容性/产物描述，`publishing / published / publish_failed / yanked` 是数据库发布记录状态，不在签名清单里增改。发布范围同样由中心授权记录控制，不允许调用者仅凭自报 scope 获得权限。权限类型的结构校验不是身份认证或授权实现。`assertTransition` 只验证状态边；服务端仍必须执行作者分离、组织授权、已通过报告、固定摘要、expectedVersion 和事务检查。失败或退回后的修订创建新 Submission 并关联 `previousSubmissionId`，不能复用旧快照。

Submission 的 `source.ref` 必填，界面默认分支可显式传 `HEAD`。HTTPS 语法检查不提供 SSRF 防护，Worker 必须另行检查域名、解析结果、跳转和实际出网目的地。

## 归档与规范树

协议 v1 的 `archiveFormat` 为 **未压缩 tar**。包文件位于归档根目录，不增加顶层包装目录。归档读端只接收标准 POSIX ustar 的普通文件和目录；拒绝软/硬链接、设备、FIFO、PAX/GNU 扩展、路径逃逸、重复项及文件/目录冲突。条目校验、流式大小限制、tar 解析和提取属于安装器，不由本包实现。

写端使用 UTF-8 路径字节顺序、mtime/uid/gid 为 0、空用户/组名、普通文件 mode 0644、目录 0755、USTAR 路径字段和末尾两个 512 字节零块，不添加 gzip 时间戳或扩展头。超过标准路径字段容量的路径拒绝，不截断。读端校验下载原始归档 SHA-256 及长度，不能重新打包后比较。签名 `sizeBytes` 是 **tar 原始字节长度**；树摘要函数返回的 `sizeBytes` 是 **全部文件字节之和**，两者不能混用。

规范化在送审前完成：移除所有 Git 元数据，形成不含 `.git` 路径组件的独立文件树。`hashContentDirectory` 不隐式过滤或改写；遇到 Git 元数据、链接、硬链接及特殊文件直接拒绝。所有普通文件，包括 `generated/`，纳入摘要。脚本仅按普通内容纳入，不执行。空目录、权限和时间不纳入内容树摘要，不能承载行为差异。路径使用 NFC Unicode、`/` 分隔、无空组件、`.`、`..`、控制字符、冒号或反斜线；拒绝不合法编码。`hashContentDirectory` 读取调用方控制的已冻结目录，不代替隔离、安全解包、磁盘限额或并发修改保护。

## 摘要、规范 JSON 与签名

每个文件记录 `{ path, sizeBytes, sha256 }`，`sha256` 是原始文件字节摘要。按 path UTF-8 字节序排列文件记录后：

```text
contentTreeSha256 = SHA256(
  UTF8("dsh-pack-tree-v1\0") +
  canonicalBytes({ schemaVersion: 1, files: sortedFileRecords })
)
```

`hashContentTree([{ path, bytes }])` 和 `hashContentDirectory(root)` 返回同一结构 `{ contentTreeSha256, fileCount, sizeBytes, files }`。路径与文件内容先结构化编码，避免拼接边界歧义。目录/文件冲突和重复路径拒绝。

规范 JSON v1 是本协议定义的编码，**不是 RFC 8785 的完整实现**：对象键按 UTF-8 字节序递归排序；数组保序；字符串按 JSON 编码且拒绝孤立代理项；数字仅允许安全整数且拒绝负零；无空白或 BOM，UTF-8 字节。拒绝 undefined、NaN、无限数、小数、BigInt、稀疏数组、循环、非普通对象及非 JSON 键。`reportSha256 = SHA256(canonicalBytes(report))`，报告与清单都保存于包树外。

`manifestSigningBytes(manifest)` 首先验证完整清单，再返回规范字节。`signReleaseManifest(manifest, privateKey)` 只接受 Ed25519 私钥，返回 `{ manifest, signature }`；signature 是 64 字节分离签名的标准 base64（含 padding）。`verifyReleaseManifest(envelope, trustedKeys)` 在解析公钥和验签前验证清单；仅使用调用者预先信任且按 signingKeyId 索引的 Ed25519 公钥。公钥更新和信任根校验不由下载清单决定。签名不包含外置 signature 字段；不存在递归摘要。包不生成、不持久化密钥。

## 更新候选规则

`selectUpdateCandidate` 只处理调用者已经成功获取、已经授权、已发布的元数据；不联网、不修改状态、不安装。无权、超时、离线须由调用层返回错误，不能用空数组冒充成功。真正成功但没有可见稳定版时返回 `no_stable_release`，不显示最新。

只比较相同 centerId、ownerOrgId、packId；混入不同身份直接报错。同一个完整版本字符串或 releaseId 的规范清单必须全量一致，包括所有摘要、兼容要求和 signingKeyId；任何变化报 `IMMUTABLE_VERSION_CONFLICT`，首版没有同 release 换签名 key 的例外。SemVer build metadata 不提升优先级，预发布默认不参与候选；显式安装预发布走单版本安装接口。数字按精确十进制字符串比较，不发生大版本号舍入。

`validateCatalogRelease` 支持展示采用未知协议/schema/算法的目录项，但仍严格检查现行目录形状、字段类型、必填与未知字段。`CatalogRelease` 与可安装的 `ReleaseManifest` 类型分离；未知版本显示为最新可见版并产生 `unsupported_*` 阻断原因，选择器继续查找兼容旧版。安装、签名字节和验签仍使用严格 `validateReleaseManifest`，拒绝所有未知协议与算法。未来若目录形状也改变，须升级目录协议，不能把任意新字段当已理解。

返回当前版、最新可见稳定版、严格更高且满足插件版本区间/schema 的候选版、被阻断的新版本及原因。已缓存候选返回 `candidateCached:true`，调用方显示待启用，不重复下载。插件最小版本是闭区间，maxVersionExclusive 是开区间。依赖、反向依赖、当前授权、下架、完整性及 generation 由 L05/L06 在操作前另行验证；F02 的候选不是承诺一定可启用。

## 验证覆盖

`test/schema.test.mjs` 覆盖发布、提交、报告、操作、分发范围与人员/机器身份结构，包含未知字段、错误计数、缺失快照和所有允许/禁止的状态边。导出的 `TRANSITIONS` 包括内部数组均不可修改。结构校验不代替中心授权与持久事务。

`test/content-signature.test.mjs` 固定规范 JSON、完整树摘要和清单签名字节向量，验证文件排序、原始字节、路径边界、generated 内容、符号/硬链接拒绝、信任公钥与全部签名字段覆盖。RSA512 虽能产生与 Ed25519 等长的签名，仍因实际 KeyObject 算法不同被拒绝。测试用签名密钥只在进程内临时生成，不写文件。

`test/updates.test.mjs` 覆盖精确 SemVer、未来协议目录展示、回落兼容候选、全量清单不可变、混入其他中心/归属拒绝、缓存提示及预发布默认排除。这些是离线协议证据，不能替代中心网页、真实安装器或两个部署点的验收。
