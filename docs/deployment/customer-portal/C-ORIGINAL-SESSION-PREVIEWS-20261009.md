# C 账号原始会话只读归档（2026-10-09）

用户要求将三个公开报告各自放回原始会话，不再合并为“报告样例”。客户页现沿用贵州团队的账号限定只读预览接口，每条已确认来源单独出现在 C 账号会话列表；可查看发布前的用户/助手文字对话、原团队任务与人物路线，以及对应 HTML。源团队和源页面均未修改。

| 报告 | 已核实的原始来源 | C 账号预览 ID | 状态 |
|---|---|---|---|
| 成都数据集团合作 | 团队 `智见报告-成都数据集团合作`，队长 `session-aec3fc2a-285d-4c57-b987-901ac5a3d58b`；源 HTML 与最终本地文件 SHA-256 相同 | `dd2c8815-287c-4bcf-8925-e9cb76ebc747` | 已上线：6 项原任务、78 条发布前文字消息、原报告 |
| 十二主体角色重写 | 团队 `智见点评-十二主体角色重写`，队长 `session-6d6dad49-4b0f-4e9a-afb1-ba3dba1a684e`；源 HTML 与最终本地文件 SHA-256 相同 | `8a3d657f-335c-40ad-aafc-41c6ff465f29` | 已上线：7 项原任务、118 条发布前文字消息、原报告 |
| 海兴雅苑租金定价 | `real.zj.meizu.life` 租户的归档团队 `智见点评-海兴雅苑一居室租金定价`，队长 `session-397808a7-36a6-45c5-8572-606524ca54fa`；会话在事件 812 发布原报告，事件 821 给出外网链接；租户成品与公网 HTML 的 SHA-256 均为 `e01fafd4cddad9aa79abe9c7a09850d0ecb6f2016e231e431ec9f8ad128e2c73` | `e1e6186d-8600-4a2f-8be5-f503b6964d57` | 已上线：8 项原任务、65 条发布前及发布确认文字消息、原报告 |

实现位于 `apps/customer-portal/c-historical-previews.mjs`，打包脚本为 `apps/customer-portal/scripts/build-c-historical-previews.mjs`。私有快照置于生产 `/opt/zhijian/customer-portal/private-previews/original-sessions/`，仅 C 账号可访问；写操作返回 405，其他账号返回 404。前次“报告样例”入口已撤下，原文件移入生产备份 `/opt/zhijian/customer-portal/.backup-c-original-sessions-20261009T031000Z/retired/`。

海兴的来源是 `real.zj.meizu.life` 独立租户，不在 `/root/zhijian/dsh-expert-library/work/`。其归档团队位于 `/var/lib/dsh-server-login/users/54485b72-c5b9-4fbd-be13-bc0c2c82e0a5/ws/main/bank/expert-teams/archive/`，原始会话为同用户 `home/sessions/` 下的 `session.v3.jsonl.zstd`；会话事件文件 SHA-256 为 `c9b814160825d24921d356c6ab769a8d8fcac027c6a81d12721b437540f2a60b`。该报告需要少量内联脚本绘制价格带；预览仅对这个已验证文档开启隔离 iframe 脚本执行，CSP 保持无同源权限、无网络连接。

验收：客户页 `npm test` 15 项、`node scripts/qa-p0.mjs` 通过；生产 C/B 双账号接口实测，390/1280px 真浏览器均显示各自任务、对话和报告，无页面脚本错误。
