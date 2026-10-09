# 样例 V1

用途：提交、审核、发布和安装验收，不含真实业务资料或凭据。

版本为 1.0.0。启用后，`demo.review.expert` 的公开名称应为“样例 V1”。

从源码仓库使用时先构建插件，再从插件仓库根目录运行：

```bash
node scripts/dsh-pack.mjs check examples/pack-center/demo-v1
```

提交到中心时，将本目录内容作为公开 Git 仓库的根目录，显式选择提交 ref。
