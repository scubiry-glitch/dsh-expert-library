# 江苏银行信用卡提质增效研究 · 任务归档（单一 task 目录结构）

> 归档日期：2026-08-21｜整理：队长（专家库团队会话）
> 结构对齐插件代码规范：`expert-tasks/<taskId>/{input, output, artifacts}`（`createTaskProject`，见 `src/state.ts`）。
> 背景：本任务运行时插件加载旧构建（`project=None`、无 `expert-tasks/`），产出分散在多个目录；本归档按代码要求的单一 task 目录结构重新归位（A 验证 + B 整理）。

## 目录结构

```
江苏银行信用卡提质增效_任务归档/
├── README.md                         ← 本说明
├── team.json                         ← 团队元数据（原 .expert-teams/archive 副本）
├── _A验证_任务项目目录脚本.mjs         ← A 部分验证脚本（node 运行，已通过）
├── 00_输入材料/
│   ├── 高端信用卡战略_input/          ← 用户补充 zip 解压（10 报告 + model_b/c.py + HTML）
│   └── 同业对标数据/
│       └── 各行指标趋势变化（用户上传2026-08-21）.xlsx  ← 用户对标表（E1 基线）
└── expert-tasks/
    ├── t1_知识库盘点与完善度评估/
    │   ├── input/task.json           ← 任务定义+完成摘要
    │   └── output/01_知识库盘点与完善度评估.md
    ├── t2_UE与产品组合模型/
    │   ├── input/task.json
    │   └── output/02_UE与产品组合模型.md / .xlsx
    ├── t3_同业对标与四指标敏感性分析/
    │   ├── input/task.json
    │   └── output/03_同业对标更新与四指标敏感性分析.md / .xlsx
    └── t4_经营策略报告（含高端卡专项）/
        ├── input/task.json
        ├── output/
        │   ├── 04_江苏银行信用卡提质增效经营策略报告.md / .pdf   ← 主交付（V1.1）
        │   ├── 04_..._高级版.pdf / 命题一页_高级版.pdf            ← 创造模式会话产物
        │   ├── 05_高端信用卡专项增补与整合.md
        │   ├── UE与产品组合模型_导出.xlsx / 同业对标与敏感性分析_导出.xlsx
        │   └── 策略报告核心结论_导出.docx
        └── artifacts/
            ├── md2pdf_style.py / md2pdf_premium.py / md2pdf_topics.py  ← PDF 生成脚本
            └── 江苏银行信用卡分析.univer
```

## 文件来源标注

| 文件 | 生成方 | 证据等级 |
|---|---|---|
| 01–05 报告、02/03 模型 xlsx、04 主报告 md/pdf | 本会话专家库团队（t1–t4） | 全部标注 E0–E4 |
| 04_高级版.pdf、命题一页_高级版.pdf、md2pdf_premium.py、md2pdf_topics.py、UE/同业导出.xlsx、核心结论.docx、江苏银行信用卡分析.univer | **创造模式会话**（2026-08-21 11:15–11:25，非本会话） | 内容同源，来源见各文件 |
| 高端信用卡战略_input/ | 用户补充压缩包解压（2026-08-21） | 材料内三态标注（事实/假设/推断/待核实） |
| 各行指标趋势变化（用户上传）.xlsx | 用户上传（t1 核验与知识库版 0 差异） | E1 |

## 原目录去向

- `工作区/江苏银行信用卡提质增效_产出/`：内容已全部移入本归档（原目录保留空壳说明）。
- `工作区/高端信用卡战略_input/`：已移入 `00_输入材料/`。
- `工作区/.expert-teams/archive/江苏银行信用卡提质增效研究/`：插件运行时状态（team.json + inbox 邮箱），已完整备份到本归档 `_插件原始状态备份_archive/`（双保险）；原隐藏目录可安全删除。

## 目录可见化安排（2026-08-21）

- 已修改 `/root/.dsh/profiles/web/cordis.patch.yml`：`expert-library` 的 `stateDir` 由默认 `.expert-teams`（隐藏）改为 `expert-teams`（可见）。
- 效果：**重启 DSH 主机后**，新团队的团队状态与任务目录自动落在可见位置：
  `<工作区>/expert-teams/<teamId>/expert-tasks/<taskId>/{input, output, artifacts, project.json}`
- 存量归档（本目录）不受影响；重启后旧隐藏 `.expert-teams/` 不再被读取，历史已由 `_插件原始状态备份_archive/` 兜底。

## 复现与验证

- A 验证（单一 task 目录）：`node _A验证_任务项目目录脚本.mjs` —— 用当前已构建 lib 驱动 `createTaskProject`，输出 `expert-tasks/tN/{input,output,artifacts}`，验证后自动清理临时目录。
- 结论：插件新构建已具备 `expert-tasks/<taskId>/` 机制；DSH 主机重启后新团队任务将自动使用该结构；队长在任务描述中应让成员把产出写入任务项目目录或经 artifact 发布，而非自定义输出路径。
