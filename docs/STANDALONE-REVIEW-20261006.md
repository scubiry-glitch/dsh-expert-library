# Expert Teams 独立审阅页

## 用户流程

1. 已登录 DSH 的用户在 Expert Teams 活动面板点击「独立页」直接打开，或点击「复制访问链接」发给需要在其他浏览器查看的人。链接是一次性的，应只交给被授权的审阅人。
2. Host 为当前计划或团队签发 24 小时有效的一次性访问令牌，并在新窗口的 URL fragment 中传递。独立页立即清除 fragment，将令牌兑换为只属于该窗口目标的 HttpOnly Cookie；刷新页面时使用 URL 中的非秘密 `access` ID 找回对应 Cookie。
3. 独立页每 2 秒读取一次持久化团队状态，展示计划 DAG、专家和模型、Skill/固定 Prompt、大纲、待确认稿件、任务与质量审核状态。
4. 页面只允许以当前 digest/revision 确认计划，或以源稿 SHA256 在大纲/正文节点选择已有选项。确认回执记为 `scoped-review-token`，并记录令牌 ID。退出会撤销该令牌。

## 权限边界

- 签发和批量撤销须通过 DSH 原生浏览器身份校验与同源检查；独立页本身可免 DSH 登录。
- 一次性链接仅用于兑换。磁盘只保存令牌摘要，访问令牌不放在 HTTP 路径、查询参数或审计回执中。
- 每个访问 ID 使用独立 Cookie，因此同时打开两个团队不会互相覆盖。
- 独立页 API 不提供编辑计划、切换模型、暂停/恢复/归档团队等管理动作。
- 审批继续走现有 Host CAS、计划检查和稿件哈希检查。令牌到期或撤销后不可再次读取或确认。

## 上线与验证

代码入口：`src/host/review-routes.ts`、`src/host/review-access.ts`、`assets/review/`，活动面板入口在 `src/client/ActivityPanel.tsx`。`package.json` 已包含 `assets` 打包目录。

已运行：`npm run typecheck`；`node --experimental-strip-types --test test/review-access.test.mjs test/review-routes.test.mjs`（5 项）；`node --check assets/review/review.js`。服务端、客户端 TypeScript 和客户端 bundle 另在 `/tmp/dsh-review-candidate/` 独立构建通过，bundle 内含独立页按钮和签发接口地址。真实试点持久化数据可由当前 `teamToWire` 和 `planToWire` 解析。

运行中的 dsh web 进程在本次源码修改前启动。需要构建并重启 dsh web，路由和活动面板按钮才会生效。重启前应先处理或明确保留正在等待质量处理的真实试点会话，并记录服务与团队状态；不要将源码通过更换客户端 bundle 的方式单独热推到旧 Host。

## 2026-10-06 确认链接与页面调整

- 新增 `reviewPublicOrigin` 设置，本机 profile 配置为 `https://yy.meizu.life`。计划 stage/approve、场景与协作预设等待确认时返回 `review_url`；团队状态在大纲/正文源任务完成后返回 `confirmation_links`。Agent 使用策略要求在回复用户时附上这些链接。
- 链接包含 captain、plan/team、gate、task 等非秘密定位字段。打开后用浏览器已登录的 Host 身份签发并兑换 scoped review 会话；没有登录态时页面说明登录或一次性链接入口。模型工具的输出不包含审批令牌。
- 工作区计划和稿件确认区同时展示独立页链接。独立页支持按 gate/task 定位。
- 独立页改为侧边导航、研究摘要、章节卡片、专家模型卡片和按依赖层次排列的节点；材料详情按需展开，刷新保留展开状态；桌面和手机布局均检查。
- 本轮验证：7 项链接/令牌/路由测试通过；浏览器模拟数据验证深链登录、计划版本确认、大纲源稿 SHA256 绑定、刷新保留展开节点、390px 无横向溢出、无浏览器脚本异常。预览图在 `docs/previews/review-20261006/`，为明确标注的示例数据，不是真实试点成果。
- 变更仍待与服务端一并构建部署；本轮未重启运行中的 DSH 服务。

## 线上部署回执 · 2026-10-06 17:00（UTC+8）

