# V5 · 观点成文与证据台账

阅读每位专家 evidence.md、用户选择和 expression-brief.md。用鲜明的判断组织全文，章节按论证需要重组。事实、推断、反证与未决问题分明；程序与回执放附件。借鉴智见报告工艺的清晰主张、证据解释、机制与边界，按论点灵活使用，不套六段章壳。

写作前逐个梳理承重论点的推理链：它回答什么问题；证据的来源、口径与比较基准是什么；证据经过哪一步机制、比较或计算才能支持判断；最强的另一种解释或反例是什么；裁决后还剩什么不确定性；这一节怎样改变总判断或读者决定。正文不必机械列六个标签，但读者必须能顺着文字复原推理链。标题优先表达本节判断，相邻章节交代问题如何递进。不能以数字清单、同义反复或一句“仍待观察”代替中间推导；若推理桥梁缺失，缩窄结论、明确挂账或退回取证，不补造事实。承重争议多写，单纯交代口径的内容可合并，不按章数或字数凑量。

每个分析章在正文中写明一条可视化的真实关系及支持它的源句，让后续每章至少一张点睛图有可审事实。关系可以是同口径比较、可证伪阈值、因果机制的已证与未证环节或不确定性的边界；不为图倒推结论。确无足够证据时补证或重组章节，不能留下只能靠装饰图填补的章节。附件不计。不要在每段正文塞“画什么图”或 skill 调用说明；正文保持面向读者的论证。

正文定稿后另交 figure-plan.json，作为逐章图稿清单：schemaVersion=1、reportSha256 为报告原字节 SHA256、chapters 按实际分析 H2 顺序逐章一项。每项写 chapter、claim（图要传达的真实观点）、relation（核心逻辑关系）、encoding（推荐视觉编码）、decision（读者应怎样理解或决策）、sourceQuote（本章报告原句）、sourceClaimIds（含该原句的台账 claim id 数组）；跨多处证据时加 supportQuotes（报告原句数组）。表达简报的候选仅供参考，最终清单必须随实际材料和章节重写。OUTLINE.md 对每个实际章节写出本次材料带来的新判断、与常见解释的差异、支撑及最强反证，并说明章节递进；这些是审核线索，不是固定正文小标题。独立内容评审一并审图稿清单与逐章论证。

输出 report.md、OUTLINE.md（最终实际结构）、report-source-ledger.json、figure-plan.json。台账 schemaVersion=2，reportSha256 为报告原字节 SHA256；sources 为真实来源数组，claims 为核心判断数组，unresolved 为未决问题数组。来源字段 id/title/accessedAt，加 url；调用数据用 kind=provider_receipt、provider、receipt={path,sha256,callPath,callSha256}，路径相对团队根。claim 包含 id、quote（正文原句）、kind=fact|inference|calculation、sourceIds。含实质数值的判断补 numeric=true、unit、period、caliber。kind=calculation 时，calculation **必须是一个非空字符串**，在同一字符串里写实际输入、公式、结果，例如 `"calculation":"输入 A=2、B=3；公式 A+B；结果 5"`；对象或数组不能通过 Host 校验。来源回执按上面的 receipt 对象填写。不得把未知值设为零或抹去反证。独立评审逐节检查“判断—证据—推理—反例—决策含义”是否可追溯；content-audit 增加 novelty 字段，逐章说明哪些观点因本次证据成立、哪些只是旧话或证据不足；机器格式通过不代表论证或事实正确。

仅执行本阶段。读取 Host 下发的已锁定输入和对应 skill；结束时按 current_action 一次提交声明文件，保留真实错误与未知项。
