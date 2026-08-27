# 渲染检查记录 · t7 渲染与生成（HTML5 → PDF/PPT → 视频）

项目：南京江北新区「政府+贝壳」合资收储可行性 · 融合研判（正式稿）
渲染节点：Designer（智见点评团队）· 2026-08-24

## 交付物清单（路径 + sha256）

| 交付物 | 路径（相对 artifacts/） | sha256 |
|---|---|---|
| HTML5 视觉稿 | html/report.html | dcfac6aea6646f7b871bdcbb2647b9a07798483f32b7d7f8907e507a9b73dc76 |
| PDF（A4 正式稿） | pdf/南京江北新区合资收储可行性-融合研判.pdf | dbd04f921888b1f7feeb9398085c7f0d17f7ea91dd283e94de7c9b03cfb3fd43 |
| PPTX（可编辑 15 页） | ppt/南京江北新区合资收储可行性-融合研判.pptx | e5d74ce329abde8e8aa83c30f9fd9028b25414d626964ec2060d6fcf2e08881e |
| 短视频（60-90s） | video/南京江北新区合资收储可行性-60s宣传片.mp4 | b5debcd63ba22b7067e505a6521dbd51061357329799dd3923d8ab5a9ae08dc6 |

deck 源工程：ppt/deck/（deck.spec.json + pages/*.json + theme.json + deck.json，可随时改页重渲染）
视频源工程：video/promo/（Remotion，src/zjpromo/ZhiJianPromo.tsx）

## 检查项与结果

### HTML5（finesse-ui product register · 贝壳蓝金）
- [x] 注册表：product（研报/报告页）；craft floor：tinted neutrals（页面 #edf0f6，非纯白）、hairline borders（rgba(20,32,56,.08)）、无纯黑阴影
- [x] 配色：Cobalt 蓝 #2D5BD8 + 金 #B97A1E/#8A5A14，语义色（涨/跌/警示）与品牌色分离；图表系列色无红绿语义冲突（三通道 donut 第三通道用 slate 而非绿色）
- [x] 对比度（计算验证）：正文 ink-3 4.59:1、accent 蓝 5.83:1、金色文字 5.91:1、warn 5.56:1、图表数据色 ≥3:1
- [x] 布局：无横向溢出（hscroll=0）；hero 装饰光晕经 overflow:hidden 裁剪（无实际溢出）
- [x] 图表：4 张 SVG 手绘图表全部由数据驱动（value/max 零基线），x 轴标签齐全，无 barcode 柱
- [x] 动效：仅反馈性 reveal + prefers-reduced-motion 回退；打印/PDF 静帧

### PDF（weasyprint 69，A4）
- [x] 11 页 A4；页脚「98wiki ｜ 智见 / 行业研究报告 · 第 N 页 / 共 11 页」逐页存在（fitz 文本断言通过）
- [x] 图表颜色渲染验证（像素采样：蓝/金/红/slate 色值齐备）；SVG fill/stroke 已从 CSS 属性改为演示属性（weasyprint 兼容）
- [x] 预期告警仅剩：box-shadow 不支持（打印无阴影，hairline 分隔）、text-wrap:balance、overflow-x:auto、prefers-reduced-motion —— 均为无害

### PPTX（pptfast 0.20.0，自定义 theme「beike-bluegold」）
- [x] 15 页（cover + 13 content + ending），narrative boardroom-report（pyramid/spacious/executive）
- [x] validate OK（0 error，0 warning 于最终版）
- [x] audit：0 findings（溢出/越界/低对比/截断/丢失全部清零；从 63 项修复至 0）
- [x] 数字带口径（Wind/政研通标注），预测标注【测算】【估算】；演讲者备注已写（每页 notes）
- [x] 预览已通过 pptfast_preview 呈现在对话（audit clean）

### 视频（Remotion 4.0.484，可选增强）
- [x] 11 张页面分区截图（1440×900，全部唯一）
- [x] 组合：1280×720 @24fps ≈65s；2.5D 运镜（scale 1.02→1.14 + 方向性漂移）、14f 交叉淡化、字幕卡（金/藏蓝品牌色）、音效设计（riser-cine 片头 / transition-soft 转场 / impact-cine 片尾）
- [x] 帧验证：frame 100/700/1500 色彩与构图采样通过
- [x] 全片渲染完成：65.2s、1280×720 @24fps、h264+aac、37.0MB；成片抽帧 2s/25s/61s 三帧内容/色彩验证通过（片头藏蓝标题卡、中部报告内容、片尾致谢卡）

## 待用户确认事项（渲染节点不是终点）
1. 是否精修视频（换镜头节奏、加音乐轨、加字幕动效细节）
2. 是否调整 PPT（增删页、改文案、换布局）
3. 是否转正式稿最终版（确认后即可定稿交付）
