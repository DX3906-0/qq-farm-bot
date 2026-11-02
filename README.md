# QQ 农场多账号自动化平台

> 面向 QQ 农场小游戏的多账号托管系统。网关/worker 分离架构、进程级故障隔离、
> 协议级活动适配、以及一套从 Cocos bundle 反解美术资源的工具链。

一套跑了半年的生产系统，不是 demo。核心指标是**零掉线**——为达成这个目标，
做了远程抓码守护、网关热重载、亚健康退避、熔断分级等一系列工程化设计。

---

## 这套架构特别在哪

### 1. 网关/worker 双进程分离：重启 worker 不掉线

绝大多数同类方案是「一个进程一条游戏连接」，重启进程就等于掉线重连，
而 QQ 农场的一次性 Code 重连代价极高——大概率撞 1006，需要人工重新抓包。

这里的做法是把**连接持有**和**业务逻辑**彻底拆开：

```
┌─────────────────┐         Unix Socket          ┌──────────────────┐
│ farm-worker     │  ◄──── JSON 帧（换行分隔）────► │ farm-gateway     │
│ 业务/自动化逻辑  │                               │ 持有 gameserver  │
│ 可随意重启       │                               │ WebSocket 连接   │
└─────────────────┘                               └──────────────────┘
```

关键收益：**gateway 进程的 gameserver 连接在 worker 重启期间保持不变**。
worker 重新发一个 `connect` 帧，gateway 检测到连接仍存活（`readyState === OPEN` 且
`userState.gid` 存在）就走"复用"分支，**不重新登录、不消耗 Code**：

```javascript
// gateway-process.js
if (liveWs && !codeChanged) {
    log('gateway', `account ${accountId} 复用已有网关连接（worker 重启免 Code）`);
    sendFrame(sock, { t: 'login', accountId, userState: account.userState });
}
```

实测：部署后端代码时 worker 重启，账号全程在线，日志会出现上面这条"免 Code"记录。

**IPC 协议设计**：用 JSON 文本帧（`\n` 分隔）而非二进制帧，protobuf body 用 base64
嵌进 JSON。牺牲一点带宽，换来可以用 `socat` / `nc` 直接调试，以及不会因为
protobuf 定义变更导致两端协议不兼容。

### 2. 多账号进程隔离 + 同步状态的分层持久化

每个账号一个独立 worker 进程（`fork`）。单账号崩溃不影响其它账号——
这在多开场景是必须的，否则一个号的风控会拖垮全部。

但多进程带来一个隐蔽问题：**lost-update**。每个 worker 都持有自己的
`store.js` 副本，任何 worker 全量 `saveGlobalConfig()` 都会**冲掉主容器里
其它账号的配置**。

解决分了三层：

| 场景 | 方案 |
|---|---|
| 全局配置（低频） | 进程守卫：`FARM_ACCOUNT_ID` 有值即不落盘，只允许主进程写 |
| 账号级 automation | `syncAutomationPatchToMaster()` 打补丁而非全量覆盖 |
| 高频运行态（如收割节奏） | 每账号独立文件 `data/harvest-pacing/{id}.json`，单写者 + 原子写 |

### 3. 亚健康退避：在下沉到传输层之前，它只覆盖 1/10 的入口

游戏服务器偶发静默（不回包但不断连）。此时无脑发请求只会让
`pendingCallbacks` 堆积、心跳排不上队，最终连接"假死"。

原设计是「连续超时 N 次 → 判定假死 → 重连」，但有个缺陷：退避信号
（`connection_degraded`）只有 `runUnifiedTick` 一处检查，而 worker 有
**10+ 个独立业务入口**（农场/帮助/偷菜/邮件/宠物/商店/活动…），它们完全无视退避。

修法是把闸门**下沉到 `sendMsgAsync`**——所有 gateway 请求的唯一必经之路：

```javascript
// gateway-client.js
if (healthBackoffUntil) {
    const isCritical = _isCriticalRequest(service, method);
    if (!isCritical && isHealthBackoffActive()) {
        throw new Error(`网关亚健康退避中(${reason})，剩余 ${remainS}s`);
    }
}
```

三个设计要点：
- **只拦业务请求**，心跳/登录/ACE 白名单放行（退避的目的就是给它们让路）
- **快速失败不排队**（否则退避结束瞬间会涌出一批陈旧请求）
- **闸门必须在 `requestGate.acquire` 之前**（否则请求先占满 8 个并发槽位再被拒，反而把心跳挤掉）

