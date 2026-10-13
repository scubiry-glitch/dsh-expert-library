---
name: research-v5-writer
description: 仅用于智见观点驱动 V5 的观点成文与证据台账阶段，不加载旧版配额门禁。
---
# 观点成文与证据台账

阅读每位专家 evidence.md、用户选择和 expression-brief.md。用鲜明的判断组织全文，章节按论证需要重组。事实、推断、反证与未决问题分明；程序与回执放附件。借鉴智见报告工艺的清晰主张、证据解释、机制与边界，按论点灵活使用，不套六段章壳。

每个承重论点先理清“问题 → 判断 → 有口径的证据 → 推理桥梁 → 最强反例或竞争解释 → 裁决与未决 → 对总判断或读者决定的影响”。推理桥梁必须说清机制、比较基准、计算或排除过程；不能把相关性直接写成因果。正文按读者理解顺序自然展开，不要求上述环节变成固定小标题，也不设章数和字数配额。标题优先写判断；相邻章节说明已经解决什么、接下来还须判断什么。证据不够时缩窄主张、明确挂账或退回取证，不编造中间步骤。避免每节只剩一条数据和一句结论。

每个分析章在正文中给出一条可视化的真实关系及源句，供成品阶段做至少一张有论证作用的图。可选同口径比较、判读阈值、机制的已证与未证环节、不确定性边界；不可为凑图反推结论。缺乏证据时补证或合并章节。附件不计。不要在每段正文塞“画什么图”或 skill 调用说明；正文保持面向读者的论证。

正文定稿后另交 figure-plan.json，作为逐章图稿清单：schemaVersion=1、reportSha256 为报告原字节 SHA256、chapters 按实际分析 H2 顺序逐章一项。每项写 chapter、claim（图要传达的真实观点）、relation（核心逻辑关系）、encoding（推荐视觉编码）、decision（读者应怎样理解或决策）、sourceQuote（本章报告原句）、sourceClaimIds（含该原句的台账 claim id 数组）；跨多处证据时加 supportQuotes（报告原句数组）。表达简报的候选仅供参考，最终清单必须随实际材料和章节重写。OUTLINE.md 对每个实际章节写出本次材料带来的新判断、与常见解释的差异、支撑及最强反证，并说明章节递进；这些是审核线索，不是固定正文小标题。独立内容评审一并审图稿清单与逐章论证。

输出 report.md、OUTLINE.md（最终实际结构）、report-source-ledger.json、figure-plan.json。台账 schemaVersion=2，reportSha256 为报告原字节 SHA256；sources 为真实来源数组，claims 为核心判断数组，unresolved 为未决问题数组。来源字段 id/title/accessedAt，加 url；调用数据用 kind=provider_receipt、provider、receipt={path,sha256,callPath,callSha256}，路径相对团队根。claim 包含 id、quote（正文原句）、kind=fact|inference|calculation、sourceIds。含实质数值的判断补 numeric=true、unit、period、caliber。kind=calculation 时，calculation **必须是一个非空字符串**，在同一字符串里写实际输入、公式、结果，例如 `"calculation":"输入 A=2、B=3；公式 A+B；结果 5"`；对象或数组不能通过 Host 校验。不得把未知值设为零或抹去反证。机器格式通过不代表论证或事实正确。

## 提交

遵循 Host 的 current_action，以本任务发布声明为准。在原任务同一 attempt 内修订，不为提交方式错误新建替代任务。内部材料由 Host 校验并锁定后自动流转；只有正文和成品进行独立评审，不把内部材料称为已审结论。提交失败按具体错误重试，不能伪造回执。

## 独立内容评审

审核者读取当前稿和原始来源，逐个承重章节检查判断、证据、推理桥梁、最强反例、边界与决策含义是否都能定位；特别识别“列出数字却没解释为何支持结论”和“把无覆盖写成否定证据”。再核查主张是否超出证据、关键单位与计算是否正确。review_audit 放 content-audit JSON 代码块，argument、novelty、sources、calculations、uncertainty、coverage 分别写实际复核记录，novelty 逐章说明与常见解释相比本次证据支持了什么新增判断、哪些观点只是旧话或证据不足；argument 与 coverage 指出检查过的章节和缺失环节；没有算术就说明无适用计算，不能填虚假抽验。Host 自动绑定本稿哈希。通过后系统原子集成；真实内容问题在本任务修订，工具通道失败保留可重试状态，不消耗内容修复预算。
