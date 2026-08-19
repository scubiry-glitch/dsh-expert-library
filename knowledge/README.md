# 知识包目录（Knowledge Packs）

把资料包按下列结构放入**队长的会话工作区**（通常是启动 DSH 的目录）：

```
<workspace>/
└── knowledge/                      # 目录名由插件配置 knowledgeDir 决定（默认 knowledge）
    ├── experts/
    │   ├── <expertId>/…            # 该专家的专属资料（markdown/pdf/docx/xlsx/…）
    │   │                            #   如 researchers 专属、security-reviewer 专属
    │   └── <expertId>.json         # 可选：自定义专家定义（覆盖同名内置专家）
    ├── scenarios/
    │   ├── <scenarioId>/…          # 该场景的专属资料（需求文档、样例、模板）
    │   └── <scenarioId>.json       # 可选：自定义场景定义
    └── shared/…                    # 所有专家共享的资料
```

## 工作机制

- 插件**不解析资料内容**：成员（专家子代理）用自己的文件/阅读工具直接读取这些文件。
- 每个专家的 persona 会注入一份**知识指引**，列出其专属资料目录与文件清单，成员开工前会先查阅。
- 资料是**惰性生效**的：任何时候把文件放进目录，下一次成员被唤醒/创建时即可读到，无需重启或重新构建。
- 自定义专家/场景 JSON 的字段与内置定义一致（见 `src/expert-library/types.ts`），放在目录中即可覆盖内置同名条目。

## 内置专家 id

`researcher`、`engineer`、`qa-engineer`、`security-reviewer`、`designer`、`docs-coordinator`、`data-analyst`、`team-lead`

## 内置场景 id

`code-review`、`market-research`、`product-design`、`fullstack-build`、`security-audit`、`documentation`

## 建议的资料包命名

- 每个专家一个子目录，文件名带语义（如 `01-checklist.md`、`02-style-guide.md`）。
- 场景资料放 `scenarios/<id>/`，与专家资料互不干扰。
- 通用知识（行业报告、术语表、团队规范）放 `shared/`。