- 用户明确授权部署并重启。`npm run build` 成功（craft、服务端/客户端 TS、report-domain 检查、tsdown），7 项回归测试通过。
- `dsh-web.service` 已重启，MainPID=1123159，active/running。Nginx 配置检查通过；systemd reload 因既有 PrivateTmp 目录丢失失败，随后 `nginx -s reload` 成功。
- 本机 auth-gate 为独立审阅页及 exchange/state/action/logout 的精确路径委托给插件自身的 scoped token 鉴权；issue/revoke 仍受工作区登录与 Host 身份验证保护。Nginx 对该入口保留真实 Host/Origin。部署补丁保存在 `docs/deployment/`；升级 auth-gate 时须保留或正式迁移这项集成。
- 公网页面 200；无令牌状态 API 401；未登录签发 API 401。公网 JS/CSS SHA256 与当前 assets 一致。
- 对真实「98wiki 上海与一线租赁市场见底研判 v3.1（材料绑定修正版）」进行只读浏览器验收：18 个计划节点、18 个任务可见，无脚本异常；Secure/HttpOnly Cookie、一次性令牌重放拒绝、撤销后 401 均通过。测试令牌已撤销；未执行用户审批或修改团队任务。
- 回滚材料：`/root/zhijian/deploy-backups/review-20261006/`，包括旧 lib、旧认证网关与 Nginx 配置、重启前团队状态。

## 大纲确认显示核验与自动展开修复

- 对线上真实 t5 用户确认大纲方向进行浏览器只读核验：t4 源稿 completed、quality integrated；t5 为 pending，无选择回执。全文与 A/B/C/A+C 四个启用按钮确实可见，截图 `docs/previews/review-20261006/live-outline.png`。
- 修复工作区外层 ActivityPanel 已收起时，新用户确认门不能自动打开的问题：按 session/team/task/source SHA256 识别首次出现的待确认项并展开面板；同一版本被用户手动关闭后，轮询不会重复弹出。新计划也按 plan digest 提示。
- 客户端 TypeScript 与 tsdown 构建通过，已重启服务加载新版。未点击真实大纲选项。

## 移动端审阅页调整
- 待审批事项独立置顶；计划与设置、大纲、团队状态采用互斥 Tab，切换状态在轮询后保持。
- 大纲正文按标题和段落安全渲染，确认按钮适配触屏；确认摘要收纳到详情。
- 团队状态采用队长、进度条、成员派工树与成员名下任务的展示顺序，成员可折叠。
- 公网真实团队只读浏览器检查：320/390/768/1440 宽度无横向溢出，三个 Tab 正常，18 项任务完整显示，浏览器无脚本异常。测试令牌已撤销，未执行真实审批。
- 模拟计划审批与大纲选择测试通过，版本及源稿 SHA 绑定保持。
- 修改为服务即时读取的 assets/review 静态文件，公网已生效，无需重启。旧文件备份在 /root/zhijian/deploy-backups/review-mobile-20261006/。

## 羊皮纸专家协作室与交付阅读
- 暖羊皮纸、墨色文字、黄铜色标签；沿用原面板 PNG 鲸鱼队长/专家及工作、思考、交付动作，以真实任务状态派生台词与完成数量。
- 设置说明区明确计划是否可确认、大纲可选择条件、专家/模型/Skill/子 DAG 本页只读与工作区修改入口说明。未将运行中冻结配置伪装成可编辑表单。
- 完成任务列出最新同名发布产出，支持页内正文阅读、PDF/图片预览和原件下载；大纲确认记录可回看源稿。
- 新 review-documents 模块只在当前 token 绑定的 captain/team 下定位完成任务与发布清单，复用路径/符号链接约束和 SHA 校验；文件上限 8 MiB。没有开放任意路径读取。
- TypeScript 构建、5 项 token/route 测试、文档越权/内容篡改测试及模拟审批测试通过。公网真实团队已验证 320/390/768/1440 无溢出、角色图片加载、完成任务文档弹窗阅读。测试未代替真实用户审批。
- dsh-web.service 已重启加载后端（PID 1146782），线上返回 200。图片与 UI 后续修正即时读取生效。

## 智见科技角色资源
- 用 built-in image_gen 生成统一的暖白陶瓷机器人、蓝色电子眼、金属金边与蓝围巾，共 8 角色和 6 动作；以队长原图作为所有变体的一致性参照。
- 运行时 PNG 与 SVG 位于 assets/expert-teams，原图和逐项 pose/提示模板位于 output/imagegen/zhijian/manifest.json；旧资源备份在 /root/zhijian/deploy-backups/zhijian-art-20261006/。
- generate-artwork.mjs 改为从已生成原图打包透明 256px 资源，并更新独立页内嵌图表，不再重新生成鲸鱼。
- 工作区活动面板与会话卡片更新为完整透明形象展示，资源 URL 增加 zhijian-20261006 版本；独立页去掉旧图的褐色滤镜，保留电子眼原色，动作动画尊重减少动态效果设置。
- 服务端/客户端 TypeScript 与客户端打包通过。14 张角色/动作联系表位于 docs/previews/zhijian-art-20261006/gallery.png。
- 上线验证：dsh-web.service PID 1157774，公网 200；真实团队在 320/390/768/1440 宽度下通过，机器人图像全部加载，产出阅读正常，无脚本异常。临时测试访问已撤销，未提交审批。

