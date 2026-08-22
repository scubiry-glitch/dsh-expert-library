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

---

# 约定检查与设置手册（Skills / 工具使用）

Skills 与工具使用约定分布在五层，各层的「在哪检查、在哪设置」如下：

## ① 模型侧协议（什么时候调用什么工具）

- **定义**：`src/index.ts` 的 `usageSectionText()` —— 注入系统提示词的使用协议（expert_teams_* 八步流程、智见点评 A–E 框架、协作模式）。
- **检查**：设置页「提示词顺序」(`promptSectionOrder`，默认 117)；「向 Agent 注入专家库使用协议」开关 (`announceToAgent`)。
- **设置**：改协议文本本身需改源码 `src/index.ts`。

## ② 专家/场景级约定（谁能用什么能力）

- **定义**：Domain Pack 实体 —— `domain-packs/zhijian-realestate/experts/bk-*.json` 的 `allowedCapabilities`、团队模板 runtime 参数、质量门（固定四阶段、硬门、≤2 修复轮）。
- **检查**：`GET /plugins/dsh-expert-library/packs`（Web 预览）或 `node scripts/build-zhijian-pack.mjs --check` / `node scripts/build-builtin-pack.mjs --check`（漂移校验）。
- **设置**：源在 `/root/.openclaw/workspace/skills/智见点评` 的 Profile JSON —— 改源后 `node scripts/build-zhijian-pack.mjs --src <源>` 重生成；**不要直接手改 pack 目录**（--check 会报漂移）。

## ③ Skill 安装与路由（本地技能）

- **定义**：`src/skills.ts` —— 技能**纯本地、只读解析**，从 `<workspace>/knowledge/skills/<id>/SKILL.md` 读取（≤1MiB，安全路径校验），不联网、不自动更新；场景可通过 `skill: {id, purpose}` 引用。
- **检查**：`<workspace>/knowledge/skills/` 目录清单；全局技能在 `~/.agents/skills/`（如 wind-mcp-skill、98/99wiki、wind-find-finance-skill）。
- **设置**：往 `knowledge/skills/<id>/SKILL.md` 放文件即安装（连同其 references/ 子目录）；引用关系改场景定义或 pack 源。
- **当前已安装**（2026-08-22，渲染环节用）：
  - `finesse-ui` —— 高工艺 Web 界面规范（register 路由 / craft floor / 反 cheapness / 动效分层），已通过场景覆盖 `knowledge/scenarios/research-report.json` 挂载到 `research-report` 的「渲染与分型验收」任务
  - `gsap-core` / `gsap-scrolltrigger` / `gsap-timeline` / `gsap-performance` / `gsap-plugins` / `gsap-react` / `gsap-frameworks` / `gsap-utils` —— GSAP 官方技能包，动效实现参考
  - `video-shotcraft` —— Remotion 电影感产品视频（152 镜头配方卡 + Ink Press 已验收模板 + 音频资产；demos/gallery 样片目录未装，按需补）；内置 `product-design` 场景已引用此 id

## ④ 数据源工具执行方式（Wind / zyt / 贝壳）

- **定义**：settings 的 `toolExecution`（api/cli/auto 模式、端点、超时）+ `providers` 配置 + capability→provider 路由表（`src/v2/providers/*.ts`）。
- **检查**：`GET /plugins/dsh-expert-library/health`（健康探测：注册状态/凭据存在性/可达性/延迟/pack 漂移）+ 设置页「数据源」区；ProviderRegistry 逐调用审计日志。
- **设置**：设置页「数据源」区编辑（端点/CLI 路径/执行偏好），保存后即时重注册免重启；**API Key 永远走文件/环境变量，不进设置文档**（刻意安全边界）。

## ⑤ 知识包与自定义覆盖

- **检查**：本目录 `knowledge/` —— `experts/<id>.json` 覆盖内置专家、`scenarios/<id>.json` 覆盖场景。
- **设置**：直接放文件，惰性生效免重启。

> 一句话：**协议改 `src/index.ts`，能力边界改 Domain Pack 源再重生成，技能放 `knowledge/skills/`，数据源在设置页，自定义覆盖放 `knowledge/`。**
