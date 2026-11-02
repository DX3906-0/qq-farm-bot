# 架构设计

> 记录几个核心设计决策的**为什么**，而不只是**是什么**。

## 一、为什么网关和 worker 必须分离

### 问题

QQ 农场的登录 Code 是**一次性**的。一旦连接断开，用同一个 Code 重连会被服务器
以 `1006` 拒绝（风控），而且重试越多风控越重。

这意味着：**每一次进程重启 = 一次掉线 = 一次人工介入**。

开发期这完全不可接受——改一行业务代码就要重新抓包，一天下来几十次。

### 解法

把「持有连接」和「跑逻辑」拆成两个进程：

```
farm-gateway（常驻，不重启）
  ├── 持有 gameserver WebSocket
  ├── 维护 userState（gid / name / level）
  ├── 发心跳
  └── 处理重连/换码

farm-worker（每账号一个，可随意重启）
  └── 业务自动化逻辑，通过本地 socket 请求网关代发
```

代码改动若只涉及 `worker.js` / `services/*`，重启 worker 即可——
gateway 的 WebSocket 不受影响。

### 复用的判定条件

worker 重启后重新发 `connect` 帧，gateway 判断能否复用：

```javascript
const liveWs = !!(
    account.ws
    && account.ws.readyState === account.ws.OPEN
    && account.userState
    && account.userState.gid
);
const codeChanged = !!(incomingCode && String(incomingCode) !== String(account.savedCode || ''));

if (liveWs && !codeChanged) {
    // 复用：直接把 userState 推回给 worker，不重新登录
    sendFrame(sock, { t: 'login', accountId, userState: account.userState });
} else {
    // 重建：需要 Code
}
```

两个前提缺一不可：
- `readyState === OPEN`：socket 层还连着
- `userState.gid`：游戏层还处于已登录状态

只有 `code` 变了才强制重建——这对应"用户重新抓码"的场景。

### 边界：哪些情况复用不了

| 场景 | gateway 侧状态 | 能复用吗 |
|---|---|---|
| worker 重启 / 主容器重启 | ws 仍 OPEN，gid 保留 | ✅ 免 Code |
| gateway 容器重启 | 内存全清，savedCode=null | ❌ 需补码 |

因为 `accounts` 是内存 Map，gateway 重启后状态全丢。这是结构性限制，
不是 bug——要跨重启保留就得把凭证落盘，那反而扩大攻击面。

---

## 二、多进程配置同步：三层防 lost-update

### 问题

每个 worker 是独立进程，各自 `require` 一份 `store.js`，各自持有内存里的配置副本。

任何 worker 调用全量的 `saveGlobalConfig()`，都会把自己那份**可能过期的**
完整配置写回磁盘，**冲掉其它账号刚改的内容**。

典型现象：改了 A 账号的配置，B 账号的 `stealPlans` / `knownFriendGids`
莫名其妙变了。

### 三层方案

**第一层：进程守卫（挡住全量写）**

```javascript
// 只有主进程（FARM_ACCOUNT_ID 未设置）才允许全量落盘
if (!process.env.FARM_ACCOUNT_ID) {
    saveGlobalConfig(full);
}
```

worker 里所有全量保存调用直接变成 no-op。

**第二层：补丁式同步（worker 改配置的唯一途径）**

worker 不写盘，而是把"我要改什么"发回主进程：

```javascript
syncAutomationPatchToMaster(accountId, changedKeys);
```

主进程收到后只合并这几个 key，不碰其它部分。

**第三层：高频运行态走独立文件**

收割节奏这类每秒都可能变的运行态，根本不进全局配置：

```
data/harvest-pacing/{accountId}.json
```

单写者（只有该账号的 worker 写）+ 原子写（写临时文件后 rename）。

### 为什么不用文件锁

多进程 + 文件锁在高频写场景会变成性能瓶颈，且 Windows 上的文件锁语义
和 Linux 不一致。分层方案把"需要一致性的范围"缩到最小，比加锁更简单也更可靠。

---

## 三、假死判定与亚健康退避

### 两种"连接坏了"

| 类型 | 表现 | 判定 |
|---|---|---|
| 真断线 | socket close / 1006 | 事件驱动，立刻知道 |
| 假死 | socket 还开着，但业务请求全超时、心跳无响应 | 只能靠超时累积 |

假死更麻烦——连接看起来是好的，实际上什么也干不了。

### 判死阈值怎么来的

初版设 5 次连续业务请求超时（5 × 30s = 150s）。但实测 72 小时数据后改成了 7：

```
假死重连总次数           115 次（≈38/天）
第 1 次重连后仍需第 2 次   64%（42/66）
→ 首次重连成功率只有       36%
```

第一次重连只成功 36%，说明**大量"假死"其实是服务端短时静默，连接本身没坏**。
重连反而白白消耗 Code（QQ 号每次重连都要重新登录）。

另一条佐证：心跳超时**全部是 174.9 秒、跨度仅 15 毫秒**。
这不是真实网络时长，而是本地阈值计算（6 次 × 25s + 检测延迟）的固定结果——
说明我们看到的"174 秒超时"其实是"连续 6 次心跳没回包"，真实抖动可能远短。

所以放宽到 7 次（210s），真死连接仍在 3.5 分钟内被发现。

### 亚健康退避：从 1/10 覆盖到全部

判定假死之前有个中间状态：连续 2 次超时（约 60s）。此时应该
**暂停业务请求，把带宽让给心跳**自愈。

原实现只在 `runUnifiedTick` 检查退避标志，但 worker 有 10+ 个独立入口：

```
runDailyRoutines / runFarmTick / runHelpTick / runStealTick
runEmailAutoClaim / runPetFoodAutoFeed / runMysteryShopAutoBuy
runStarActivityAutoClaims / runPetWishShare / ...
```