## 普通链接认证恢复与未授权轮询修复
- 未授权时停止 state 轮询；过期/撤销导致 401 后清除当前访问标识并停止请求。
- 一次性令牌兑换成功后，仅在 localStorage 记录非秘密的 grant ID 与目标标识；实际权限仍由 HttpOnly Cookie 和服务端记录校验。普通链接按 captain/team/plan 匹配恢复，读取后再次核对目标。
- 令牌交换保留原定位参数，支持 hashchange 场景；初始认证期间禁止轮询，防止恢复尚未校验时渲染错误目标。
- 公网浏览器回归通过：无授权链接只有一次 issue 尝试、零 state 轮询；首次兑换后普通链接恢复成功；计划 Tab 保持；其他团队不展示；撤销后停止轮询；存储无 bearer token。临时测试授权已撤销。
- Cloudflare analytics CSP 日志与认证失败独立，未放宽 script-src 来加载第三方统计代码。

## Immersive studio edition

Following the user's reference https://raw.renos.life/v2/diary/, inspected the live desktop/mobile experience and the local couple-game implementation. Reworked the standalone review page with large editorial serif typography, warm paper, layered research sheets, drifting light and a floating Zhijian captain. Replaced nested visual borders with open spacing and an olive pending-decision band. Preserved all three tabs, actual team state and output previews. Added motion toggle, reduced-motion handling, visibility pause, restrained overshoot transitions; direct gate links still focus the relevant task. Static assets served from disk, live without service restart.

Verified public deployment with temporary scoped access (revoked after each test): 320/390/768/1440 widths, one visible tab, no horizontal overflow, 18 tasks and 18 plan nodes, decoded character images, real completed document preview, token replay/revocation rejection, no browser JS errors. Verified motion toggle and reduced-motion state. Auth regression passed: unauthenticated links stop polling, existing grant restores ordinary links, wrong team denied, no bearer tokens stored in localStorage. No real approval or task mutation performed.

Screenshots: docs/previews/review-studio-20261006/. Backup: /root/zhijian/deploy-backups/review-immersive-20261006/.

## Adult hand-drawn expert art direction

User clarified that avatars must reflect professional expert personas: adult humans, not robots, animals or children. Discarded the puppy direction before deployment. New assets use distinct adult faces, hairstyles, attire and professional props, with warm editorial cartoon linework matching the paper interface. Roles cover director, urban researcher, engineer, designer, quality expert, senior reviewer, data analyst and editor; six status images use professional work gestures and desk objects. Role mapping distinguishes index/data researchers and critical reviewers. Hero motion restrained to subtle movement. Image generation uses built-in image_gen; final prompts and original paths belong in output/imagegen/zhijian-experts/manifest.json. Runtime images live in assets/expert-teams and the standalone embedded artwork table. Previous art backed up under /root/zhijian/deploy-backups/review-handdrawn-20261006/.

Adult expert deployment verified: TypeScript server/client compilation and tsdown passed. Live service returned HTTP 200 after reload. Public-page browser test passed at 320/390/768/1440 widths, with motion toggle/reduced motion, 18 tasks/18 plan nodes, decoded portraits, real completed-document preview, token replay rejection and scoped-grant revocation. No browser JS errors or real approval mutations. Contact sheet and live captures: docs/previews/zhijian-experts-20261006/.

## Diary book interaction reference

Read the reference diary's timeletter.js and app/web/v2/art-scenes.js: spine-based cover opening, overlapping leaf delays, anticipation, overshoot and settling. Added a keyboard/touch operable research book (aria-expanded), sequenced cover/leaf CSS3D motion, staggered hero entrance, damped mouse-only parallax, decorative leaf turn on actual tab changes, paper-unfold document dialog, and a success stamp shown only after the action API succeeds. Preserved gate deep links, SHA/revision binding and authoritative server state. Motion toggle/reduced-motion and hidden-tab cleanup remain supported; decorative layers cannot intercept controls. Static assets live without restart.

Public browser check passed for book click and Enter toggle, reduced-motion instant transitions, 320/390/768/1440 layouts, tab visibility, actual 18-task team and completed document preview, token replay and revocation. Mock approval check preserved version/digest bindings. No actual approval or task mutation made during verification.

## Collaborative expert scene, explicit live states and full Markdown

Replaced the book cover with a shared expert desk using actual team names and role artwork, material-sorting animation, paper handoff and discussion cues. Scene labels state this is a collaboration illustration; the live count derives from task status. Team members classify as working, blocked, ready, waiting on dependencies, idle or done. Working members animate their work badge and status dot; completed tasks are collapsed into a per-member archive; completed members default collapsed. User disclosure choices persist through state renders. Status ordering puts active/blocked work first.