### 4. 熔断分级：区分"临时失败"和"凭证真失效"

微信换码失败时，旧逻辑一律 `failCount++`，3 次就停号等人工扫码。但实测 72 小时数据：

| 指标 | 数值 |
|---|---|
| 保活成功 / 失败 | **70 / 6** |
| 6 次失败的错误类型 | **全部 40188 invalid scope** |
| 失败时机 | **全部在网络抖动期** |

40188 是腾讯对授权接口的**临时 scope 拒绝**，不是凭证过期。于是加了分类器：

```javascript
// 临时性：40188 / 超时 / ECONNRESET / ManualAuth → 独立计数 + 指数退避 5→30min
// 永久性：refreshtoken 真死 / 凭证文件缺失 → 立即停止，等人工扫码
// 未知错误：保守按临时处理
```

更关键的是修了一个更致命的：`catch` 分支里 `networkStopped = true` 会捕获
`withTimeout` 抛出的"换码超时"——**网络卡一下就永久废弃账号**。

### 5. 判死阈值不是拍脑袋定的

`DEAD_REQUEST_TIMEOUT_STREAK` 从 5 调到 7，依据是实测数据：

- 72h 假死重连 **115 次**（≈38/天）
- 其中第 1 次重连后仍需第 2 次的占 **64%** → **首次重连成功率只有 36%**
- 说明大量"假死"其实是服务端短时静默、连接本身没坏，重连反而白白消耗 Code
- 心跳超时**全部集中在 174.9 秒、跨度仅 15 毫秒** → 证明那是本地阈值判定（6×25s+延迟），不是真实网络时长

### 6. 防重复闸门必须看真实资源状态，不能只看时间窗

给 `connect()` 加并发保护时踩了坑。第一版只按"5 秒内有过 connect"就拦截：

```
account 1 建连进行中(2407ms)，跳过重复 connect
```

结果 worker 崩溃被重新拉起后，新 worker 发的**第一个** connect 正好落在窗口内被跳过——
而新 worker 只发一次 connect，账号就此永久离线。

正确语义是**只在旧 socket 仍然 OPEN 时才拦截**：

```javascript
const prevWsAlive = !!(account.ws && account.ws.readyState === account.ws.OPEN);
if (prevWsAlive && account.connectingAt && now - account.connectingAt < 5000) return;
```

`account.ws` 为 null / CLOSED 说明上次建连已结束，新 connect 必须放行。

---

## 装扮图鉴：从 Cocos bundle 直接取美术资源

这是本仓库比较独特的部分。通常想拿游戏内美术资源（装扮图标、图鉴图标、活动贴图），
只能等客户端把对应界面点开一次，资源才会落到本地缓存——**没点开就"没图"**。

但实际上"本地没图" ≠ "游戏里没有"。只要能从 bundle 清单拿到 uuid + hash，
就可以**直接按 CDN 地址下载**，完全不用开客户端。

### 定位链

1. **bundle 清单**（缓存里的 `<bundle>/<localid>.json`）包含：
   - `paths`：`"<index>" -> ["<资产路径>", <type>, ...]`
   - `uuids`：按 index 取**压缩 uuid**（22 字符）
   - `versions.native[index]` / `versions.import[index]`：版本 hash

2. **压缩 uuid → 标准 GUID**：Cocos 用的是**私有字母表**，不是标准 base64 顺序：

   ```
   ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/
   ```

   前 2 字符原样保留，之后每 2 字符 → 3 个 hex：

   ```
   hex0 = r >> 2
   hex1 = ((r & 3) << 2) | (s >> 4)
   hex2 = s & 0xF
   ```

   再按 `8-4-4-4-12` 插连字符。

3. **下载地址**：

   ```
   图片：{CDN}/release/remote/{bundle}/native/{GUID前2位}/{GUID}.{nativeHash}.png
   数据：{CDN}/release/remote/{bundle}/import/{GUID前2位}/{GUID}.{importHash}.json
   ```

实现见 `tools/asset-fetcher/fetch-qqext-assets.py`，支持按路径正则批量匹配。
仓库内已收录 **163 个装扮图标**（`core/src/gameConfig/deco_icons/`）。

