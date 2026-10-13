# 98wiki 三通道预检 · 固定任务 Prompt v1

读取已审 `OUTLINE.md` 中的城市、时段和指标需求。按 Host 注入的 `98wiki-data-channels` 材料，在任何批量取数前对 Wind、贝壳、证研通 dataset 分别执行最小探针；同一课题涉及多个城市时逐城留痕。不要把历史 playbook 的成功案例当作本轮结果。

发布 `data-channel-status.md`：对每个城市×通道列出实际调用时间、调用入口与最小参数（不写凭据）、返回状态/错误码、数据可用性、统计口径、允许的降级路径和是否停止重试。错误、空系列与零值分开记录；积分不足与鉴权失败不重试。无法调用时写“未执行”及原因，不声称已探通。不得编造数据。

文件包含 `json channel-status` 围栏，结构为 `{"cities":["北京","上海"],"researchMode":"FULL|CONDITIONAL|BLOCKED","probes":[...]}`。每城必须各有 `wind`、`beike`、`zyt` 一行；每行写 `city,channel,status,tool,request,reason`。状态仅可为 `available|failed|empty|unconfigured|not_run`。实际调用行另写 ISO `attemptedAt` 与真实响应 SHA256 `receiptSha256`；失败行加 `errorCode,fallback`。未调用行不得伪造调用时间或响应哈希。全部不可用时不得标 FULL。