Replaced line-by-line Markdown approximation with vendored marked 18.1.0 and DOMPurify 3.4.16 (sources/licenses in assets/review/vendor). GFM lists/tables/fenced code, inline formatting, quotes, headings, document navigation and safe outbound links render in the artifact dialog and outline text. Raw executable HTML, remote image embeds and unsafe link protocols are excluded. Tables/code scroll within the document on mobile.

Verified live 320/390/768/1440 layouts, 18 task rows/18 plan nodes, completed document access, role state classification and Markdown structures. Verified script/img/event-handler/javascript-link removal. Mock plan approval preserves revision/digest; real test grants revoked, no production task/approval mutations. Static assets live immediately; no service restart needed.

## 团队状态研究路线 DAG · 2026-10-06

- 团队进度下方新增真实任务依赖图，沿用活动面板的分层布局、上下游高亮、点击固定详情及 Esc 取消；纸色画布、橄榄绿状态与衬线标题延续封面风格。
- 显示完成、执行、待人工确认、受阻与待开始状态，详情列出负责人、前置与后续任务；轮询重绘保留选中任务与画布滚动位置。空任务、并行任务、缺失依赖与循环依赖有容错展示。
- 线上只读浏览器验收：18 节点、33 依赖与真实任务一致；320/390/768/1440 宽度无页面溢出；固定详情、依赖高亮、刷新保留与复位通过；无脚本异常。临时测试授权已撤销，未提交审批或修改任务。
- JS 语法检查通过。修改仅涉及即时读取的 review.js/review.css，已在线生效，无需重启。截图在 docs/previews/review-dag-20261006/；修改前备份在 /root/zhijian/deploy-backups/review-dag-20261006/。

## 研究路线角色动画 · 2026-10-06

- DAG 每个任务使用与封面一致的负责人角色，加入书桌、纸张、笔和状态气泡；人物按真实任务状态呈现工作、候场、交付、待确认和受阻动作。
- 动作采用预备动作、弧线、弹性伸缩、越位回弹与道具跟随：工作时俯身写画与整理纸张，交付后点头轻跃，点击角色时蓄力跃起再落稳。仅已完成上游到正在执行下游的依赖线显示纸张接力。
- 与全页动效开关、减少动态效果设置及后台暂停共用控制；IntersectionObserver 暂停离屏角色。修复重绘后旧画布 scroll 事件覆盖已保存位置的竞态。
- 线上只读验收通过：18 个角色图片全部解码；18 节点、33 依赖；320/390/768/1440 无页面溢出；执行角色实际变换、点击动作、动效关闭与 reduced-motion 停止动画；选择及滚动位置保持；空图/并行/缺失/循环依赖容错；无浏览器脚本异常。临时访问撤销，未进行真实审批。
- 静态资源即时生效，无服务重启。截图：docs/previews/review-dag-actors-20261006/；回滚备份：/root/zhijian/deploy-backups/review-dag-actors-20261006/。

## 分享码免密入口 · 2026-10-06

- 分享码复用现有 scoped 一次性 `rvl_…` token，不新增短 PIN 或改变权限。有效期 24 小时，仅可兑换一次，兑换后依赖当前浏览器 HttpOnly Cookie；`access=` 只是记录编号，不能单独授权。
- 推荐格式：`/plugins/dsh-expert-library/review#share=<分享码>`。兼容旧 `#<token>`、fragment 的 `token`/`code` 参数，以及 query 的 `share`/`token`/`code` 参数。已有定位参数后直接追加 `#share=…` 即可。
- URL 分享码自动填入并验证，脚本初始化即清除地址栏的秘密参数；登录框也支持粘贴同站审阅页完整免密链接。query 参数兼容第三方拼接，但建议使用 fragment，避免页面请求 URL 包含凭据。
- 兑换后核对目标；格式错误、失效与目标不匹配时隐藏任务数据并停止轮询。完整分享码不写入 localStorage。
- 浏览器模拟回归 11 种入口/异常场景通过：旧 token、三种 fragment、三种 query、粘贴链接、格式错误、失效与目标不匹配。静态 JS 语法检查通过，公网资源与源码哈希一致。

## 连接停滞与重复打开处理 · 2026-10-06

- 用户报告停在初始连接文字；线上新授权首次打开成功，未复现用户具体浏览器的停滞。已确认此前发出的授权曾兑换成功，未过期/撤销。
- 同一浏览器再次打开原一次性链接时，先凭 HttpOnly Cookie 恢复对应授权，再在无授权时兑换；编号本身仍不能授权，跨浏览器不能重放已兑换令牌。
- API 增加 15 秒超时，初始化增加异常提示；History API 受限不再中断启动。认证放到所有界面状态初始化完成后启动。HTML 提供脚本未启动的静态说明，并更新 JS 版本参数。
- 线上首次打开与原链接重复打开通过，临时测试授权已撤销；11 项分享入口回归通过。此次没有认定用户端停滞根因，浏览器类型待用户反馈。

