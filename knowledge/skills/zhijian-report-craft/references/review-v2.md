# 独立审核的接纳与证据

先核对 Host 交付本角色完整材料的 pack id/digest、task/attempt/session，再接收同一次待审三件套固定版本及可信检查结果。作者的局部脚本 PASS 不是 Host 回执。只给路径、旧会话“已读”或缺必需材料时停止接纳，记录未验证项。

逐个真实分析章审五件套内容是否实质成立；核对来源与事实适用范围、关键计算共同基准、参数和舍入；对照 Markdown 与当前 HTML/PDF，观察 1280/375 截图及必要 PDF 页面。引用文件SHA、页/章/DOM id/ledger calculation id 与自己的判断依据，不复制作者自报结论。

机器检查只覆盖其声明范围，必须把语义/事实/视觉判断与确定性检查分开。每个必需项给 passed/failed/unverified 与依据；存在硬失败或必需 unknown 就不能推荐整合。真实不足生成可操作 finding，沿已有有限修订协议处理；不改作者已发布版本来制造通过。

审核通过只认证这组具体字节。修订后旧审查不能自动延伸到新稿，补审必须覆盖新版本所有适用项。不存在“所有报告都像某历史样例才通过”的风格替代审查。

实际工具入口：先调用 `expert_teams_quality_review` 的 `prepare_only:true` 获取当前 material_receipt、完整 reviewer 材料和机器预检，不能把准备调用当已审核。正常提交须带 `independent_review` 四域，每域为 `{id,status,coverage,evidence:[{artifactId:"published:report.md",quote:"实际MD正文片段",reason:"基于该片段的审阅依据"}]}`；id 分别是 `chapter-substance`、`facts-and-uncertainty`、`calculations-and-coverage`、`visual-and-format`。quote 必须来自当前受审正文，coverage 说明实际覆盖与限制，不是模板套话。每项 acceptance_result 也须写 detail；身份与 task/attempt 按工具返回的正式绑定提交，不代理其他人审核。