### 资源映射的隐蔽坑

比"拿到图"更容易出错的是**图放对地方了但前端还是裂图**：

- 「有图无映射」= 漏了 `staticItemImageMap` 登记 → 最隐蔽的图裂根因
- 「有图无名称」= 漏了 `staticItemInfoMap`
- 游戏配置有两个磁盘根：`core/src/gameConfig/*` 与 `web/public/game-config/*`，**两处都得同步**

`tools/asset-fetcher/audit-image-refs.py` 和 `audit-item-names.py` 就是为此写的审计脚本，
支持 `--check` 模式接进 CI。

---

## 远程抓码与守护

QQ 农场的登录 Code 是一次性的，过期后网关会收到 `1006`（风控拒连）。
此时**任何重连都无用**，必须重新抓码。

### 本机 NapCat 取码链路

```
检测掉线 → 切号（SetQuickLoginQQ）→ 重启 NapCat 宿主 → loginWithAppId 取 code
        → 建 flow → inject{code,openId,gid} → complete → 账号拉起
```

守护进程（`tools/capture-guard/napcat-code-guard.py`）每 120s 轮询面板，
发现掉线即自动走上述链路。

### 判定"掉线"不能用 `running`

踩过的坑：面板 `/api/accounts` 的 `running` 字段只表示 **worker 进程存活**，
而 gateway 模式下会出现「僵尸 worker」——进程活着、socket 已断、既不重连也不退出。

```
running=True   connected=False    ← 僵尸状态
```

若按 `running` 判活，守护会报"无掉线账号"，**永不补码**，账号就这么一直挂着。
正确做法是单独查 `/api/status` 的 `connected`：

```python
needs_fix = (not ac['running']) or (panel_qq_connected(token, ac['id']) is False)
```

### 补码前必须先 stop 旧 worker

只 inject + complete 不杀旧进程的话，新 Code 注入成功、complete 返回 200，
但旧 worker 仍挂在断开的 socket 上，**表现依旧离线**。必须先 stop 让主容器杀掉进程，
complete 时才会 fork 干净的新 worker。

### 宿主侧工程细节

NapCat 宿主是带 GUI 的 Electron 应用，在无人值守场景会带来两个麻烦：

**黑框问题**：守护由 `pythonw` 托管（GUI 子系统、无控制台），
`os.system('taskkill')` 会拉起 `cmd.exe` → cmd 自行 `AllocConsole()`
→ Win11 委派给 Windows Terminal → **杀一个进程弹一个黑框**。

实测对照：旧路径 2 个黑框 / 5825ms，改用 `OpenProcess + TerminateProcess` 后
**0 个黑框 / 3ms**。要点：`ctypes` 调 Win32 必须显式设 `argtypes/restype`，
默认 `restype=c_int` 会截断 64 位 HANDLE。

**抢焦点**：宿主的控制台窗口会抢走前台焦点。对策是 `SetWinEventHook` 监听
`EVENT_OBJECT_CREATE`/`SHOW`/`SYSTEM_FOREGROUND`——**CREATE 早于 SHOW，
创建即隐藏**，比事后隐藏可靠得多。隐藏后用 `AttachThreadInput + SetForegroundWindow`
夺回焦点（不模拟键鼠，避免被判定为自动化输入）。

---

## 发现机制：活动适配

游戏活动会周期性换皮（同一套玩法，改名换 ID 重新上线）。适配方法是
「在相近的旧活动上改造」，并登记到活动族：

```javascript
// core/src/config/activity-families.js —— 8 个活动族
```

### 判断"活动在期"不能看字段有没有值

这是最反直觉的坑。各活动的 `normalizeXxx({})` 有 `|| 默认值` 兜底，
会给不存在的活动造出假的字段值，导致"判在期"恒为真。

可靠判据必须是**节点是否真的下发**，例如：

| 活动 | 判据 |
|---|---|
| 星垂 | `!warning` |
| 雨落 | `active` |
| 鹊桥 | `bridge && !ended` |
| 秋祈 | `active` |
| 快乐不独享 | 抛错即不在期 |
| 奶茶 | `phase === 'business' \|\| 'settling'` |

### protobuf map key 的坑

`map<int64, X>` 在 protobufjs 里 key 是**原始字节串**，不是数字。
必须用 `protobuf.util.longFromHash(text, false).toString()` 还原。