## 启动兼容性隔离 · 2026-10-06

- 用户反馈静态 bootHelp 持续可见，表明脚本未完成初始化；这不能单独确定是资源请求失败、解析失败还是运行时异常。
- 应用包改为独立作用域，避免内置浏览器注入同名全局变量冲突；Markdown/净化库初始化隔离，失败时正文降级为纯文本，仍不直接插入未经净化 HTML。
- matchMedia 使用旧 addListener 回退；getAnimations、IntersectionObserver 缺失时降级。初始化异常显示错误类型及简短消息，脚本开始执行即更新状态。
- 公网临时授权首次/重复打开通过，11 项分享回归通过。用户实际浏览器和错误根因仍待反馈，未将模拟兼容性测试视为用户现场复现。

## 手机研究路线缩放与逐项导航 · 2026-10-06

- DAG 新增全图适配、放大、缩小、原大小、当前任务、任务选择及上一项/下一项。移动端默认全图；选择任务后恢复可读比例并定位节点。画布支持双指缩放、单指原生滚动，缩放状态随轮询保留。
- 使用独立缩放容器，控制栏与任务详情保持正常字号；ResizeObserver 在 tab 显示及屏幕变化时重新适配全图。
- 公网只读验证：320/390/768/1440 全图横向完整、页面不溢出；缩放比例变化、任务选择及前后导航正常；登录和临时授权撤销通过，无脚本异常。截图见 docs/previews/review-dag-zoom-20261006/。双指手势已实现，尚未在真实华为/微信设备上验收。

## 待确认计划下拉编辑 · 2026-10-06

- 独立页在服务端 `canEditPlan` 为真时开放编辑：模型、已注册子 DAG/专家和任务材料 recipe 使用下拉选择。仅 staged、无团队、未归档且 token 绑定对应 plan 的情况开放；已启动团队保持锁定。
- 新增 scoped edit 分支，仅允许 plan_models / research_selection / research_material_selection。读取和修改以 token 的 captain/plan 为准，不使用请求体中的目标；校验 digest/revision 后复用 Host scenarioEditCore 校验、重编译和持久化。模型目录沿既有 state API 按需读取，只返回 provider/model/name/reasoningEffort。
- 未保存选择不被轮询覆盖，禁止带未保存修改确认执行。版本变化保留本地草稿、禁用提交，须明确载入新版。修改图/专家、模型、材料分组保存，避免重编译后引用旧任务。compiled_source 预设已冻结的路线和材料仍禁用；队长模型仍需与工作区会话模型一致。
- TS 检查、JS 语法与 39 项相关路由/令牌/模型授权/图选择/计划状态回归通过。浏览器模拟模型、图、专家、Skill 保存，新修订显示、未保存保护、并发冲突、锁定及 320/390/1440 无溢出通过。
- 仅定向编译 review-routes 模块，并将模型目录回调同步接入源码及现有 lib/index.js，未全量覆盖其他在途构建。备份 /root/zhijian/deploy-backups/review-edit-20261006/；dsh-web 服务重启后公网 200。
- 线上真实 staged 计划只读验收：下拉选项可用，Host 模型目录返回 28 项，无 JS 异常；真实计划 digest/revision 未改变，临时测试 token 已撤销。保存行为在隔离测试中验证，未替用户修改或批准真实研究计划。截图 docs/previews/review-plan-edit-20261006/。

## 分享码兑换上限 10 次 · 2026-10-06

- 按用户要求，新签发分享码默认允许 10 次独立浏览器兑换，24 小时有效期保持不变。同一已授权浏览器通过现有 cookie 恢复不会重新兑换。
- 每次兑换生成独立随机 HttpOnly 会话；服务端保留最多 10 个 cookie 哈希，后续兑换不会使先前会话失效。跨进程锁内检查次数，达到上限后移除 linkDigest。旧版记录继续按原单次规则验证，既有 cookie 兼容。
- 撤销分享码仍会撤销其所有浏览器访问；退出确认文案明确这一范围。页面提示已同步更新。
- 7 项令牌/路由测试及 TS 检查通过；15 次并发请求仅 10 次成功。线上临时码实测前 10 次成功、第 11 次 401、第一和第十个 cookie 均仍可读取原团队；临时码已撤销。定向编译 review-access 模块并重启服务，备份在 /root/zhijian/deploy-backups/review-share10-20261006/。

## 封面研究题目与实时专家优先级 · 2026-10-06

