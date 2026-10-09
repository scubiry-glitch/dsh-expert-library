# Pack artifact v1

Linux-first、无第三方依赖的确定性 POSIX ustar 归档模块。用于中心固定送审产物及插件安全解包；本包不连接网络、不执行仓库脚本、不验签、不运行领域包 schema 校验。

```js
import { packDirectory, extractArtifact } from './index.mjs'
const artifact = await packDirectory(frozenNormalizedTree, newArchiveFile)
// 调用层必须先验证完整发布清单与可信 Ed25519 签名，再传入期望值。
const installed = await extractArtifact(downloadedArchive, newStagingTree, verifiedManifest)
```

两个函数均返回 `{artifactSha256,sizeBytes,contentTreeSha256,fileCount,contentSizeBytes}`。`sizeBytes` 是 tar 原始字节长度；`contentSizeBytes` 是文件内容字节总和。读取端必需期望字段是前四项，可直接传入已验签的完整 manifest。内容树编码沿用 `../pack-contract` 的 `assertSafePath/canonicalBytes/sha256`，对照测试覆盖 `hashContentDirectory` 和 `hashContentTree`。

可选最后一个参数为 limits：`maxArchiveBytes` 默认 160 MiB，`maxFileBytes` 16 MiB，`maxTotalBytes` 128 MiB，`maxFiles` 10000，`maxEntries` 20000（含目录），`maxPathDepth` 64。仅接受这些非负安全整数字段。文件读写与摘要以 64 KiB 分块进行，限制在创建内容前执行；不读取或解压 gzip，归档不存在压缩比攻击面。

写端按完整相对路径 UTF-8 字节序排序，包含空目录；uid/gid/mtime 为 0，用户/组名为空，文件 mode 0644，目录 0755，USTAR name/prefix 精确拆分，末尾两个 512 字节零块。长路径若无法符合字段容量则拒绝，绝不截断。归档源必须是调用者冻结、规范化、独占的独立树；本包拒绝所有 `.git` 组件、链接、硬链接、特殊文件、不合法 UTF-8、非 NFC 路径和路径逃逸，不隐式删除任何内容。

读取端先验证原始字节长度与 SHA-256，再在私有暂存目录解析。仅接收 POSIX ustar 普通文件和目录，拒绝软硬链接、设备/FIFO、GNU/PAX 扩展、重复条目、文件目录冲突、非法八进制/checksum、非零填充、截断和拼接归档；校验提取后文件数及规范树摘要。多余尾零块可接受。归档第二次读取继续计算 SHA-256，并检查读取前后 stat；任何错误均不发布目标目录。

输出父目录必须已存在、是真实目录、由调用者独占控制；输出文件或目标树必须不存在，即使为空也不覆盖。打包在同父目录创建私有随机 staging，原子硬链接发布（目标并发出现时失败）；解包使用同级 `.<destination>.pack-artifact-lock` 排他目录，完整验证后 rename 发布。该父目录不能位于输入树内，不能是攻击者或其他不遵守锁协议的进程可写目录；这是安全边界，不是跨不可信共享目录的 no-replace rename 实现。

正常失败会清理本次拥有的 staging/锁，不删除已有目标。进程强制终止可能留下隐藏 staging/锁，绝不会把未完成树发布到 destination；调用层按自己任务记录清理孤立 staging，重试使用新隔离路径。调用层还负责磁盘配额、签名信任、结构校验、不可变版本入库和最终状态提交。源树冻结仍由调用层负责；此模块 `O_NOFOLLOW`、链接检查及读取前后 inode/size/mtime/ctime 检查用于拒绝链接与意外变动，不能代替操作系统级隔离不可信并发写入者。

错误沿用 `ContractError`：`INVALID_CONTRACT`、`INVALID_PATH`、`UNSUPPORTED_FILE`、`LIMIT_EXCEEDED`、`INTEGRITY_MISMATCH`、`STATE_CONFLICT`、`SOURCE_FAILED`。执行 `node --test packages/pack-artifact/test/*.test.mjs` 或在本目录 `npm test`；测试包括两版真实样例、字节可重复性、摘要互通、恶意 tar、限制、并发、防覆盖、脚本不执行及失败清理。
