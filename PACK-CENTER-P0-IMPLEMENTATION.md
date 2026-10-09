# Pack Center 本地基础实现与验证边界

> 日期：2026-09-19。工作树：`/root/zhijian/dsh-pack-center-dev.ZGtty5`。
> 这是 F02/F03、L01–L03 的组件交付说明，不是中心已上线或 A01–A24 已通过的声明。

## 已实现的模块

| 模块 | 职责 |
|---|---|
| `packages/pack-contract` | 同源 schema、严格 SemVer、规范 JSON、树摘要、Ed25519 签验、更新候选；未来协议可展示但不可安装 |
| `packages/pack-artifact` | 确定性 USTAR；限额、安全解包、归档与内容双重验证；拒绝链接/逃逸/覆盖 |
| `src/pack-validator.ts` | 独立纯校验入口，复用原 V2 loader/validator，不启动 DSH |
| `src/host/pack-center-state.ts` | 跨进程锁、generation CAS、幂等请求、原子持久提交、验证前态后的只读恢复 |
| `src/host/pack-store.ts` | 不可变版本库存、安装/显式启停/回退/卸载、依赖及实体冲突、旧包接管和恢复 |
| `src/host/pack-legacy.ts` | 旧 vendor 的完整本地备份、真实归档摘要和本地来源收据；不修改旧源和状态 |
| `src/host/pack-runtime.ts` | 本地快照桥接、真实合并预检；四个既有工具/列表入口已调用桥接 |
| `src/v2/runtime-pack.ts` | 只加载显式快照；空中心列表全停用；精确路径抑制、稳定顺序、完整缓存身份与冻结结果 |

`apps/pack-center` 是独立应用，构建/依赖不混入插件的默认构建。中心 API、身份服务、Worker 和三组真实界面仍需接线，不能据本页宣称已经可用。

## 磁盘与持久化约定

```text
<deployment-private-pack-root>/
├── state.json                 # schema/generation/installed/active/operations
│                              # acceptedReleases/legacySuppressions
├── state.prev.json            # 上一次状态；异常恢复前须验证引用
├── .state.lock                # 永不删除；Linux flock 锁定同一 inode
├── releases/<release-address>/
│   ├── release.json           # 完整签名清单，位于内容树之外
│   └── content/               # 未修改的审定内容树
├── legacy/<contentTreeSha256>/
│   ├── legacy.json            # 明确 source=legacy，非中心签名
│   ├── artifact.tar           # 本地原内容的真实归档
│   └── content/               # 完整备份，不改 generated 文件
├── .incoming/                 # 新中心版本的每次独立临时目录
└── .legacy-incoming/          # 旧包备份的每次独立临时目录
```

`release-address` 是中心 ID 与 release ID 的规范 JSON 摘要，不能由外来名称直接组成路径。内容目录不在 vendor 自动发现目录内。签名、摘要、身份、路径、V2 结构验证成功且文件/目录同步落盘后，才提交状态引用；无引用的完整目录不会自动运行。

安装默认不启用。只有显式 `enable` / `install(activate: true)` / `rollback` / `takeOverLegacy` 能改变启用映射，停用不会重新打开被抑制的旧 vendor 路径。所有状态写请求必须带 `operationKey` 和 `expectedGeneration`；同键同体返回原结果，同键异体拒绝，过期 generation 拒绝。

`acceptedReleases` 是永久的已接受发布身份账本，不随卸载删除。相同中心/包/完整版本字符串不能重新绑定另一发布或清单；SemVer build metadata 不提高更新排序，但属于不同版本身份。

卸载只移除安装引用，不物理删除库存。这是保护旧任务文件路径的必要措施，不是完整的任务生命周期跟踪；首版尚无自动 GC。后续不能绕过在途引用检查添加自动删除。

## 操作结果与错误

`install` 的状态事务成功不一定等于“更新并启用”成功。经过验证的下载若遇到依赖或主机合并阻断，将保存：