- 封面主标题使用实际研究名称，移除仅用于展示的 98wiki/99wiki 前缀和末尾版本标识；完整名称仍保留在 overview 与标题提示中。替换原宣传口号，副标题展示真实工作人数及完成进度。
- 封面不再固定取成员前三位；优先工作中、待接手、等待前置、受阻。有未完成工作的成员时，仅展示这些成员，不以已完成者补足三位。全部完成时仍可展示完成成员。双人/单人布局居中。
- 公网只读检查：标题为“上海与一线租赁市场见底研判”；封面实际为巧手·阿妙（working）、毒舌·尖尖（waiting）；320/390/768/1440 无横向溢出、无 JS 异常。临时测试访问已撤销；静态资源即时生效，无需重启。

## 免密链接直接进入 · 2026-10-06

- 登录表单在初始 HTML 中隐藏，带分享码时后台验证，不再显示填码过程；同一浏览器的 access 链接通过现有 cookie 直接恢复。无授权、无分享码或验证失败才显示表单。加载和无脚本提示置于表单之外。
- 分享码不再写入输入框；手动提交有效码后也进入后台验证状态。权限校验与兑换次数规则保持原有逻辑。
- JS 语法检查及 12 种浏览器场景通过（链接别名、cookie 恢复、手动输入、无效/过期/目标不匹配）。公网临时分享码首次进入及 access 链接刷新均通过 MutationObserver 确认全程未显示登录表单，无页面异常；临时访问已撤销。静态资源即时生效，备份 /root/zhijian/deploy-backups/review-direct-entry-20261006/。

## 活动面板独立页与复制访问链接修复 · 2026-10-06

- 公网已登录浏览器复现：`/review/api/issue` 返回 `401 REVIEW_HOST_AUTH_REQUIRED`。普通工作区由 nginx 改写 Host 为 loopback，原 review 前缀保留公网 Host，导致原生签名 cookie 的 authority 不匹配。
- `/etc/nginx/conf.d/yy.meizu.life.conf` 对 issue/revoke 增加 exact location，与工作区使用相同的 loopback Host；map 仅将同域 HTTPS Origin 转成对应 loopback Origin，其他 Origin 原样保留并被应用拒绝。其余 scoped review 路由继续使用公网 Host 与独立 cookie。未开放匿名签发权限。
- 活动面板请求增加 15 秒超时和可读登录失效提示，统一生成 `#share=` 链接。弹窗被拦截时改为当前页打开；剪贴板失败时显示可选择、长按复制的对话框和直接打开入口。清除旧的一次性文案，明确 24 小时、10 浏览器兑换。
- client TypeScript 检查通过，定向转译 ActivityPanel/TeamPlanPanel 后重打 client bundle，重启 dsh-web 使模块快照更新。公网实际加载的资源已确认包含新代码。
- 使用临时测试账户与独立测试分享码，对实际按钮处理函数做公网浏览器验证：打开独立窗口、复制成功、剪贴板拒绝后的手动复制、新无工作区登录浏览器打开链接、弹窗被拦截后当前页打开全部通过；无登录为 401，异域/跨站/null Origin 为 403。临时账户、会话和分享授权均已清理，未消耗用户的分享码。
- nginx 配置检查通过。systemctl reload 因既有 PrivateTmp 命名空间错误失败，改用 nginx -s reload 成功平滑加载；未重启 nginx。备份 /root/zhijian/deploy-backups/review-buttons-20261006/。

## 手机首屏、当前路线与集中成果 · 2026-10-06

- 保留封面人物、动画和暖色；压缩手机标题/人物布局，研究完整说明与概况折叠，移除人物下方重复进度，四个 Tab 吸顶。390px 公网实测 Tab 起点由约 1241px 降到 550px。
- 没有计划/大纲待确认时隐藏整个待办区；有真实待办仍显示计数和入口。封面按钮随待办切换为“查看待确认事项”或“查看当前进展”，不再滚动到空区。
- DAG 初次展示默认以可读大小定位执行中/待确认/受阻任务；保留全图、缩放、双指操作及逐项导航。隐藏 Tab 首次展开和无 ResizeObserver 的浏览器也能定位；更新时保留缩放、滚动与任务选择框。
- 新增“研究成果”Tab，复用 scoped 文档预览/下载。报告、大纲优先，研究附件与交付说明折叠；同任务同名文件以真实发布时刻排序，默认最近一版，其他版本可展开。服务端列表补充 createdAt；不将任务进度时间当作附件发布时间。
- 修改四 Tab 的键盘导航与定位间距。成果版本及附件展开状态在轮询后保留。
- 回归：JS 语法、Host TypeScript、文档 scope/hash/发布时间测试通过；浏览器覆盖含章节与专家的计划、隐藏 Tab、无 ResizeObserver、当前任务可见性、轮询选择保留、四 Tab 键盘、版本合并/展开、真实待办出现和消失、320/390/768/1440 无溢出。
- 公网临时授权已验证免密进入、真实研究数据、集中成果、文件读取与预览、四种宽度；已撤销测试授权。检查发现成果折叠片段曾误进入计划渲染，已移除并以含章节/专家的计划加入回归，最终公网通过。
- 静态资源直接生效；定向编译 review-documents 后重启 dsh-web 加载发布时间字段。备份 /root/zhijian/deploy-backups/review-mobile-focus-20261006/。

