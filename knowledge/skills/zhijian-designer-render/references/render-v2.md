# 渲染执行规范

输入是固定版本 MD、当前 ledger 定义、主样式及 Host 本角色材料。只改变呈现，不添删观点；正文变更回到 MD 单源。把五件套映射到有唯一 id 的语义 section/paragraph/table，供 ledger 精确定位；不要用 CSS 伪元素承载正文或关键数字。

HTML 内联 CSS、使用受控本地字体，不依赖网络、脚本或外链字体。内联选定 palette/base CSS 及组件语义结构，替换全部占位并保留来源和 id 映射；交付正文无需 JS。

正文/说明/标签文字采用安全色；装饰色只给无文字含义的线条和背景。实际计算样式下普通文字对比度≥4.5:1，大字≥3:1；阈值不能四舍五入过线。大字按24 CSS px或约18.67px加粗判断。依据：https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html 。CSS色值存在不等于最终 AA 通过；要测合成背景、继承、字号和实际可见文本。

实际离线浏览器检查 1280/375 两个宽度，保留本版截图、锚点与布局检查证据。不要用 overflow:hidden/clip 把溢出藏掉；表格、长URL和单词应换行/改布局。截图是 Host 产物，不接受作者自报“P0=0”。

PDF从同一内容生成。封面、封底无页码；正文按1/N至N/N编号并含品牌；章节大纲匹配实际章节。拼接封面、加页脚或书签后，解析最终PDF并必要渲染，核对ledger/回执的SHA。页数按实际内容，不套旧例24页。

提交前运行官方七项预检；将 sourceRoot、文件绝对路径、style 与 digest 换成本任务值：

```sh
node "<sourceRoot>/knowledge/skills/zhijian-designer-render/scripts/preflight-report.mjs" --md /abs/report.md --html /abs/report.html --pdf /abs/report.pdf --ledger /abs/craft-evidence.json --style credit-policy --material-pack-id zhijian-report-craft-v2 --material-digest <digest>
```

退出0=七项机器检查通过，1=有失败，2=未验证/缺依赖/输入错误；逐项修复 findings、更新 ledger SHA 后重跑再发布，沿用当前 attempt 和剩余修复预算，不自行重置。CLI只读报告，输出本地诊断，不能作为 Host 收据、独立审核或放行。导出技能副本需使用 sourceRoot 下已安装检查器，不从旧 work 找替代脚本。