它们完全不看这个标志，继续往假死连接打请求 → `pendingCallbacks` 堆积
→ 心跳排不上队 → 更快判死。

修法是把闸门下沉到 `sendMsgAsync`——所有 gateway 请求的唯一必经之路。

```javascript
async function sendMsgAsync(service, method, bodyBytes) {
    // 必须在 requestGate.acquire 之前
    if (healthBackoffUntil && !_isCriticalRequest(service, method)) {
        const remainS = Math.ceil((healthBackoffUntil - Date.now()) / 1000);
        throw new Error(`网关亚健康退避中(${reason})，剩余 ${remainS}s`);
    }
    const release = await requestGate.acquire(getRequestPriority());
    // ...
}
```

三个细节都很重要：
- **闸门在 acquire 之前**：否则请求先占住并发槽位（`maxActive: 8`）再被拒，
  8 个槽位在退避期内空转占满，反而把心跳挤掉了
- **快速失败不排队**：入队等待的话，退避结束会瞬间涌出一批陈旧请求
- **关键请求白名单**：心跳/登录/ACE 必须放行，退避的目的就是给它们让路

---

## 四、熔断分级

### 问题

微信换码失败后，旧逻辑一律 `wxCodeFailCount++`，累计 3 次就
`networkStopped = true`，必须人工扫码。

但 72 小时实测：

```
保活成功 70 次 / 失败 6 次
6 次失败全部是 40188 invalid scope
且全部发生在网络抖动期间
```

40188 是腾讯对授权接口的**临时 scope 拒绝**，网络恢复后同一份凭证往往
下一轮就能换成功——把它当成"凭证失效"会让几次网络抖动就把账号打进必须扫码的状态。

### 分类处理

```javascript
function classifyWxCodeError(msg) {
    // 永久性：凭证真废了
    if (/loginBuffer 文件不存在|loginBuffer 为空|解析异常/.test(msg))
        return { temporary: false, reason: 'local_credential_missing' };
    if (/无 refreshtoken|旧版落盘未保存凭证/.test(msg))
        return { temporary: false, reason: 'no_refreshtoken' };
    if (/WeChat token refresh failed|RefreshToken empty/.test(msg))
        return { temporary: false, reason: 'refreshtoken_dead' };

    // 临时性：退避后重试
    if (/40188|invalid scope/.test(msg)) return { temporary: true, reason: '40188_scope' };
    if (/超时|timeout/.test(msg))        return { temporary: true, reason: 'timeout' };
    if (/ECONNRESET|ETIMEDOUT|socket hang up/.test(msg))
        return { temporary: true, reason: 'network' };

    // 未知错误保守按临时处理——宁可多试几次，也不误判成"必须扫码"
    return { temporary: true, reason: 'unknown' };
}
```

临时失败走指数退避 5 → 10 → 20 → 30 分钟（封顶），累计 5 次才停。

### 顺带修掉的更致命缺陷

```javascript
} catch (e) {
    account.networkStopped = true;   // ← 旧代码
}
```

`withTimeout` 抛出的"换码超时 20000ms"、"刷新超时 30000ms" 都会进这里——
**网络卡一下就永久废弃账号**。这比 40188 的问题严重得多。

改成同样按分类处理：临时异常退避重试，只有永久性才停。

---

## 五、"防重复"闸门的通用教训

给 `connect()` 加并发保护时，第一版这样写：

```javascript
if (account.connectingAt && now - account.connectingAt < 5000) {
    return;   // 5 秒内有过 connect，跳过
}
```

意图是防止同一账号并发建连产生孤儿 socket（后建的 `closeCurrentWs` 只清理
`account.ws` 指向的那个，先建的成为孤儿——仍连着 gameserver 但本地无引用，
服务器侧看到同 code 多连接就会顶号）。

**结果直接打挂了账号：**

```
account 1 建连进行中(2407ms)，跳过重复 connect
```

链路是：worker 崩溃 → 主容器拉起新 worker → 新 worker 发的**第一个** connect
正好落在 5 秒窗口内 → 被跳过。而新 worker **只发一次** connect，此后再无机会。

### 正确做法

判据必须包含**真实资源状态**，不能只看时间窗：

```javascript
const prevWsAlive = !!(account.ws && account.ws.readyState === account.ws.OPEN);
if (prevWsAlive && account.connectingAt && now - account.connectingAt < 5000) {
    return;   // 只有"上一次的 socket 还活着"才需要拦截
}
```

`account.ws` 为 null / CLOSED 说明上次建连已经结束了（无论成功还是失败），
此时的 connect 是合法的新尝试，必须放行。

### 推广

时间窗只能表达"多久之前发生过某事"，无法表达"那件事是否已经结束"。
凡是"防重复"类闸门，都要问一句：**我拦的到底是"重复"，还是"新的"？**

---

## 六、装饰性资源的获取链路

见 README 的「装扮图鉴」章节。核心是把 Cocos 的压缩 uuid 按私有字母表
还原成标准 GUID，然后拼 CDN 地址直取——不必等客户端加载。

这里补充一个**审计**比**获取**更容易被忽视：

| 现象 | 根因 |
|---|---|
| 图放进去了但前端裂图 | 漏了 `staticItemImageMap` 登记 |
| 有图但显示"未知物品" | 漏了 `staticItemInfoMap` |
| 本地开发正常，线上裂图 | 两个磁盘根之一没同步 |

游戏配置有两个磁盘根，**必须同时维护**：

```
core/src/gameConfig/*        （服务端读）
web/public/game-config/*     （前端读）
```

`tools/asset-fetcher/audit-image-refs.py` / `audit-item-names.py`
就是为此写的，支持 `--check` 接进 CI。