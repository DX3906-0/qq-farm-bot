# 活动自动接入方案

本文描述 QQ 农场新限时活动从"发现"到"接入"的自动化流水线设计与现状。
配套手册（人工接入细节）见 `activity-update-runbook.md`。

## 总体结论

活动接入分三层，自动化程度逐层递减：

| 阶段 | 内容 | 现状 |
| --- | --- | --- |
| 发现 | 识别新活动 ID、标题、时间、结构 | 全自动（已上线） |
| 通知 | 新活动微信推送 | 全自动（已上线） |
| 采集 | 获取展示/操作协议样本 | 半自动（见增强项 A/B） |
| 接入 | 写适配代码或配置 | 半自动（见增强项 C） |

"完全无人值守接入"不可行也不应追求：活动操作协议（命令号、槽位语义）
需要真实成功样本验证，盲目自动化会误操作账号。上游实现也明确
`safeToAutoApply: false`。方案目标是把人工压缩到"确认后点一下"。

## 第一层：自动发现（已上线）

- `core/src/services/activity-update-monitor.js` 每 30 分钟扫描一次
  （`ACTIVITY_UPDATE_INTERVAL_MS` 可调）。
- 在线扫描（`admin-activity-update-routes.js`）任选一个已连接账号：
  1. `ActivityService.List`（`getActivityDiscoveryList`）拉取活动发现列表；
  2. 对未知活动逐个调 `getActivityGroupSnapshot` 取结构快照；
  3. 用 `buildDateProbeIds` 探测未来 3 天的日期格式 ID（`20\d{8}`，
     每天 10 个槽位），提前发现未上架活动。
- 结果写入 `data/activity-update-report.json`，前端活动页
  `AdminActivityUpdatePanel` 展示。

## 第二层：自动推送（已上线）

- CloudBase `botMonitor` 云函数每 5 分钟巡检，读取
  `/api/activity/update/status`。
- 与 NoSQL 快照（集合 `bot_monitor`）中上次 `activityIds` 对比，
  出现新 ID 即经 `ALERT_WEBHOOK`（PushPlus）推送：
  `🎉 发现未来新活动：{标题}（ID xxx）`。

## 第三层：采集增强（建议实现）

### A. 抓包会话自动留存活动协议样本

现状：MITM 抓包（`core/src/capture/mitm-proxy.js`）只提取登录 code 与
好友 GID；活动协议仍需 Charles/Proxyman 手工导出 HAR 再用
`npm run inspect:activity-har` 分析。

增强：扩展 `friend-extractor.js` 同款模式，新增 `activity-sample-recorder`：

- 在 WS 帧解析回调中识别 `meta.service_name === 'ActivityService'` 的
  gatepb 消息；
- 只留存脱敏元数据：方向、client_seq、method、正文长度、响应中的活动
  ID/命令号/槽位结构；不写 auth_token、code、账号标识；
- 落盘 `data/capture/activity-samples/{date}/{活动ID}.json`；
- 抓包登录后自动得到"这个会话期间出现过哪些未知活动操作"，直接作为
  runbook 第 3 步协议表的草稿。

注意：TSDK 加密导致请求正文不可直接解码，样本价值在于方法名、序列号
配对和响应侧可解结构；与 runbook 的交叉验证方法一致。

### B. 在线探测自动归档

把 `getActivityGroupSnapshot` 对未知 ID 的成功快照直接写入
`data/activity-snapshots/{活动ID}.json`（标题、子活动树、奖励、时间），
面板活动页可直接展示"未来活动"卡片，无需打开 HAR 就能看到活动骨架。
当前快照只进 report 不落盘，建议补落盘。

## 第四层：接入半自动化（后续路线）

### C. 活动族谱 + 照族换皮（已落地）

历年活动高度模板化，且**官方会把同一套玩法骨架换 ID / 换文案 / 换 UI 皮再上架**
（活动不会"原模原样返厂"）。本地代码里这种共性已经客观存在，只是此前是隐性约定：

| 证据 | 说明 |
| --- | --- |
| 荷风游记 ↔ 千星游记 | **共用同一个 `HeluPassportPanel` 组件 + 同一套 `getSeasonPassport()`**，仅靠 title/uid 区分 |
| 荷风十里蝉初鸣 ↔ 心许千灯星垂野 | 共用兑换商店（`exchange_shop = 102`）与节令小札两套面板 |
| 奶茶热销中 ↔ 荷风/星垂 | 兑换商店同走 102 字段号，仅字段形状不同（容错解析） |

因此**不该为新活动新增一套并行实现**，而应「照族换皮」。族谱已落盘为
`core/src/config/activity-families.js`，它是活动适配的**单一事实来源**：

- `ACTIVITY_FAMILIES`：8 个族（抽奖·商店·游记·小札 / 鹊桥 / 天气瓶 / 萌宠养成 /
  分享领奖 / 店铺经营 / 酿造经营 / 随机商店），每族登记 `slots`（槽位）、
  `members`（历次上线成员）、`subActivitySlots`（子活动 ID → 槽位）、
  `guide`（换皮指引）。
- `ACTIVITY_SLOT_DEFS`：槽位 → `ActivityNode` 字段号 + 复用组件名，
  即「这个槽位该复用哪个面板」的清单。
- `resolveActivityFamily(snapshot)` / `describeFamilyHint(snapshot)`：
  按槽位指纹给未登记活动归族，输出「归属 X 族，可照 Y 换皮改造」。
- `listKnownFamilyActivityIds()`：已知活动 ID（含子活动），供发现层排除误报。

接入方式：

```text
新活动快照（发现层） → 族谱归族 → 推送「归属 X 族，照 Y 改」
                                    ↓
                     照族成员改 ID/uid/文案/UI，复用族内面板与 service
                                    ↓
                     登记进该族 members（否则会被反复报为未知新活动）
```

- 命中已知族：只改 ID/uid/标题/文案 + 换 UI 皮，**不新增并行实现**；
- 未命中族：以"只读卡片"展示（符合 runbook 安全边界：没有成功操作样本时保持只读），
  等人工补协议后再登记为新族。

### D. AI 辅助接入

新活动的快照 JSON + 同族最近成员的适配 diff 可作为上下文交给 AI 生成适配代码草稿，
人工按 runbook 第 8 节验证门槛审核后合并。族谱让"同族最近成员"可被程序自动定位，
不再依赖人工翻 git 历史。

## 运维备忘

- 扫描依赖至少一个已连接账号；账号掉线时报告标记
  `online.error: 没有已连接账号`，发现能力暂停。
- 部署新版后账号进程需重新启动（面板一键启动或
  `POST /api/accounts/{id}/start`）。
- 登录 Code 过期（日志"连接被拒绝，可能需要更新 Code"）时需重新抓包登录。
