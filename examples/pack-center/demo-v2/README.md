# 样例 V2

用途：更新与回退验收，不含真实业务资料或凭据。

版本为 1.1.0，与 V1 同属 `demo.review`。启用后专家公开名称应变成“样例 V2”，回退后恢复“样例 V1”。

从源码仓库使用时先构建插件，再从插件仓库根目录运行：

```bash
node scripts/dsh-pack.mjs check examples/pack-center/demo-v2
```

提交到中心时，将本目录内容作为同一公开 Git 仓库的后续提交并创建新的 tag。