```text
operation.result.status = installed_not_enabled
operation.result.activated = false
operation.result.activationError = { code, message }
operation.result.previousActiveReleaseId = 原启用版
```

接口/UI 必须把这一结果显示为“已下载，未启用；旧版保持”，不可直接映射为成功。管理员修复条件后使用新 operation key 发起启用。同一个幂等请求的历史失败结果不能变成悄悄重试后的成功。

签名/归档/库存完整性、状态损坏、只读恢复及 generation 错误不会被转换成普通缓存成功。状态提交后响应丢失会报 `STATE_COMMIT_UNCERTAIN`，须原样重试相同键与请求查明结果，不能盲目创建另一操作。

正常本地回退只使用已装内容，不访问中心/Git；按当前插件能力、完整性和依赖重新检查。中心版本按明确的较旧 SemVer 选择；旧包的非规范版本不猜大小，只允许显式选择记录中的前一个本地快照。

## 运行时接线约定

`ToolsConfig.getPackCenterSnapshot` 是内部函数，不是用户可编辑的 JSON 设置。每次运行获取本地快照，异常向调用者传播，不能降级成看似正常的 builtin 结果。

`createPackStore` 的 `validateActivation` 必须由后续主机初始化接到 `preflightManagedActivation`，并提供实际 builtin bases 和当前 workspace/vendor 设置。该预检和实际运行都会对真实加载的层做冲突检查；没有任意覆盖开关。现有仅 legacy 的覆盖语义保持不变。

旧源接管在一次状态提交中同时登记备份、启用它并排除精确旧路径；旧源本身不删除。旧源后来改变或消失不会改变已启用备份，但恢复本地管理必须验证旧源未变，否则要求显式解决冲突。接管记录从不进入中心的已接受签名账本。

当前四个入口的桥接已存在，但真实 provider 初始化、中心配置/凭据、本地 API、前端按钮、长任务的惰性资源/依赖引用仍未接完。因此不能据冻结对象和保留目录测试宣布 A10/A17/A20 的完整业务链已验收。

## 平台和安全边界

- 首版 Linux + util-linux `flock` + 支持 `fsync`/原子 rename 的本地文件系统。不宣称 Windows、NFS 或多机共享目录写入保证。
- 父进程 fd 持有内核锁；取锁子进程退出不释放父 fd 的锁；父进程崩溃会释放。禁止以删除锁文件“清理陈旧锁”。
- 私有库存根由宿主独占。模块拒绝链接和路径逃逸，但不宣称可以对抗同 UID/管理员持续恶意修改文件系统。
- 测试中的 SIGKILL 是真实进程中断，不等于物理断电/存储设备故障演练。
- 只读恢复保留损坏的 state 原文；没有未经审批的自动覆盖修复工具。
- 本轮不修改 DSH 核心、不重启生产、不推送代码、不改正式域名或生产凭据。

## 复现命令

在隔离工作树中运行：

```bash
pnpm build
node --test 'test/**/*.test.mjs'
node --test 'packages/pack-contract/test/*.test.mjs' 'packages/pack-artifact/test/*.test.mjs'
```

也可使用新增 `pnpm test:pack-center`（包含构建和相关测试）；中心应用有自己的 `apps/pack-center` 命令，不属于这个脚本。

源码定向测试使用各测试文件明确提供的 `PACK_STATE_SOURCE` / `PACK_STORE_SOURCE` / `PACK_RUNTIME_SOURCE` / `PACK_CENTER_TEST_SOURCE` 环境开关。交付回归必须使用刚构建的 `lib`，不能把新源码测试与旧编译产物混用。

本页记录实现和限制；本批最终构建、测试计数、源码指纹与未完成项另见 `PACK-CENTER-P0-EVIDENCE.md`。完整功能验收仍以 `PACK-CENTER-GOAL-ACCEPTANCE.md` 为准。
