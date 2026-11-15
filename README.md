<div align="center">

# QQ Farm Bot

**多账号农场面板，让日常经营更省心。**

独立运行 · 持续连接 · 按需补码 · 完整图鉴

![Node.js](https://img.shields.io/badge/Node.js-20%2B-3c873a?style=flat-square&logo=node.js&logoColor=white)
![Vue](https://img.shields.io/badge/Vue-3-42b883?style=flat-square&logo=vue.js&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.10%2B-3776ab?style=flat-square&logo=python&logoColor=white)
![Last Commit](https://img.shields.io/github/last-commit/DX3906-0/qq-farm-bot?style=flat-square)

[项目亮点](#项目亮点) · [快速开始](#快速开始) · [补码守护](#补码守护) · [资源图鉴](#资源图鉴) · [致谢](#致谢)

</div>

QQ Farm Bot 把农场经营、账号管理、活动和图鉴放进同一个 Web 面板。你可以为不同账号安排不同策略，也可以随时接手一块土地、一次收获或一项活动。

在已有农场自动化能力之上，本项目更关注另一件事：**让持续运行和日常维护，也成为自动化的一部分。**

## 项目亮点

### 连接留下，业务继续更新

游戏连接和经营任务分开运行。调整策略、更新业务或重载单个账号时，可以继续使用已有连接，减少重复登录和重新获取登录码的次数。

面板更新与农场运行也彼此独立。换一套界面，正在经营的账号照常工作。

### 一套面板，多种经营节奏

每个账号都有自己的任务、配置和运行状态。日常种植、统一收获、好友互动、活动兑换可以按账号分别安排，切换账号时也能保留各自的浏览位置和筛选条件。

手动操作不必等自动任务走完整轮：已经发出的操作先结束，接下来的步骤把位置让给你。

### 一个轻量守护，补齐最后一公里

服务器负责经营，本机守护负责登录码。当 QQ 账号需要补码时，守护通过 NapCat 获取新的登录码并交回面板，把原来需要来回操作的流程串成一条自动链路。

平时只做轻量检查，需要时才唤醒宿主；任务结束后可以让宿主休眠。笔记本使用电池时，还能切换为节能模式。**农场继续跑，电脑不必一直保持完整客户端常驻。**

### 网络波动，先缓一缓

短暂延迟不必立刻变成重新登录。连接状态和业务状态分别判断，网络不稳定时先降低请求节奏，恢复后继续经营；补码守护也会控制尝试间隔，让恢复过程更平稳。

### 不止是按钮，还有一份可看的农场百科

作物、装扮、藏品、变异效果和活动奖励都有对应图片。变异宝典支持搜索、筛选和系列浏览，土地详情能直接查看生长状态、占地和可执行操作。

资源工具按游戏清单定位原图，把散落的素材整理成可复用的资源库。图鉴不是一串物品编号，而是能认得出、查得到的内容。

## 功能一览

| 模块 | 可以做什么 |
| --- | --- |
| 农场经营 | 种植、施肥、收获、土地升级、统一收获和延迟收获 |
| 多账号 | 分账号策略、独立运行状态、快速切换 |
| 好友互动 | 好友列表、土地查看、帮助与互动任务 |
| 活动中心 | 奶茶经营与兑换、节令小礼、活动进度与奖励 |
| 收藏与图鉴 | 作物、装扮、头像框、铭牌、藏品和变异宝典 |
| 运行管理 | 日志、统计、通知、补码守护与连接状态 |

## 快速开始

### 环境

- Node.js 20+ 与 pnpm 10。
- 面板可在 Windows、Linux 上运行。
- QQ 自动补码守护需要 Windows、Python 3.10+ 和已配置的 NapCat。

### 启动面板

```bash
git clone https://github.com/DX3906-0/qq-farm-bot.git
cd qq-farm-bot
pnpm install
pnpm build:web
```

Linux：

```bash
ADMIN_PORT=3007 pnpm dev:core
```

Windows PowerShell：

```powershell
$env:ADMIN_PORT = "3007"
pnpm dev:core
```

打开 `http://localhost:3007`，登录后添加账号并设置经营策略。首次使用请修改默认管理员密码。

开发界面时，可以单独运行 `pnpm dev:web`。使用 Docker 时，先完成前端构建，再运行 `docker compose up -d --build`。

## 补码守护

守护不是另一套农场。它只处理本机登录与补码，经营任务仍由面板管理。

| 组件 | 分工 |
| --- | --- |
| 网关 | 保持已有游戏连接 |
| 账号任务 | 执行各自的经营计划 |
| 本机守护 | 检查掉线、按需获取登录码、交回面板 |

在 `tools/capture-guard/` 中复制配置示例，填写自己的面板地址、NapCat 配置和账号映射：

```powershell
Copy-Item tools/capture-guard/.napcat-guard-config.json.example tools/capture-guard/.napcat-guard-config.json
python tools/capture-guard/napcat-code-guard.py
```

常用入口：

- `守护-立即启动.bat`：后台启动。
- `守护-安装自启.bat`：设置登录 Windows 后启动。
- `napcat_guard.log`：查看最近检查和补码结果。
- `python napcat-code-guard.py --reset`：清除冷却记录，不停止常驻守护。

如需执行一次补码检查，可在配置完成后运行 `python napcat-code-guard.py --once`。微信账号使用面板扫码流程，不经过 QQ 补码守护。

## 资源图鉴

<div align="center">
  <img src="docs/images/deco-wall.png" alt="装扮图标样例" width="900">
  <br>
  <sub>装扮图标样例。当前资源库还收录了作物、藏品和变异效果。</sub>
</div>

当前配置中，**1058 / 1074 个物品可找到图片，30 个藏品图标已齐**。

图片来源分开记录：

- **官方资源清单**：按清单中的资源名、版本和标识，从官方 CDN 或已保存缓存取得。
- **固定版本上游快照**：来自公开仓库的原始图片，并核对物品身份与文件哈希。
- **既有资源同步**：把项目已有素材补到前后端两套目录，不重新标成官方来源。

逐图信息见 [资源来源索引](core/src/gameConfig/art-resource-sources.json)。采集工具位于 `tools/asset-fetcher/`。

客户端有时会提前携带动物、牧草等资源。收录图片只是完善资源库，不代表相关玩法已经开放。

## 项目结构

```text
core/                   农场业务、连接网关、协议与配置
web/                    Vue 面板与静态资源
tools/capture-guard/    Windows 补码守护
tools/asset-fetcher/    资源采集与审计工具
docs/                   架构说明与资源示例
```

更详细的实现介绍见 [架构说明](docs/architecture.md)。

## 参与开发

欢迎提交问题、改进界面或补充活动适配。反馈时附上复现步骤和已去除账号、登录码的日志即可。

```bash
pnpm build:web
pnpm -C core test
```

地址、口令、账号映射保存在本地配置或环境变量中，不提交到仓库。图片补充请保留原图和来源信息。

## 致谢

本项目的架构基线与核心业务逻辑来自 [muyuewang/qq-farm-bot-404](https://github.com/muyuewang/qq-farm-bot-404)，活动与协议适配参考了 [liyangpengs/qq-farm-bot](https://github.com/liyangpengs/qq-farm-bot)。资源补充参考 [Xb-Fishing/qq-farm-evolution](https://github.com/Xb-Fishing/qq-farm-evolution) 和 [chengleier/qq-farm-bot](https://github.com/chengleier/qq-farm-bot)，逐文件出处保留在来源索引中。

连接与任务分离、本机按需补码守护、运行恢复和资源整理，是本项目在这些基础上的持续扩展。

本项目自行编写的代码适用 [MIT License](LICENSE)；继承代码与游戏美术资源按各自权利归属处理。仅供学习研究，请遵守游戏用户协议。