## 成果去重与面向读者的任务表达 · 2026-10-06

- 团队状态页取消专家下方重复的文件/已完成任务长列表和确认任务副本，文件集中在“研究成果”；路线保留任务状态、前后关系和输入阻塞，成员收为默认折叠的“团队分工”。质量检查记录也默认折叠。
- 明确同一团队的三种视角：封面展示当前参与协作的专家，路线人物是任务负责人，分工表为全体成员。点击封面人物或分工表中的当前任务可定位到路线；技术模型信息折叠。
- 前后关系、计划任务、大纲卡片、路线节点和任务选择器使用任务名称，显示层不再展示 t 编号；writer/content_review 等角色转为中文，原始 ID、任务标题、模型配置保留在技术详情，API 入参仍使用原始 ID。
- INPUT_ARTIFACT_BLOCKED + SKILL_CRAFT_PATH + __pycache__ 显示为缓存目录导致输入检查未通过及处理方向，原始报错仍可展开。仅优化展示，不改任务真实状态或自动处理缓存。
- 计划的材料哈希、流程配置和版本摘要放进技术详情；保留现有审批 CAS。界面标题与设置标签中文化，报告生成任务不再显示“正在梳理材料”。
- JS 语法、浏览器回归通过：真实报错中文化且原文折叠、任务代号默认不可见、无重复文件区、分工表定位、计划下拉编辑/保存与并发保护、版本展开与轮询保留。公网真实研究页和成果预览通过，320/390/768/1440 无溢出，测试访问已撤销。静态资源直接生效，无服务重启。备份 /root/zhijian/deploy-backups/review-plain-language-20261006/。


## 四阶段进展与唯一正式成果 · 2026-10-06

- 四个 Tab 调整为研究计划、研究大纲、团队进展、研究成果，各有自动完成标记（✓ / ○）和总体阶段计数。分别按计划确认、选纲确认且定稿任务完成、全部任务完成、正式报告可交付判断；重新打开任务后相应完成标记撤回。
- 初步章节结构从计划移到大纲；已发布定稿时读取 scoped OUTLINE.md 展示真实大纲，已确认候选不重复铺开。尚未发布定稿时不能仅凭方向确认打勾。正文待确认入口移到成果页并默认折叠，保留待办跳转与原 taskId/expectedSha256 审批校验。
- 成果只展示一个最终正式报告入口，优先 PDF，其次 HTML / Markdown。服务端 formal 标记要求全任务完成、finalqa 完成、renderer 当前 attempt 发布的 report.pdf/html/md；过程稿、历史版本、说明文件不列出，也不删除底层文件。未满足条件显示正式报告尚未交付。
- 模型、计划确认记录、原始任务信息等集中为默认折叠的技术记录；大纲附带的校验码与鉴权回执也折叠保留。保留正文中的研究证据和方法说明。
- 验证：JS 语法、Host TypeScript、文档 scope/hash 和当前 attempt 正式发布测试通过；浏览器覆盖四阶段推进/撤回、大纲读取、正文确认跳转及 CAS、过程版本隐藏、唯一正式入口、技术信息折叠、四种宽度。
- 公网临时分享链接自动兑换、真实大纲读取及 320/390/768/1440 无横向溢出通过，无页面脚本异常；测试授权已撤销。当前研究实际显示前两阶段完成（2/4），最后两阶段待完成，不冒充已正式交付。浏览器自动化不等同于真实华为/微信设备验收。
- 仅定向编译 review-documents 模块，重启 dsh-web 加载 formal 字段；静态资源直接生效。备份 /root/zhijian/deploy-backups/review-stages-20261006/。


## 关键稿件按类保留定稿 · 2026-10-06