另外依赖「硬编码小表 + 从原始字节猜」的解析极脆弱（曾把 `brief_dog_info`
声明成 `bytes`，导致表外狗 id 全变 0）。正确做法是用**结构化 message** 定义。

---

## 技术栈与规模

| 层 | 技术 |
|---|---|
| 后端 | Node.js · Express · protobufjs |
| 前端 | Vue 3 · TypeScript · Pinia · Vite |
| 部署 | Docker Compose · 云服务器 |
| 采集/守护 | Python · ctypes(Win32) · NapCat |

```
后端源文件      286 个（js/ts/vue）
protobuf 定义   26 个 .proto
单元测试        46 个测试文件
前端组件        20 个 .vue
装扮图标        163 张
```

---

## 目录结构

```
core/                       后端
├── src/runtime/            网关/worker 运行时
│   ├── gateway-process.js    连接网关（持有 gameserver ws）
│   ├── gateway-client.js     worker 侧客户端 + 退避闸门
│   ├── gateway-protocol.js   IPC 帧协议
│   └── worker-manager.js     多账号进程管理
├── src/services/           业务逻辑（农场/活动/好友/背包…）
├── src/config/             活动族映射
├── src/gameConfig/         游戏静态数据
│   └── deco_icons/           163 个装扮图标
├── src/proto/              26 个 protobuf 定义
└── test/                   46 个测试文件

web/                        前端（Vue 3）
tools/
├── capture-guard/          抓码守护（本机 Windows 侧）
│   ├── napcat-code-guard.py  守护主程序
│   ├── pick-account.py       QQ 选号框 OCR 定位
│   └── remote-capture.js     远程抓包流程
└── asset-fetcher/          美术资源获取与审计
    ├── fetch-qqext-assets.py   Cocos bundle → CDN 直取
    ├── audit-image-refs.py     图片引用审计
    └── audit-item-names.py     物品名审计

docs/                       技术文档
```

---

## 快速开始

### 环境变量

所有环境相关配置都走环境变量，仓库内不含任何真实地址或口令：

```bash
export FARM_PANEL="http://YOUR_HOST:3007"    # 面板地址
export FARM_PANEL_USER="admin"
export FARM_PANEL_PASS="your-password"

# 抓码守护额外需要
export NAPCAT_BASE="http://127.0.0.1:6099"
export NAPCAT_WEBUI_PWD="your-napcat-webui-password"
export NAPCAT_PLUGIN_TOKEN="your-plugin-token"

# 账号映射（id -> QQ 号）
export FARM_ACCOUNT_1_UIN="1000000001"
export FARM_ACCOUNT_10_UIN="1000000002"
export FARM_RELEASE_AFTER_FIX="1"              # 补完码后让出的账号 id
export FARM_RELEASE_TARGET_UIN="1000000002"    # 让出后驻留的 QQ 号
```

抓码守护的其它参数（休眠策略、轮询间隔等）见
`tools/capture-guard/.napcat-guard-config.json.example`。

### 启动后端

```bash
cd core
npm install
npm start
```

### 启动前端

```bash
cd web
npm install
npm run dev
```

### 抓码守护

```bash
cd tools/capture-guard
cp .napcat-guard-config.json.example .napcat-guard-config.json   # 按需修改
python napcat-code-guard.py --once    # 前台跑一轮，调试用
python napcat-code-guard.py           # 常驻
```

⚠️ 注意：`--stop` 会杀掉**全局**守护（含开机自启的那个），且不会自动恢复。
日常只想清熔断请用 `--reset`（只写熔断文件，不碰进程）。

---

## 运行测试

```bash
cd core
node --test test/*.test.js
```

基线为 2 个已知失败（对外 advertise 地址顺序、mystery shop 轮询时序），与核心逻辑无关。

---

## 免责声明

本项目仅供**个人学习与技术研究**使用，用于研究小游戏客户端与服务端之间的协议交互、
分布式进程架构、以及资源打包格式。

使用者需自行承担使用风险，包括但不限于账号安全、游戏用户协议合规性。
请勿用于任何商业用途或大规模批量操作。

项目不包含任何游戏客户端代码或美术资源的再分发许可，
`deco_icons/` 中的图片仅作为资源获取工具链的验证样本，
版权归腾讯及相关权利人所有。