- 按用户澄清，将“只保留一个最终版”修正为“每类关键稿件各保留最终一版”：最终报告之外，成果区恢复已确认正文、研究底稿汇编、研究大纲三个入口；同类历史版本、候选稿及技术记录仍隐藏。
- 服务端 resultKind 只标记已完成任务的当前 attempt 稿件：outline_final 的 OUTLINE.md（选纲已完成）、evidence_merge / writer 的 research-evidence.md，以及正文确认门绑定来源的 report.md。存在确认回执时校验 publication ID 和 SHA，避免较新的未确认正文覆盖确认稿。
- 各类按发布时间选一份；底稿/大纲可在最终报告交付前查阅，成果阶段勾选继续由最终报告正式交付决定。大纲页与成果入口读取同一发布文件，不复制正文。
- JS 语法、TypeScript、3 项文档测试和浏览器回归通过，覆盖旧 attempt 排除、确认稿精确选择、重新打开任务、分类去重、稿件阅读及手机宽度。定向编译 review-documents，备份 /root/zhijian/deploy-backups/review-key-documents-20261006/。
- 重启后公网实测通过：临时分享码自动进入，成果区三个定稿入口均可读取/下载，未显示旧版本，当前仍为 2/4 阶段；四种宽度无页面溢出，无脚本异常，测试访问已撤销。截图 /tmp/review-key-documents-results.png。

## 手机布局与当前专家定位 · 2026-10-07

- 关键稿件由大卡片改成三行紧凑列表（名称、定稿状态、查看），正式报告保留顶部重点入口并增加直接下载；尚未交付时显示单行状态提示。下载沿用 scoped 文档读取与哈希校验，不产生公开文件地址。
- 切换 Tab（含键盘导航）定位到内容顶部，按动效偏好滚动；短内容栏目设置视口最小高度，保证不会因页面底部限制而停在封面。四阶段吸顶导航保持。
- 定稿大纲按章节折叠，摘要取实际研究问题/结论或小节标题，不改写原稿；研究范围说明及技术校验继续折叠。章节展开状态在轮询重渲染时保留，候选审批和正文审批流程未变。
- 手机首次进入团队进展默认任务列表，按当前进行、接下来、已完成分组，完成项默认收起；可切换人物路线，点击列表任务直达对应人物节点，手动视图选择在轮询后保留。
- “查看当前进展”每次重新选择当前执行任务（其次待确认/受阻/未完成），切到人物路线，在画布中居中该节点，再将画布滚动到屏幕中部，避免只跳到栏目开头或停留在以前选中的任务。封面人物与分工表复用相同定位逻辑。
- 计划负责专家的 index / stock / tier / critic 分别显示指数与量价分析专家、存量挂牌与反方研究专家、城市能级与一线对照专家、独立评审专家。具体职责保留，内部配置代号不变。
- 检查：JS 语法、计划编辑原回归、四阶段/成果回归，以及新增手机默认列表、当前节点居中、重复定位、列表跳图、中文职责、大纲折叠/轮询保留、短栏目定位、紧凑列表、报告下载、320/390/768/1440 宽度验证通过。公网临时分享链接进入、实际专家定位、章节折叠、三份定稿读取、中文计划职责已通过，无脚本异常；临时授权已撤销。实际微信/华为浏览器手势未在真机验收。
- 本次仅更新静态 review 资源，无 Host 重启。备份 /root/zhijian/deploy-backups/review-layout-20261007/；截图 /tmp/review-layout-current.png、/tmp/review-layout-outline.png、/tmp/review-layout-results.png。

## 专家协作加载场景 · 2026-10-07

- 加载页沿用封面暖色纸面与现有专家人物素材，三位专家围桌研读、推演、核对；CSS 提供人物轻微动作、书写、传递纸张及思考提示。场景明确为协作示意，不冒充任务实时状态。
- 人物素材随 HTML 内嵌，场景动效不依赖主 JS 初始化、外部图片服务或动画库；不设置最低展示时长，真实数据就绪即隐藏。沿用关闭动效、后台暂停及 prefers-reduced-motion。
- 连接状态同步显示；8 秒后提供慢连接帮助及重新加载。重载保留原 scoped 分享入口，仍由现有 HttpOnly cookie/兑换校验授权，不存储分享凭据。登录失败、无授权及退出状态隐藏加载场景，保留表单和错误提示；初始化异常的诊断帮助移到可见位置。
- 验证：JS 语法、12 种免密入口/失败回归、加载专项通过。专项覆盖主脚本未就绪时显示、三张素材可用、慢连接提示及重载后自动授权、成功立即退出场景、失败表单可用、减少动效、320/390/768/1440 无横向溢出。公网临时分享授权配合浏览器侧延迟验证加载画面及真实团队进入通过，无 JS 异常，授权已撤销。
- 仅静态资源更新，无 Host 重启。备份 /root/zhijian/deploy-backups/review-loading-20261007/；预览 /tmp/review-loading-mobile.png、/tmp/review-loading-desktop.png、/tmp/review-loading-public.png。
- 附加旧版综合公网巡检未全程通过：读取稿件时等待下载入口超时，页面记录 REVIEW_REQUEST_TIMEOUT；加载专项及免密进入实测通过。未将此网络/文档读取异常计为本次加载动画验收通过，也未修改文档读取逻辑。
