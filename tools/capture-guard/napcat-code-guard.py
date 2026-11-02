# -*- coding: utf-8 -*-
"""
napcat-code-guard.py — 本机 NapCat 直取农场 code，自动补齐掉线的 farm QQ 账号（静默守护）

替代旧的 farm-capture-daemon.py 抓包路径（启代理+开农场小程序+OCR 点号）。
新方案 = 本机 NapCat 宿主 + qq-miniapp-openauth 插件，纯 HTTP 取码，无窗口、无代理、秒级。

核心能力:
  1. 每 POLL 秒登录 farm 面板，检查 QQ 平台账号是否掉线 (running=false)；
  2. 发现掉线账号时:
       a. 若 NapCat 当前登录号 != 目标号 → SetQuickLoginQQ(目标号) 写 autoLogin
          → 优雅停宿主 → 重新拉起（autoLogin 生效自动登录目标号）。【2026-09-08 弃用
          RestartNapCat：其在 QQ 9.9.33+NapCat 4.18.19 下强杀进程树致 GPU/Network
          崩、宿主死透，改走宿主外部门重启】；
       b. loginWithAppId 取新 code；
       c. farm 建 localOnly flow → inject{code,openId,gid} → complete → 拉起账号；
  3. 断网/面板不可达 / NapCat 不可达 → 精确离线（按类型不同重试间隔），连接恢复自动补扫；
  4. 自动清内存（标准版，独立后台线程，不阻塞主轮询）:
        L1 可用物理内存 < STANDBY_MIN_GB → 交还 Windows Standby 缓存；
        L2 每 CLEAN_FLUSH_HOUR 小时周期冲刷一次，保证可用内存健康。
        （不接入 L3 显卡软重载，避免打断正在用 GPU 的工作。）
  5. 用户日常 QQ 客户端感知:
        识别"非 NapCat 宿主的用户 QQ 实例"（宿主=监听 6099 的进程；与之同启动批次的
        子进程视为宿主子进程，不同批次的 QQ.exe 判为用户日常 QQ）。
        USER_QQ_POLICY:
          normal = 照常补码，仅日志记录（用户 2026-09-08 拍板）；
          skip   = 检测到用户 QQ 即跳过补码（备用，防主数据目录被占用时硬碰）。
  6. 单实例（napcat_guard.pid），日志 napcat_guard.log（>2MB 截断）。

用法:
  pythonw.exe napcat-code-guard.py            # 静默常驻
  python.exe  napcat-code-guard.py --once     # 前台跑一轮完整动作并打印（调试）
  python.exe  napcat-code-guard.py --stop     # 停止常驻实例
"""
import ctypes
import ctypes.wintypes as wt
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

# ---- 默认配置（可被 .napcat-guard-config.json 覆盖） ----
# 所有环境相关的值都从环境变量读取，仓库里只保留占位符与示例。
# 部署时把它们写进 .env / 系统环境变量 / .napcat-guard-config.json 即可，
# 不要把真实地址和口令提交回仓库。
PANEL = os.environ.get('FARM_PANEL', 'http://127.0.0.1:3007')
USER = os.environ.get('FARM_PANEL_USER', 'admin')
PASS = os.environ.get('FARM_PANEL_PASS', '')
NAPCAT_BASE = os.environ.get('NAPCAT_BASE', 'http://127.0.0.1:6099')
NAPCAT_WEBUI_PWD = os.environ.get('NAPCAT_WEBUI_PWD', '')   # 不含 .napcat 后缀，代码自动 sha256 拼接
NAPCAT_PLUGIN_TOKEN = os.environ.get('NAPCAT_PLUGIN_TOKEN', '')
APP_ID = '1112386029'
# 账号 ID → QQ 号（uin）。按需替换为你自己的映射；键是 farm 面板里的账号 id。
ACCOUNT_UIN = {
    '1': int(os.environ.get('FARM_ACCOUNT_1_UIN', '0') or 0),
    '10': int(os.environ.get('FARM_ACCOUNT_10_UIN', '0') or 0),
}
# 去掉未配置的项，避免用 0 去切号
ACCOUNT_UIN = {k: v for k, v in ACCOUNT_UIN.items() if v}

# ---- 补完码即"让出"指定账号（把 NapCat 登录态还给用户）----
# 背景：farm 端账号在线是靠服务端会话维持的，注入 code 后即 running=True，
# 并不需要本机 NapCat 持续登录该号。因此补完码后应把 NapCat 切走，
# 释放该 QQ 号的登录态，让用户能用自己的 QQ 客户端正常登录聊天/传文件。
# releaseAfterFix: 需要"补完即让出"的 farm 账号 id 列表（填你自己的日常号 id）
# releaseTargetUin: 让出后 NapCat 驻留到哪个 uin（填纯 bot 号的 QQ 号）
RELEASE_AFTER_FIX = [x for x in os.environ.get('FARM_RELEASE_AFTER_FIX', '').split(',') if x.strip()]
RELEASE_TARGET_UIN = int(os.environ.get('FARM_RELEASE_TARGET_UIN', '0') or 0)

# 记录"跳过补码"日志的上次时间，避免每轮刷屏（每小时最多记一次）
_last_skip_log = {}
# 去噪：最近一次"无掉线账号"打日志的时刻（让每轮 120s 的"本轮无掉线账号"不再刷屏，
# 仅在 首次空闲 / 空闲超长 时提醒一次，避免日志填满）
_last_no_drop_log = [0.0]

# ---- 暂停补码的账号（把这些 farm 账号完全让给用户使用）----
# 用途：当某个 QQ 号用户要亲自登录聊天/传文件时，把它从自动补码链路里摘掉，
# 守护不再为它切号、不再重启宿主（避免黑窗频现 + 避免与用户客户端互踢）。
# 填 farm 账号 id 列表，例如 ["1"] 表示罗辑号完全归用户，farm 不再自动补它。
SKIP_ACCOUNT_IDS = ['1']

DIR = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(DIR, 'napcat_guard.log')
PID_FILE = os.path.join(DIR, 'napcat_guard.pid')
CONFIG_FILE = os.path.join(DIR, '.napcat-guard-config.json')

POLL = 120              # 正常轮询间隔（秒）
NET_RETRY = 20          # 面板/断网重试间隔（秒）
NAPCAT_RETRY = 30       # NapCat 不可达重试间隔（秒）
LOG_MAX = 2 * 1024 * 1024

# ---- 风控熔断（2026-09-09 三账号被封 7 天的教训）----
# 铁律：任何异常情况下都不得出现"高频补码 / 高频切号"。切号=强杀 QQ 宿主+重启，
# 是重风控动作；补码失败后无限重试就是自杀。健康基线参考：09-08 补码仅 11 次/天。
RATE_MAX_PER_ACCOUNT_HOUR = 4      # 单账号每小时内补码尝试上限
RATE_WINDOW = 3600.0               # 上述统计窗口（秒）
MIN_FIX_INTERVAL = 600.0           # 同一账号两次补码之间的最小间隔（秒）
BACKOFF_STEPS = [300.0, 900.0, 1800.0, 3600.0]   # 连续失败退避阶梯（5/15/30/60 分钟）
SWITCH_FAIL_TO_MANUAL = 2          # 连续切号失败 N 次 → 标记"需人工扫码"并不再重试
STORM_WINDOW = 600.0               # 全局风暴窗口（秒）
STORM_MAX_TRY = 6                  # 窗口内补码尝试上限（成功+失败都计）
STORM_PAUSE = 3600.0               # 触发风暴后整体暂停（秒）
PUSHPLUS_URL = 'http://www.pushplus.plus/send/6d26a43bb7b544c0acfa6a8815bb90e1'  # 置空则关闭推送
CIRCUIT_FILE = os.path.join(DIR, '.napcat-guard-circuit.json')

# ---- 宿主自愈（NapCat webui 不可达时自动拉起宿主）----
AUTO_RELAUNCH_HOST = True        # 总开关：宿主失联自动重拉起
# NapCat 自启 bat（与 napcat-autostart.bat 一致，纯 ASCII，需管理员注入）
NAPCAT_AUTOSTART_BAT = r'D:\小工具\_napcat\napcat\napcat-autostart.bat'
NAPCAT_QQ_PATH = r'C:\Program Files\Tencent\QQNT\QQ.exe'
NAPCAT_DIR = r'D:\小工具\_napcat\napcat'
NAPSA_LAUNCH_COOLDOWN = 150.0    # 距上次拉起至少间隔秒数（避免频繁重试）

# ---- 内存管控（标准版） ----
MEM_CTRL = True
STANDBY_MIN_AVAIL = 1.5 * (1024 ** 3)      # 可用 < 1.5GB 触发 L1
CLEAN_FLUSH_HOUR = 2.0                     # L2 每 2h 冲刷一次

# ---- 用户日常 QQ 感知 ----
USER_QQ_POLICY = 'normal'
USER_QQ_WARN_REPEAT = 360
HOST_PORT = 6099

# ---- QQ 扫码登录中转（2026-09-16）----
# 面板上「QQ 扫码」标签页建的扫码任务，由本守护轮询领取：
#   出二维码 → 等用户手机扫码 → loginWithAppId 换农场 code → 回填服务器 → 面板自动建号。
# 服务器侧只做任务中转（本机 NapCat 在 NAT 后，服务器内存也放不下 NapCat）。
# RELAY_TOKEN 必须与环境变量 NAPCAT_RELAY_TOKEN（或服务端同名配置）一致。
RELAY_ENABLED = True
RELAY_URL = PANEL                       # 默认与面板同源
RELAY_TOKEN = os.environ.get('NAPCAT_RELAY_TOKEN', '')
RELAY_POLL = 3.0                        # 扫码任务处理中/扫码等待时的心跳间隔（秒，需灵敏）
RELAY_IDLE_POLL = 30.0                  # 空闲心跳间隔（秒）：无扫码任务时，避免每 3s 刷一次面板
                                        # 背景：relay_thread 原每 3s 发一次 heartbeat≈28800 次/天，
                                        # 全部打到远端面板造成 CF 海量短连接。
                                        # 空闲时降到 30s，日请求≈2900，扫码仍保持 3s 灵敏。
RELAY_SCAN_TIMEOUT = 150.0              # 等待用户扫码的最长时间（秒）
RELAY_RESTORE_RESIDENT = True            # 扫码完成后把宿主切回驻留号（避免与用户客户端互踢）

# ---- 宿主休眠 / 按需唤（2026-09-20，省内存） ----
# 背景：本机 NapCat 宿主（QQ.exe 全家族，含 Network/GPU/Renderer 子进程）常驻约 200MB，
# 而 farm 账号在线由服务器端 gateway 会话维持，本机宿主只负责"掉线补码 + 扫码中转"两个动作。
# 平时无任务时宿主空转纯耗内存。故引入"休眠模式"：守护平时只做纯 HTTP 面板轮询（不启宿主），
# 一旦检测到 QQ 号掉线需补码 / 收到扫码任务才临时拉起宿主，办完活并空闲超过
# HOST_IDLE_STOP_MIN 分钟自动停止宿主，把 ~200MB 还给系统。
HOST_HIBERNATE = True                   # 总开关：宿主休眠模式开/关。True=平时不启宿主按需唤
HOST_IDLE_STOP_MIN = 10.0               # 宿主空闲 N 分钟后自动停止（补码/扫码完成后无新任务）
                                        # 防止刚冷启动又立刻被杀，避免频繁启停拉锯
HOST_WAKE_COOLDOWN = 20.0               # 冷唤醒宿主的最小间隔（秒），防极端情况高频启停
GUARD_VERSION = '2026-10-15'

# ---- 电源感知节能（2026-10-15）----
# 诉求：插电时正常监测（120s 轮询 + 按需补码/扫码）；仅电池供电时为了省电，
# 守护"轻挂起"——主循环拉长到 BATTERY_POLL 秒才醒一次（几乎不耗 CPU/网络），
# 且绝不拉起宿主、不做补码/切号（切号=强杀 QQ+重启，是重风控且耗电动作）。
# 插电后无需人工干预，守护下一轮醒来检测到 AC 即自动恢复 120s 正常轮询。
# 注意：账号在线由服务器端 gateway 会话维持，与本机守护是否挂起无关；
# 电池模式只是"本机不再自动补码"，账号该在线仍在线，掉线则等插电后再补。
POWER_SAVE_ON_BATTERY = True            # 总开关：电池供电时是否节能挂起
BATTERY_POLL = 1800.0                   # 电池挂起时的唤醒间隔（秒，默认 30min 检测一次电源）
BATTERY_PROBE = 30.0                    # 电池挂起期间探测电源的分片间隔（秒）——插电后最长延迟此值即恢复

# 清理 Windows Standby 缓存
PS_EMPTY_STANDBY = (
    'Add-Type -TypeDefinition @"'
    'using System;using System.Runtime.InteropServices;'
    'public class ES{[DllImport("ntdll.dll")]'
    'public static extern int NtSetSystemInformation(int a,int b,int c);};"@;'
    '[ES]::NtSetSystemInformation(0x57,0,0)|Out-Null'
)

ONCE = '--once' in sys.argv
STOP = '--stop' in sys.argv
k = ctypes.windll.kernel32


# ---------- 日志 / 配置 ----------
def log(msg):
    line = '[{}] {}'.format(time.strftime('%m-%d %H:%M:%S'), msg)
    if ONCE:
        print(line)
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > LOG_MAX:
            os.remove(LOG)
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


def load_config():
    global PANEL, USER, PASS, NAPCAT_BASE, NAPCAT_WEBUI_PWD, NAPCAT_PLUGIN_TOKEN
    global APP_ID, ACCOUNT_UIN
    global POLL, NET_RETRY, NAPCAT_RETRY, MEM_CTRL, STANDBY_MIN_AVAIL, CLEAN_FLUSH_HOUR
    global USER_QQ_POLICY, USER_QQ_WARN_REPEAT
    global AUTO_RELAUNCH_HOST, NAPCAT_AUTOSTART_BAT, NAPCAT_QQ_PATH, NAPCAT_DIR, NAPSA_LAUNCH_COOLDOWN
    global RELEASE_AFTER_FIX, RELEASE_TARGET_UIN, SKIP_ACCOUNT_IDS
    global RATE_MAX_PER_ACCOUNT_HOUR, RATE_WINDOW, MIN_FIX_INTERVAL, BACKOFF_STEPS
    global SWITCH_FAIL_TO_MANUAL, STORM_WINDOW, STORM_MAX_TRY, STORM_PAUSE, PUSHPLUS_URL
    global RELAY_ENABLED, RELAY_URL, RELAY_TOKEN, RELAY_POLL, RELAY_IDLE_POLL, RELAY_SCAN_TIMEOUT, RELAY_RESTORE_RESIDENT
    global HOST_HIBERNATE, HOST_IDLE_STOP_MIN, HOST_WAKE_COOLDOWN
    global POWER_SAVE_ON_BATTERY, BATTERY_POLL, BATTERY_PROBE
    if not os.path.exists(CONFIG_FILE):
        return
    try:
        cfg = json.load(open(CONFIG_FILE, encoding='utf-8'))
        PANEL = cfg.get('panel', PANEL).rstrip('/')
        USER = cfg.get('user', USER)
        PASS = cfg.get('pass', PASS)
        NAPCAT_BASE = cfg.get('napcatBase', NAPCAT_BASE).rstrip('/')
        NAPCAT_WEBUI_PWD = str(cfg.get('napcatSecret', NAPCAT_WEBUI_PWD))
        NAPCAT_PLUGIN_TOKEN = str(cfg.get('pluginToken', NAPCAT_PLUGIN_TOKEN))
        APP_ID = str(cfg.get('appId', APP_ID))
        if isinstance(cfg.get('accounts'), dict):
            ACCOUNT_UIN = {str(x): v
                           for x, v in cfg['accounts'].items()}
        POLL = int(cfg.get('poll', POLL))
        NET_RETRY = int(cfg.get('netRetry', NET_RETRY))
        NAPCAT_RETRY = int(cfg.get('napcatRetry', NAPCAT_RETRY))
        MEM_CTRL = bool(cfg.get('memCtrl', MEM_CTRL))
        STANDBY_MIN_AVAIL = float(cfg.get('StandbyMinGb', STANDBY_MIN_AVAIL / (1024 ** 3))) * (1024 ** 3)
        CLEAN_FLUSH_HOUR = float(cfg.get('cleanFlushHour', CLEAN_FLUSH_HOUR))
        USER_QQ_POLICY = str(cfg.get('userQqPolicy', USER_QQ_POLICY))
        USER_QQ_WARN_REPEAT = int(cfg.get('userQqWarnRepeat', USER_QQ_WARN_REPEAT))
        AUTO_RELAUNCH_HOST = bool(cfg.get('autoRelaunchHost', AUTO_RELAUNCH_HOST))
        NAPCAT_AUTOSTART_BAT = str(cfg.get('napcatAutostartBat', NAPCAT_AUTOSTART_BAT))
        NAPCAT_QQ_PATH = str(cfg.get('napcatQqPath', NAPCAT_QQ_PATH))
        NAPCAT_DIR = str(cfg.get('napcatDir', NAPCAT_DIR))
        NAPSA_LAUNCH_COOLDOWN = float(cfg.get('napcatLaunchCooldown', NAPSA_LAUNCH_COOLDOWN))
        if isinstance(cfg.get('releaseAfterFix'), list):
            RELEASE_AFTER_FIX = [str(x) for x in cfg['releaseAfterFix']]
        if cfg.get('releaseTargetUin') is not None:
            RELEASE_TARGET_UIN = int(cfg['releaseTargetUin'])
        if isinstance(cfg.get('skipAccountIds'), list):
            SKIP_ACCOUNT_IDS = [str(x) for x in cfg['skipAccountIds']]
        RATE_MAX_PER_ACCOUNT_HOUR = int(cfg.get('rateMaxPerHour', RATE_MAX_PER_ACCOUNT_HOUR))
        RATE_WINDOW = float(cfg.get('rateWindow', RATE_WINDOW))
        MIN_FIX_INTERVAL = float(cfg.get('minFixInterval', MIN_FIX_INTERVAL))
        SWITCH_FAIL_TO_MANUAL = int(cfg.get('switchFailToManual', SWITCH_FAIL_TO_MANUAL))
        STORM_WINDOW = float(cfg.get('stormWindow', STORM_WINDOW))
        STORM_MAX_TRY = int(cfg.get('stormMaxTry', STORM_MAX_TRY))
        STORM_PAUSE = float(cfg.get('stormPause', STORM_PAUSE))
        if 'pushplusUrl' in cfg:
            PUSHPLUS_URL = str(cfg.get('pushplusUrl', ''))
        if isinstance(cfg.get('backoffSteps'), list) and cfg['backoffSteps']:
            BACKOFF_STEPS = [float(x) for x in cfg['backoffSteps']]
        RELAY_ENABLED = bool(cfg.get('relayEnabled', RELAY_ENABLED))
        RELAY_URL = str(cfg.get('relayUrl', RELAY_URL)).rstrip('/')
        RELAY_TOKEN = str(cfg.get('relayToken', RELAY_TOKEN))
        RELAY_POLL = float(cfg.get('relayPoll', RELAY_POLL))
        RELAY_IDLE_POLL = float(cfg.get('relayIdlePoll', RELAY_IDLE_POLL))
        RELAY_SCAN_TIMEOUT = float(cfg.get('relayScanTimeout', RELAY_SCAN_TIMEOUT))
        RELAY_RESTORE_RESIDENT = bool(cfg.get('relayRestoreResident', RELAY_RESTORE_RESIDENT))
        HOST_HIBERNATE = bool(cfg.get('hostHibernate', HOST_HIBERNATE))
        HOST_IDLE_STOP_MIN = float(cfg.get('hostIdleStopMin', HOST_IDLE_STOP_MIN))
        HOST_WAKE_COOLDOWN = float(cfg.get('hostWakeCooldown', HOST_WAKE_COOLDOWN))
        POWER_SAVE_ON_BATTERY = bool(cfg.get('powerSaveOnBattery', POWER_SAVE_ON_BATTERY))
        BATTERY_POLL = float(cfg.get('batteryPoll', BATTERY_POLL))
        BATTERY_PROBE = float(cfg.get('batteryProbe', BATTERY_PROBE))
        log('已加载配置: {}'.format(CONFIG_FILE))
    except Exception as e:
        log('配置加载失败，用默认: {}'.format(e))


# ---------- 电源感知（2026-10-15）----------
class _SYSTEM_POWER_STATUS(ctypes.Structure):
    _fields_ = [
        ('ACLineStatus', ctypes.c_byte),        # 0=电池, 1=交流电, 255=未知
        ('BatteryFlag', ctypes.c_byte),
        ('BatteryLifePercent', ctypes.c_byte),
        ('SystemStatusFlag', ctypes.c_byte),
        ('BatteryLifeTime', ctypes.c_ulong),
        ('BatteryFullLifeTime', ctypes.c_ulong),
    ]


def _power_status():
    """返回 (ac_ok, percent)：ac_ok=True 表示插电/交流供电；percent=-1 未知。

    用 kernel32.GetSystemPowerStatus 读电源状态，纯本地调用、零网络开销。
    读失败（极罕见）时返回 ac_ok=True（视为插电），保证不误伤正常监测。
    """
    try:
        s = _SYSTEM_POWER_STATUS()
        if not ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(s)):
            return True, -1
        ac = (s.ACLineStatus == 1)
        pct = s.BatteryLifePercent if s.BatteryLifePercent != 255 else -1
        return ac, pct
    except Exception:
        return True, -1


def on_battery():
    """当前是否"仅电池供电"（需要节能挂起）。

    POWER_SAVE_ON_BATTERY 关闭时恒返回 False（不节能）。
    桌面机/无电池设备 ACLineStatus 通常恒为 1，不受影响。
    """
    if not POWER_SAVE_ON_BATTERY:
        return False
    ac, _ = _power_status()
    return not ac


# ---------- 进程 / 命令 ----------
def _proc_alive(pid):
    try:
        h = k.OpenProcess(0x1000, False, int(pid))
        if h:
            k.CloseHandle(h)
            return True
    except Exception:
        pass
    return False


def exec_shell(cmd, timeout=30, env=None):
    """跑子进程返回 stdout 文本。bytes 模式抓取，兼容 Windows 多编码输出
    （UTF-8 BOM / gbk），避免 text=True 被默认 codec 卡死。失败返回 ''。"""
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout,
                           cwd=DIR, env=env, creationflags=0x08000000)
        raw = r.stdout or b''
        return _decode_bytes(raw).strip('\n')
    except Exception as e:
        return str(e)


def _decode_bytes(raw):
    """优先 utf-8-sig（去 BOM），失败回退 gbk 再回退 latin-1，总返回 str。"""
    try:
        return raw.decode('utf-8-sig')
    except Exception:
        try:
            return raw.decode('gbk', 'ignore')
        except Exception:
            return raw.decode('latin-1', 'ignore')


def clean_env():
    keep = ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP',
            'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES',
            'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'COMPUTERNAME', 'USERNAME',
            'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'OS', 'SYSTEMDRIVE',
            'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'SESSIONNAME',
            'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'PROCESSOR_IDENTIFIER',
            'ALLUSERSPROFILE']
    e = {x: os.environ[x] for x in keep if x in os.environ}
    e.setdefault('SYSTEMROOT', r'C:\Windows')
    e.setdefault('TEMP', os.environ.get('TEMP', r'C:\Windows\Temp'))
    e.setdefault('TMP', e['TEMP'])
    return e


# ---------- 单实例 / 停止 ----------
def stop_daemon():
    pid = 0
    if os.path.exists(PID_FILE):
        try:
            pid = int(open(PID_FILE).read().strip() or 0)
        except Exception:
            pid = 0
    if pid and _proc_alive(pid):
        _safe_kill(pid)
        log('已停止守护 pid={}'.format(pid))
        print('stopped pid={}'.format(pid))
    else:
        print('no running daemon')
    sys.exit(0)


def _terminate_pid(pid):
    """强杀单个进程，**不产生任何子进程**。

    ⚠️ 绝不能用 `os.system('taskkill ...')`：本守护由 pythonw 托管（GUI 子系统、
    自身没有控制台），`os.system` 会拉起 `cmd.exe /c taskkill`，而 cmd 必须给自己
    `AllocConsole()`；Win11 又把新控制台委派给 Windows Terminal → 每杀一个进程就
    弹一个黑框（实测：停 6 个宿主进程 = 6 个 WT 黑框，10-29 定位）。
    改用 `OpenProcess+TerminateProcess` 后是纯内核调用，零子进程、零窗口。
    """
    try:
        PROCESS_TERMINATE = 0x0001
        # ⚠️ 必须显式声明原型：kernel32 默认 restype 是 c_int，64 位下会把
        # OpenProcess 返回的 HANDLE(指针) 截断成 32 位，随后 CloseHandle 用错句柄
        # （句柄泄漏 + 偶发杀不掉）。进程级只设一次即可。
        if not getattr(_terminate_pid, '_proto_ok', False):
            k.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
            k.OpenProcess.restype = ctypes.c_void_p
            k.TerminateProcess.argtypes = [ctypes.c_void_p, wt.UINT]
            k.TerminateProcess.restype = wt.BOOL
            k.CloseHandle.argtypes = [ctypes.c_void_p]
            k.CloseHandle.restype = wt.BOOL
            _terminate_pid._proto_ok = True
        h = k.OpenProcess(PROCESS_TERMINATE, False, int(pid))
        if not h:
            return False
        try:
            return bool(k.TerminateProcess(h, 1))
        finally:
            k.CloseHandle(h)
    except Exception:
        return False


def _safe_kill(pid):
    _terminate_pid(pid)


def handle_singleton():
    pid = 0
    if os.path.exists(PID_FILE):
        try:
            pid = int(open(PID_FILE).read().strip() or 0)
        except Exception:
            pid = 0
    if pid and _proc_alive(pid):
        log('已有守护实例 (pid={})'.format(pid))
        print('already running pid={}'.format(pid))
        sys.exit(0)
    try:
        with open(PID_FILE, 'w') as f:
            f.write(str(os.getpid()))
    except Exception as e:
        log('写 pid 失败: {}'.format(e))


# ---------- HTTP ----------
# 强制绕过系统/环境代理（2026-10-14 修复）：本机开着 Clash 等代理
# （WinINET 127.0.0.1:7897 / 环境变量 HTTP_PROXY=127.0.0.1:7899），裸
# urllib.request.urlopen 会继承它们，导致对远端面板的请求
# 的请求被代理拦截返回 502，守护误判「面板不可达」而整条补码链路瘫痪。
# 面板与 NapCat webui 都是直连可达的（实测直连 200 / 0.33s），故一律 no-proxy。
_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http_(request, timeout=20):
    try:
        with _NO_PROXY_OPENER.open(request, timeout=timeout) as resp:
            return True, resp.status, resp.read().decode('utf-8', 'ignore')
    except urllib.error.HTTPError as e:
        return False, e.code, (e.read() or b'').decode('utf-8', 'ignore')
    except Exception as e:
        return False, 0, str(e)


def get(url, headers=None, timeout=30):
    return http_(urllib.request.Request(url, headers=headers or {}), timeout)


def post_json(url, body, headers=None, timeout=20):
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(url, data=data,
                                 headers={'Content-Type': 'application/json', **(headers or {})})
    return http_(req, timeout=timeout)


def json_body(text):
    try:
        return json.loads(text)
    except Exception:
        return None


# ---------- NapCat ----------
# webui 登录端点了 loginRate 限速（窗口内最多 N 次 login），无脑每次调 login 会把
# 整条补码链路撞爆（2026-09-18 实测：按 120s 轮询 + 切号期间猛调 login，一次就 401 限速，
# 导致 release 让出失败、切号失效）。因此对 /api/auth/login 的结果做短 TTL 缓存：
#   1) 缓存存在且 fresh(<45s) → 直接复用，不重复 login（大幅压 login 频率）
#   2) 超时 → 重新登录；拿到新 Credential 更新缓存
#   3) 登录失败/限速 → 不污染缓存，退回旧值（旧值窗口极短仍大概率有效）
# 该缓存是纯本地读取、不动登录态，是防过高/无谓 API 调用（降低风控面）的合理优化。
_napcat_cred_cache = ''          # 最近一次有效 Credential
_napcat_cred_ts = 0.0            # 缓存写入时间（秒）
NAPCAT_CRED_TTL = 45.0           # Credential 短缓存 TTL（秒）
def napcat_cred():
    global _napcat_cred_cache, _napcat_cred_ts
    now = time.time()
    # 缓存命中且新鲜 → 直接复用
    if _napcat_cred_cache and (now - _napcat_cred_ts) < NAPCAT_CRED_TTL:
        return _napcat_cred_cache
    hh = hashlib.sha256((NAPCAT_WEBUI_PWD + '.napcat').encode()).hexdigest()
    ok, st, txt = post_json('{}/api/auth/login'.format(NAPCAT_BASE), {'hash': hh})
    if ok and st == 200:
        j = json_body(txt)
        c = (j.get('data') or {}).get('Credential', '') if j else ''
        if c:
            _napcat_cred_cache = c
            _napcat_cred_ts = now
            return c
    # 登录失败/限速：不污染缓存，若旧值仍存在则退回它（大概率仍在有效期），否则返回空
    if _napcat_cred_cache:
        return _napcat_cred_cache
    return ''


def napcat_online_uin():
    cred = napcat_cred()
    if not cred:
        return None
    ok, st, txt = post_json('{}/api/QQLogin/GetQQLoginInfo'.format(NAPCAT_BASE), {},
                            {'Authorization': 'Bearer ' + cred})
    if not ok or st != 200:
        return None
    j = json_body(txt)
    return (j or {}).get('data', {}).get('uin') or None


def napcat_set_autologin(uin):
    cred = napcat_cred()
    if not cred:
        return False
    ok, st, _ = post_json('{}/api/QQLogin/SetQuickLoginQQ'.format(NAPCAT_BASE),
                          {'uin': int(uin)}, {'Authorization': 'Bearer ' + cred})
    return ok and st == 200


def napcat_restart():
    cred = napcat_cred()
    if not cred:
        return False
    ok, st, _ = post_json('{}/api/QQLogin/RestartNapCat'.format(NAPCAT_BASE), {},
                          {'Authorization': 'Bearer ' + cred})
    return ok and st == 200


def napcat_wait_uin(uin, timeout=180, sleep=5):
    end = time.time() + timeout
    while time.time() < end:
        cur = napcat_online_uin()
        if cur is not None and str(cur) == str(uin):
            return True
        time.sleep(sleep)
    return False


def napcat_fetch_code():
    ok, st, txt = post_json('{}/plugin/qq-miniapp-openauth/api/miniapp'.format(NAPCAT_BASE),
                            {'appId': APP_ID, 'operation': 'loginWithAppId'},
                            {'Authorization': 'Bearer ' + NAPCAT_PLUGIN_TOKEN},
                            timeout=40)
    if not ok or st != 200:
        return ''
    j = json_body(txt) or {}
    code = j.get('code') or (j.get('result') or {}).get('result') or ''
    return str(code) if code else ''


def napcat_alive():
    ok, st, _ = post_json('{}/api/auth/login'.format(NAPCAT_BASE), {'hash': 'probe'})
    return ok


_last_launch_ts = [0.0]   # 上次拉起宿主时间戳（秒）
_hide_console_pid = [0]   # 常驻 NapCat 控制台隐藏监控的进程 pid（0=未运行）


def _read_autologin_account():
    """读 webui.json 里的 autoLoginAccount（守护的 SetQuickLoginQQ 会持续维护它）。
    用于 launch_napcat_host 未显式给 quick_uin 时回落到"上次切到的号"。读不到返回 None。"""
    try:
        cfg = os.path.join(NAPCAT_DIR, 'config', 'webui.json')
        if not os.path.exists(cfg):
            return None
        with open(cfg, encoding='utf-8') as f:
            v = str((json.load(f) or {}).get('autoLoginAccount') or '').strip()
        return v or None
    except Exception:
        return None


def _startupinfo_hidden():
    """构造 STARTUPINFO：STARTF_USESHOWWINDOW + SW_HIDE。

    让被拉起 console 子系统的进程（NapCatWinBootMain.exe → QQ.exe 宿主）在
    **一出生即隐藏**，而非出生后由外部 0.02s 扫描去藏——从源头掐断黑框闪现与
    抢焦点。副进程 CREATE_NO_WINDOW 仍保留，双保险。返回 SW_HIDE 版 STARTUPINFO 或 None。"""
    try:
        import subprocess as _sp
        si = _sp.STARTUPINFO()
        si.dwFlags = _sp.STARTF_USESHOWWINDOW
        si.wShowWindow = 0  # SW_HIDE
        return si
    except Exception:
        return None


def launch_napcat_host(force=True, quick_uin=None):
    """NapCat webui 不可达时，按 napcat-autostart 方式拉起宿主（QQ.exe 注入 NapCat）。

    quick_uin: 拉起时希望**快捷登录（免扫码）**的 QQ 号。
    ⭐ 为什么必须显式传（2026-10-28 实测定位的时序缺陷）：
      NapCat 取自动登录号在 napcat.mjs:70078
        `const f = process.env.NAPCAT_QUICK_ACCOUNT || Et.getAutoLoginAccount()`
      但它的**触发条件**在 napcat.mjs:82209 是
        `(NAPCAT_QUICK_ACCOUNT || getQQQuickLoginList().length > 0 || ...) && runWebUiConfigQuickFunction()`
      而 getQQQuickLoginList() 要等更靠后的 `getLoginList().then(...)` 才被填充，
      所以**冷启动首次时列表为空 → 只写 webui.json 的 autoLoginAccount 根本不会被执行**，
      表现为「宿主已起但 online_uin=None，等 180s 超时 → 判切号失败 → 熔断」。
      显式设 NAPCAT_QUICK_ACCOUNT 是环境变量路径，在条件判断里优先级最高，可绕过该缺陷。
    前提：该号必须已在本机 QQ 客户端登录过——NapCat 的快捷登录票据与用户客户端
    共用同一套 `Documents\\Tencent Files`，所以用户登录日常号后 NapCat 即可免扫码登录，
    取完码再由 releaseAfterFix 立刻让出，不影响用户日常使用。

    需管理员权限（asInvoker 注入 Program Files）。使用 detached 后台进程，不阻塞本守护。
    返回 True=已尝试拉起。带冷却：距上次拉起 < NAPSA_LAUNCH_COOLDOWN 秒则跳过
    （除非 force=True —— 切号路径必须立即拉起，不受冷却限制，也不受 AUTO_RELAUNCH_HOST 总开关约束）。
    电池供电（节能挂起）时一律拒绝拉起（连 force 也不行）——省电且避免重风控动作。"""
    if on_battery():
        log('  [节能] 电池供电，拒绝拉起宿主（插电后自动恢复）')
        return False
    if not force and not AUTO_RELAUNCH_HOST:
        return False
    now = time.time()
    if not force and now - _last_launch_ts[0] < NAPSA_LAUNCH_COOLDOWN:
        return False
    _last_launch_ts[0] = now
    if not os.path.exists(NAPCAT_QQ_PATH):
        log('  宿主自愈: QQ.exe 不存在 {}，跳过'.format(NAPCAT_QQ_PATH))
        return False
    inject = os.path.join(NAPCAT_DIR, 'NapCatWinBootHook.dll')
    main = os.path.join(NAPCAT_DIR, 'napcat.mjs')
    load = os.path.join(NAPCAT_DIR, 'loadNapCat.js')
    if not all(os.path.exists(x) for x in (inject, main, load)):
        log('  宿主自愈: NapCat 组件缺失(NapCatWinBootHook.dll/napcat.mjs/loadNapCat.js)，跳过')
        return False
    env = os.environ.copy()
    env['NAPCAT_PATCH_PACKAGE'] = os.path.join(NAPCAT_DIR, 'qqnt.json')
    env['NAPCAT_LOAD_PATH'] = load
    env['NAPCAT_INJECT_PATH'] = inject
    env['NAPCAT_LAUNCHER_PATH'] = os.path.join(NAPCAT_DIR, 'NapCatWinBootMain.exe')
    env['NAPCAT_MAIN_PATH'] = 'D:/小工具/_napcat/napcat/napcat.mjs'  # 正斜杠，匹配 loadNapCat.js
    # ⭐ 显式指定快捷登录号：绕过 getQQQuickLoginList() 冷启动为空导致的"自动登录不触发"。
    # 未显式传入时回落到 webui.json 的 autoLoginAccount（守护的 SetQuickLoginQQ 一直在维护它），
    # 与"上次切到哪个号"保持一致，避免自愈拉起后登录到意外的号。
    _quick = str(quick_uin) if quick_uin else _read_autologin_account()
    if _quick:
        env['NAPCAT_QUICK_ACCOUNT'] = _quick
    try:
        # 关键顺序：先确保「常驻隐藏监控」就绪，再设宿主（消除"监控→拉起"之间的
        # 空窗，让黑框刚出现就被压住）。单类，不重复多个镜像实例。
        _ensure_hide_console()
        # 主动压一轮（拉起飞前把可能残留的旧宿主控制台也压掉）
        _hide_now()
        # 源头抑制（2026-09-28，黑框根治）：
        #   NapCatWinBootMain.exe 是 console 子系统程序，CREATE_NO_WINDOW 只能管
        #   直接子进程继承,管不住它自己启动时分配的宿主控制台。追加
        #   STARTF_USESHOWWINDOW + STARTF_USESHOWWINDOW/SW_HIDE，让宿主一出生即隐藏，
        #   从"事后 0.02s 藏"提前到"创建即不可见"，最大程度消除黑框闪现与抢焦点。
        si = _startupinfo_hidden()
        flags = 0x08000000  # CREATE_NO_WINDOW
        subprocess.Popen(
            [os.path.join(NAPCAT_DIR, 'NapCatWinBootMain.exe'),
             NAPCAT_QQ_PATH, inject],
            cwd=NAPCAT_DIR, env=env,
            creationflags=flags,
            close_fds=True,
            startupinfo=si)
        log('2026-09-28 宿主自愈：已尝试拉起 NapCat 宿主（源头隐藏）')
        return True
    except Exception as e:
        log('  宿主自愈启动异常: {}'.format(e))
        return False


# ---------- 宿主休眠 / 按需唤 管理 ----------
# 内存占用说明（2026-09-28 勘误）：宿主机（NapCatWinBootMain→QQ.exe 及其
# Network/GPU/Renderer 等 5-6 子进程）实际占用约 200MB+，而非早期注释估的 ~70MB；
# 休眠机制依赖"空闲自动停宿主"来把这 200MB 交还系统。无需改动内存逻辑。
def mark_host_busy():
    """任何真正使用宿主（取码/扫码/切号/等待 uin）前调用，刷新"宿主活跃时间"。
    保证空闲停机线程不会在补码/扫码进行到一半时把宿主杀掉。"""
    _host_busy_ts[0] = time.time()


def mark_host_woken():
    """宿主冷启动成功后记录唤醒时刻（用于冷却限频）。"""
    _host_wake_ts[0] = time.time()


def host_wake_cooldown_left():
    """距允许下一次冷唤醒还差的秒数（>0 表示仍在冷却期，应等待）。"""
    left = HOST_WAKE_COOLDOWN - (time.time() - _host_wake_ts[0])
    return max(0.0, left)


def ensure_host_awake(timeout=45.0):
    """休眠模式下安全地确保宿主在线（按需唤）。若宿主已在线直接返回 True；
    不在线则冷拉起并等待 webui 就绪。带 HOST_WAKE_COOLDOWN 冷却限频，
    防止异常路径高频启停宿主。（返回 True=此刻宿主可用。）
    注意：补码/切号路径 switch_to_account 内部会自己 launch_napcat_host(force=True)
    并等待 uin，不再需要此处的等待，故这里只保证"webui 可达即可"。
    电池供电（节能挂起）时绝不唤醒宿主，直接返回当前可达性（通常 False）。"""
    if napcat_alive():
        return True
    if on_battery():
        # 节能挂起：电池供电不拉宿主（省电 + 避免重风控动作）
        return False
    # 已在冷却期内且刚拉过：不重复拉（由调用方决定重试节奏）
    left = host_wake_cooldown_left()
    if left > 0:
        return napcat_alive()
    launch_napcat_host(force=True)
    mark_host_woken()
    deadline = time.time() + timeout
    while time.time() < deadline:
        if napcat_alive():
            return True
        time.sleep(0.5)
    return napcat_alive()


def _host_busy_now():
    """此刻是否正被补码主循环或扫码线程占用（不可停宿主）。"""
    return _scan_busy[0] or _relay_busy[0]


def host_idle_thread():
    """宿主空闲停机线程：宿主在线时周期检查，若空闲超过 HOST_IDLE_STOP_MIN 分钟
    且无补码/扫码进行中，则主动停止宿主，把 ~70MB 内存还给系统。
    触发反弹保护：若距上次冷唤醒 < HOST_WAKE_COOLDOWN，则顺延（避免刚唤又杀）。
    """
    while not _host_thread_stop[0]:
        try:
            time.sleep(30)
            if not HOST_HIBERNATE:
                continue
            # 电池供电：宿主已在主循环被停掉，这里无需再评估，拉长间隔省电
            if on_battery():
                time.sleep(BATTERY_PROBE)
                continue
            if _host_busy_ts[0] is None:
                continue
            # 只在宿主实际在线时才评估停不停
            if not napcat_alive():
                continue
            if _host_busy_ts[0] and _host_busy_ts[0] > time.time():
                _host_busy_ts[0] = time.time()
            idle_s = time.time() - _host_busy_ts[0]
            if idle_s < HOST_IDLE_STOP_MIN * 60:
                _host_idle_stopped_logged[0] = False
                continue
            # 正在补码/扫码绝不杀
            if _host_busy_now():
                _host_idle_stopped_logged[0] = False
                continue
            # 距上次冷唤醒太近则再等等（避免刚拉起就杀掉）
            if host_wake_cooldown_left() > 0:
                continue
            if not _host_idle_stopped_logged[0]:
                _host_idle_stopped_logged[0] = True
                log('  宿主空闲 {:.0f}s，自动停止以释放内存（宿主家族实际约 200MB）'.format(idle_s))
            napcat_stop_host()
        except Exception as e:
            log('宿主闲置停机异常: {}'.format(e))


def start_host_idle_thread():
    threading.Thread(target=host_idle_thread, daemon=True).start()


def _ensure_hide_console():
    """确保有且仅有一个「常驻」的 NapCat 控制台隐藏监控在运行。

    NapCatWinBootMain 会给 QQ.exe 注入 --enable-logging，使 Electron 每次
    (重)拉起/切号时新分配一个控制台窗口打印日志。常驻监控用全局命名互斥做单例，
    以**事件驱动（SetWinEventHook：窗口显示 / 前台变化）+ 低频兜底扫描**的方式
    隐藏这些窗口。

    ⚠️ 2026-10-24 修正：旧版只认「窗口类 ∈ {ConsoleWindowClass, PseudoConsoleWindow}
    且属主进程名 ∈ {QQ.exe, NapCatWinBootMain.exe}」——但 Win10/11 的 ConPTY 控制台
    窗口（PseudoConsoleWindow）**属主是 conhost.exe**，故该条件恒不成立（铁证：整份
    守护日志里代表"真压到过"的 `主动压黑框` 命中 0 次）。新版改为**进程树判定**：
    属主进程只要属于 NapCat 宿主进程树（NapCatWinBootMain.exe / QQ.exe 及其全部
    后代，含 conhost.exe）即处理。绝不误伤用户自己的 cmd/PowerShell/Windows Terminal
    （它们不在 NapCat 树内），也绝不碰 QQ 主界面（类名不在控制台白名单）。"""
    try:
        hide_script = os.path.join(NAPCAT_DIR, 'hide-napcat-console.py')
        if not os.path.exists(hide_script):
            return
        pid_file = os.path.join(NAPCAT_DIR, 'hide-napcat-console.pid')
        # 优先从 pid 文件找回存活监控（守护自身重启后，本地变量已归零）。
        # 命中且进程存活 → 复用，不重复拉起（全局互斥也会挡重复实例）。
        if not _hide_console_pid[0]:
            try:
                with open(pid_file) as f:
                    _hide_console_pid[0] = int(f.read().strip())
            except Exception:
                _hide_console_pid[0] = 0
        if _hide_console_pid[0]:
            if _proc_alive(_hide_console_pid[0]):
                return
            _hide_console_pid[0] = 0
            try:
                os.remove(pid_file)
            except Exception:
                pass
        p = subprocess.Popen(
            [sys.executable, hide_script, '--forever'],
            cwd=NAPCAT_DIR,
            creationflags=0x08000000 | 0x00000008,  # CREATE_NO_WINDOW | DETACHED
            close_fds=True,
            shell=False)
        _hide_console_pid[0] = p.pid
        log('  已确保常驻 NapCat 控制台隐藏监控 pid={}'.format(p.pid))
    except Exception as e:
        log('  确保常驻隐藏监控异常: {}'.format(e))


def _hide_now():
    """主动同步压一轮：隐藏当前所有可见的 NapCat 宿主控制台窗口。
    用于切号/拉宿主的关键节点（停旧宿主前、起新宿主前各调一次），
    结合常驻 `--forever` 0.02s 扫描，几乎消灭黑框可见窗口。
    纯本机、只动宿主的控制台窗口，绝不碰 QQ 主界面；失败仅记日志不阻断。"""
    try:
        hide_script = os.path.join(NAPCAT_DIR, 'hide-napcat-console.py')
        if not os.path.exists(hide_script):
            return
        r = subprocess.run(
            [sys.executable, hide_script, '--once'],
            cwd=NAPCAT_DIR,
            creationflags=0x08000000,  # CREATE_NO_WINDOW
            capture_output=True, text=True, timeout=15)
        out = (r.stdout or '').strip()
        lines = [l for l in out.splitlines() if 'hidden host console' in l]
        if lines:
            log('  主动压黑框: {} 条 | {}'.format(len(lines), lines[-1]))
    except Exception as e:
        log('  主动压黑框异常: {}'.format(e))


def napcat_stop_host():
    """停掉 NapCat 宿主进程树并等待彻底退出，用于切号前清空登录号。

    机制：NapCat 宿主实例以 NapCatWinBootMain.exe 为顶层父进程。先枚举"全部
    宿主根 + 其所有后代(QQ.exe/Renderer 等)"一并 taskkill /F，再轮询等待 6099
    端口释放（webui 消失=宿主彻底退出）后才返回。这样避免切号时旧进程/数据目录
    锁残留，导致新宿主无法自动快速登录目标号（实测：从零起可登录；切换时因旧树
    残留而卡登录——这就是切回失败的根因）。用户日常 QQ 父非 NapCatWinBootMain，
    不在树内不受影响。返回停止进程数；0 表示本来就没起。"""
    all_kill = []
    try:
        out = exec_shell(['powershell', '-NoProfile', '-Command',
                          "Get-CimInstance Win32_Process "
                          "| Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"],
                         timeout=30)
        j = json_body(out)
        if not j:
            j = []
        if isinstance(j, dict):
            j = [j]
        byparent = {}
        name_of = {}
        for p in j:
            pid = p.get('ProcessId'); par = p.get('ParentProcessId'); nm = p.get('Name') or ''
            byparent.setdefault(par, []).append(pid)
            name_of[pid] = nm
    except Exception:
        byparent, name_of = {}, {}
    roots = [pid for pid, nm in name_of.items() if nm == 'NapCatWinBootMain.exe']
    if not roots:
        pid = napcat_host_pid()
        if pid:
            roots = [pid]
    if not roots:
        return 0
    # 停旧宿主前先主动压黑框（当前若有宿主的控制台窗口先隐藏再杀，避免强杀瞬间残留下弹眼）
    _hide_now()
    seen = set(roots)
    all_kill = list(roots)
    stack = list(roots)
    while stack:
        par = stack.pop()
        for child in byparent.get(par, []):
            if child not in seen:
                seen.add(child)
                all_kill.append(child)
                stack.append(child)
    for pid in all_kill:
        # ⚠️ 必须走纯 Win32（OpenProcess+TerminateProcess）：os.system 会拉 cmd.exe，
        # 而 pythonw 无控制台 → cmd 自行 AllocConsole() → Win11 委派给 Windows
        # Terminal → 每杀一个进程弹一个黑框（10-29 实测：6 个进程 = 6 个 WT 黑框）。
        _terminate_pid(pid)
    log('  已停止 NapCat 宿主及其后代 {} 个进程'.format(len(all_kill)))
    deadline = time.time() + 20
    while time.time() < deadline:
        if napcat_host_pid() == 0:
            break
        time.sleep(1)
    time.sleep(2)
    return len(all_kill)


# ---------- farm 面板 ----------
def panel_login():
    ok, st, txt = post_json('{}/api/login'.format(PANEL), {'username': USER, 'password': PASS})
    if not ok or st != 200:
        return ''
    j = json_body(txt) or {}
    return (j.get('data') or {}).get('token', '') if j else ''


def panel_qq_accounts(token):
    ok, st, txt = get('{}/api/accounts'.format(PANEL),
                      {'x-admin-token': token, 'Accept': 'application/json'})
    if not ok or st != 200:
        return []
    j = json_body(txt) or {}
    accs = (j.get('data') or {}).get('accounts')
    if not isinstance(accs, list):
        accs = j.get('data') if isinstance(j.get('data'), list) else []
    out = []
    for a in accs:
        if a.get('platform') == 'qq':
            out.append({
                'id': str(a.get('id')),
                'name': a.get('name', ''),
                'running': bool(a.get('running')),
                'openId': a.get('openId', ''),
                'gid': a.get('gid', '') or '',
            })
    return out


def panel_qq_connected(token, account_id):
    """
    查某账号是否**真的连上了 gameserver**（而非仅进程存活）。

    ⭐ 为什么必须单独查（2026-11-01 实测踩坑）：
    `/api/accounts` 只返回 `running`（worker 进程是否存活），**没有 connected 字段**。
    gateway 模式下会出现「僵尸 worker」：gateway 重启后 worker 进程仍在跑（running=True），
    但它到网关的 socket 已断（connected=False），既不重连也不退出。
    此时守护脚本按 running 判定会认为"没掉线"，**永不补码**，
    线上表现为"面板显示两个号离线，守护却报无掉线账号"。

    返回 True/False；接口异常或字段缺失时返回 None（未知），调用方应保守处理。
    """
    ok, st, txt = get('{}/api/status'.format(PANEL),
                      {'x-admin-token': token,
                       'x-account-id': str(account_id),
                       'Accept': 'application/json'})
    if not ok or st != 200:
        return None
    j = json_body(txt) or {}
    d = j.get('data')
    if not isinstance(d, dict):
        return None
    conn = d.get('connection')
    if not isinstance(conn, dict) or 'connected' not in conn:
        return None
    return bool(conn.get('connected'))


def panel_create_flow(token, account_id):
    ok, st, txt = post_json('{}/api/capture/sessions'.format(PANEL),
                            {'platform': 'qq', 'localOnly': True, 'accountId': str(account_id)},
                            {'x-admin-token': token})
    if not ok or st != 200:
        return ''
    j = json_body(txt) or {}
    return (j.get('data') or {}).get('id') or ''


def panel_inject(token, flow_id, code, open_id, gid):
    ok, st, txt = post_json('{}/api/capture/sessions/{}/inject'.format(PANEL, flow_id),
                            {'code': code, 'openId': open_id, 'gid': str(gid)},
                            {'x-admin-token': token})
    j = json_body(txt) or {}
    return ok and bool(j.get('ok'))


def panel_complete(token, flow_id):
    ok, st, txt = post_json('{}/api/capture/sessions/{}/complete'.format(PANEL, flow_id),
                            {}, {'x-admin-token': token}, timeout=50)
    j = json_body(txt) or {}
    return ok and bool(j.get('ok'))


def panel_stop_account(token, account_id):
    """
    停止账号的 worker 进程（用于清掉「僵尸 worker」）。

    ⭐ 为什么需要（2026-11-01 实测）：
    gateway 重启后 worker 进程会存活但到网关的 socket 已断，且它自己不重连
    （worker 的 disconnect 处理器只打日志 '等待重连...'，不做任何重连动作）。
    此时只 inject + complete 而不停旧进程，新 Code 虽注入成功、complete 也返回 ok，
    但旧 worker 仍挂在断开的 socket 上，线上表现依旧是离线。
    先 stop 掉旧进程，complete 时主容器才会 fork 一个干净的新 worker。

    返回 True/False；接口异常返回 False（调用方会记录日志并继续尝试）。
    """
    ok, st, txt = post_json('{}/api/accounts/{}/stop'.format(PANEL, account_id),
                            {}, {'x-admin-token': token,
                                 'x-account-id': str(account_id)}, timeout=40)
    if not ok or st != 200:
        return False
    j = json_body(txt) or {}
    return bool(j.get('ok'))


# ---------- QQ 扫码登录中转（守护侧，2026-09-16） ----------
# 面板「QQ 扫码」标签页建任务 → 服务器只做中转（本机 NapCat 在 NAT 后，服务器内存
# 也放不下 NapCat）→ 本守护轮询领取：
#   1) 清掉本机常驻 QQ 会话（NapCat 已登录时 GetQQLoginQrcode 会报 "QQ Is Logined"）
#   2) 取二维码回填服务器（回传原始 qrcodeurl，服务器用 qrcode 包渲染成图片）
#   3) 轮询 CheckLoginStatus 等用户手机扫码确认，超时前定期刷码
#   4) 插件 loginWithAppId 直取农场 code → 回填 → 面板自动建号
#   5) 恢复本机驻留号（默认希恩斯），把 QQ 登录态还给用户
#
# 与补码主循环互斥：_relay_busy / _scan_busy 两个闸门。
# ⚠️ 全程绝不调用 RestartNapCat（QQ 9.9.33 下会杀宿主进程树致宿主崩，见记忆）。

RELAY_TASK_STEP = 2.0        # 扫码等待期间的登录状态轮询间隔（秒）
RELAY_QR_REFRESH = 45.0      # 二维码刷新间隔（秒）
RELAY_LOGOUT_WAIT = 20.0     # 等 NapCat 登出完成的最长时间（秒）
RELAY_READY_WAIT = 20.0      # 等插件上下文就绪的最长时间（秒）

_scan_busy = [False]         # 补码主循环占用宿主中
_relay_busy = [False]        # 扫码任务占用宿主中
_relay_started = [False]
_relay_current = ['']        # 当前处理中的扫码任务 id（日志/心跳用）

# ---- 宿主休眠 / 按需唤 运行时状态 ----
_host_busy_ts = [time.time()]   # 宿主最近一次"活跃被使用"的时间（补码/扫码/取码等）
_host_wake_ts = [0.0]           # 宿主最近一次被冷唤醒的启动时间戳（用于冷却限频）
_host_thread_stop = [False]
_host_idle_stopped_logged = [False]   # 本次空闲停机是否已打过日志（防刷屏）


def _merge_dicts(j):
    out = {}
    if not isinstance(j, dict):
        return out
    for key in ('data', 'result'):
        v = j.get(key)
        if isinstance(v, dict):
            out.update(v)
            if isinstance(v.get('result'), dict):
                out.update(v['result'])
    return out


def napcat_webui(action, body=None, timeout=20):
    """调 NapCat webui 的 /api/QQLogin/* 接口。

    返回归一化后的 dict；网络/鉴权失败返回 None；NapCat 业务报错返回
    {'_error': 消息}（不抛异常，便于调用方继续轮询）。"""
    cred = napcat_cred()
    if not cred:
        return None
    ok, st, txt = post_json('{}/api{}'.format(NAPCAT_BASE, action), body or {},
                            {'Authorization': 'Bearer ' + cred}, timeout=timeout)
    if not ok:
        return None
    j = json_body(txt) or {}
    code = j.get('code')
    if code is not None:
        try:
            if int(code) != 0:
                return {'_error': str(j.get('message') or 'NapCat 请求失败')}
        except Exception:
            pass
    return _merge_dicts(j)


def napcat_plugin(path, body=None, method='POST', timeout=20):
    """调 qq-miniapp-openauth 插件：/plugin/qq-miniapp-openauth/api<path>。"""
    url = '{}/plugin/qq-miniapp-openauth/api{}'.format(NAPCAT_BASE, path)
    headers = {'Authorization': 'Bearer ' + NAPCAT_PLUGIN_TOKEN}
    if method == 'GET':
        ok, st, txt = get(url, headers, timeout=timeout)
    else:
        ok, st, txt = post_json(url, body or {}, headers, timeout=timeout)
    if not ok:
        return None
    return json_body(txt)


def napcat_login_state():
    """返回 {'isLogin':bool,'isOffline':bool,'qrcodeurl':str,'loginError':str}，失败 None。"""
    d = napcat_webui('/QQLogin/CheckLoginStatus')
    if not d or '_error' in d:
        return None
    return {
        'isLogin': bool(d.get('isLogin')),
        'isOffline': bool(d.get('isOffline')),
        'qrcodeurl': str(d.get('qrcodeurl') or ''),
        'loginError': str(d.get('loginError') or ''),
    }


def napcat_clear_autologin():
    """清 webui 的 autoLoginAccount，避免重启宿主时自动登回常驻号（uin 空即清空）。"""
    d = napcat_webui('/QQLogin/SetQuickLoginQQ', {'uin': ''})
    return bool(d) and '_error' not in d


def napcat_logout():
    """登出 NapCat 当前 QQ 会话（插件 /logout），不重启宿主、不用 RestartNapCat。"""
    j = napcat_plugin('/logout', {})
    if isinstance(j, dict) and j.get('ok') and j.get('loggedOut'):
        return True
    log('  [扫码] 插件登出失败: {}'.format((j or {}).get('error') or j))
    return False


def napcat_enter_scan_mode():
    """进入"待扫码"状态：清 autoLogin + 登出当前会话。

    成功标志是 CheckLoginStatus 既非 isLogin 也非 isOffline（无会话）。
    兜底：插件登出不可用时，停宿主并用已清空的 autoLogin 重新拉起（宿主起来即
    未登录状态、可出二维码），**不用 RestartNapCat**。"""
    st = napcat_login_state()
    if st is None:
        return False, 'NapCat 登录状态查询失败'
    if st['isLogin'] or st['isOffline']:
        log('  [扫码] 先登出本机常驻 QQ 会话（isLogin={} isOffline={}）'.format(
            st['isLogin'], st['isOffline']))
        napcat_clear_autologin()
        napcat_logout()
        end = time.time() + RELAY_LOGOUT_WAIT
        while time.time() < end:
            cur = napcat_login_state()
            if cur is not None and not cur['isLogin'] and not cur['isOffline']:
                return True, ''
            time.sleep(1.5)
        log('  [扫码] 会话未清干净，改为重启宿主（autoLogin 已清空，不碰 RestartNapCat）')
        napcat_stop_host()
        if not launch_napcat_host(force=True):
            return False, '宿主重启失败，无法取二维码'
        end = time.time() + 90
        while time.time() < end:
            cur = napcat_login_state()
            if cur is not None and not cur['isLogin'] and not cur['isOffline']:
                return True, ''
            time.sleep(3)
        return False, '宿主重启后仍未退出登录，请手动检查本机 NapCat'
    return True, ''


def napcat_take_qrcode():
    """取登录二维码原始值（NapCat 返回的是 qrcodeurl，图片由服务器渲染）。"""
    d = napcat_webui('/QQLogin/GetQQLoginQrcode')
    if d is None:
        return ''
    if '_error' in d:
        err = d['_error']
        if re.search(r'logined|logined|Is Logined', err, re.I):
            return ''
        log('  [扫码] 取二维码失败: {}'.format(err))
        return ''
    raw = (d.get('qrcode') or d.get('qrCode') or d.get('qrUrl') or d.get('qr_url')
           or d.get('image') or d.get('base64') or '')
    return str(raw).strip()


def napcat_refresh_qrcode():
    napcat_webui('/QQLogin/RefreshQRcode', timeout=15)


def napcat_qq_info():
    d = napcat_webui('/QQLogin/GetQQLoginInfo')
    if not d or '_error' in d:
        return ''
    return str(d.get('uin') or d.get('user_id') or d.get('qq') or '').strip()


def napcat_plugin_ready(timeout=RELAY_READY_WAIT):
    """等插件拿到 QQ 上下文（登录后 NapCat 会话初始化有延迟）。"""
    end = time.time() + timeout
    while time.time() < end:
        j = napcat_plugin('/status', method='GET', timeout=8)
        if isinstance(j, dict) and j.get('ok') is True and j.get('ready') is True:
            return True
        time.sleep(1.0)
    return False


def napcat_take_farm_code():
    """用当前已登录的 QQ 调 loginWithAppId 直取农场 code，返回 (code, uin, nickname)。"""
    if not napcat_plugin_ready():
        return '', '', ''
    j = napcat_plugin('/miniapp', {'appId': APP_ID, 'interactive': True},
                      timeout=max(40, int(RELAY_SCAN_TIMEOUT)))
    if not isinstance(j, dict):
        return '', '', ''
    code = str(j.get('code') or '').strip()
    if not code and j.get('operation') == 'loginWithAppId' and isinstance(j.get('result'), str):
        code = str(j['result']).strip()
    if not code:
        log('  [扫码] 换 code 失败: {}'.format(j.get('error') or j.get('operation')))
        return '', '', ''
    uin = str(j.get('uin') or '').strip()
    nick = str(j.get('nickname') or '').strip()
    if not uin:
        uin = napcat_qq_info()
    return code, uin, nick


# ----- 服务器中转通信 -----
def relay_post(path, body, timeout=25):
    """带 relay token 调面板服务器的 /api/napcat-relay/<path>。"""
    if not RELAY_TOKEN:
        return None
    if not body:
        body = {}
    body = dict(body)
    body['version'] = GUARD_VERSION
    ok, st, txt = post_json('{}/api/napcat-relay/{}'.format(RELAY_URL, path), body,
                            {'x-relay-token': RELAY_TOKEN}, timeout=timeout)
    if not ok or st != 200:
        return None
    return json_body(txt)


def relay_report(task_id, **patch):
    if not task_id:
        return None
    body = {'id': task_id}
    body.update(patch)
    return relay_post('report', body)


def relay_heartbeat(napcat_ok, uin, busy):
    j = relay_post('heartbeat', {
        'napcat': bool(napcat_ok),
        'uin': str(uin or ''),
        'busy': bool(busy),
    })
    if not isinstance(j, dict) or not j.get('ok'):
        return None
    return ((j.get('data') or {}).get('tasks')) or []


def relay_handle_task(task):
    """执行一个扫码任务。返回 True=任务终结（done/error）。"""
    tid = str(task.get('id') or '')
    if not tid:
        return True
    if task.get('status') in ('done', 'error', 'expired', 'cancelled'):
        return True
    log('[扫码] 领取任务 {}，开始处理'.format(tid[:8]))
    try:
        relay_report(tid, status='scanning')

        ok, err = napcat_enter_scan_mode()
        if not ok:
            relay_report(tid, status='error', error=err)
            return True

        raw = napcat_take_qrcode()
        if not raw:
            napcat_refresh_qrcode()
            time.sleep(1.0)
            raw = napcat_take_qrcode()
        if not raw:
            relay_report(tid, status='error', error='本机 NapCat 未返回登录二维码')
            return True
        relay_report(tid, status='scanning', qrImage=raw)
        log('  [扫码] 二维码已回填，等待手机扫码（最长 {}s）'.format(int(RELAY_SCAN_TIMEOUT)))

        deadline = time.time() + RELAY_SCAN_TIMEOUT
        refresh_at = time.time() + RELAY_QR_REFRESH
        confirmed = False
        while time.time() < deadline:
            if _relay_cancelled(tid):
                log('  [扫码] 任务已被取消/过期，放弃')
                return True
            st = napcat_login_state()
            if st is not None and st['isLogin']:
                confirmed = True
                break
            if time.time() >= refresh_at:
                refresh_at = time.time() + RELAY_QR_REFRESH
                napcat_refresh_qrcode()
                time.sleep(0.8)
                newer = napcat_take_qrcode()
                if newer and newer != raw:
                    raw = newer
                    relay_report(tid, status='scanning', qrImage=raw)
                    log('  [扫码] 二维码已刷新')
            time.sleep(RELAY_TASK_STEP)

        if not confirmed:
            relay_report(tid, status='error', error='扫码超时，请重新获取二维码')
            log('  [扫码] 超时')
            return True

        log('  [扫码] 用户已确认登录，正在取农场 code')
        code, uin, nick = napcat_take_farm_code()
        if not code:
            relay_report(tid, status='error', error='QQ 已登录但未取到农场 Code，请重试',
                         uin=uin, nickname=nick)
            return True
        relay_report(tid, status='done', code=code, uin=uin, nickname=nick)
        log('  [扫码] 取码成功 uin={} code={}...'.format(uin, code[:8]))
        return True
    except Exception as e:
        log('  [扫码] 异常: {}'.format(e))
        relay_report(tid, status='error', error='本机处理异常: {}'.format(e))
        return True
    finally:
        _relay_current[0] = ''


def _relay_cancelled(task_id):
    """心跳顺便确认任务是否仍活跃（被面板取消/过期则不再继续）。"""
    tasks = relay_heartbeat(napcat_alive(), None, True)
    if tasks is None:
        return False
    return all(str(t.get('id')) != str(task_id) for t in tasks if isinstance(t, dict))


def relay_restore_resident():
    """扫码任务结束后把宿主切回驻留号，把 QQ 登录态还给用户。"""
    if not RELAY_RESTORE_RESIDENT or not RELEASE_TARGET_UIN:
        return
    try:
        if switch_to_account(RELEASE_TARGET_UIN):
            log('  [扫码] 已恢复本机驻留号 uin={}'.format(RELEASE_TARGET_UIN))
        else:
            log('  [扫码] 恢复驻留号失败（不影响本次取码结果）')
    except Exception as e:
        log('  [扫码] 恢复驻留号异常: {}'.format(e))


def relay_thread():
    """扫码中转线程：持续心跳 + 领取并执行任务。"""
    log('[扫码] 中转客户端已启动（server={} token={}...）'.format(
        RELAY_URL, (RELAY_TOKEN[:8] + '...') if RELAY_TOKEN else '(空)'))
    idle_logged = False
    while True:
        try:
            if not RELAY_ENABLED or not RELAY_TOKEN:
                time.sleep(30)
                continue
            # 电池供电（节能挂起）：不领任务、不拉宿主，心跳也拉长到探测间隔
            # 级别（省电/省网络）；插电后自动恢复。服务器侧任务会留待插电再处理。
            if on_battery():
                time.sleep(BATTERY_PROBE)
                continue
            # 补码主循环占用宿主时不抢宿主，只报 busy（此时不赶签到，用空闲心跳）
            if _scan_busy[0]:
                relay_heartbeat(napcat_alive(), None, True)
                time.sleep(RELAY_IDLE_POLL)
                continue
            napcat_ok = napcat_alive()
            tasks = relay_heartbeat(napcat_ok, napcat_online_uin() if napcat_ok else None,
                                    False)
            if tasks is None:
                if not idle_logged:
                    log('[扫码] 服务器中转不可达（面板断网？），稍后重试')
                    idle_logged = True
                # 服务器本就不可达，别再高频空打，用更长退避减少风暴
                time.sleep(max(RELAY_IDLE_POLL, RELAY_POLL * 2))
                continue
            if idle_logged:
                log('[扫码] 服务器中转恢复')
                idle_logged = False
            pending = [t for t in tasks if isinstance(t, dict)
                       and t.get('status') not in ('done', 'error', 'expired', 'cancelled')]
            if not pending:
                # 空闲：无任务可领，用空闲心跳节流（原 3s→30s，日请求降 10 倍）
                time.sleep(RELAY_IDLE_POLL)
                continue
            task = pending[0]
            _relay_busy[0] = True
            _relay_current[0] = str(task.get('id') or '')
            try:
                # 休眠模式：扫码任务到来时若宿主休眠，先按需唤醒宿主再处理
                if HOST_HIBERNATE and not napcat_alive():
                    log('[扫码] 宿主休眠，先按需唤醒以处理扫码任务')
                    ok = ensure_host_awake(timeout=45.0)
                    if not ok:
                        log('[扫码] 唤醒宿主失败，跳过该任务（稍后重试）')
                        time.sleep(RELAY_IDLE_POLL)
                        continue
                    napcat_ok = True
                if napcat_ok:
                    mark_host_busy()
                    relay_handle_task(task)
                    relay_restore_resident()
            finally:
                _relay_busy[0] = False
                _relay_current[0] = ''
            time.sleep(RELAY_POLL)
        except Exception as e:
            log('[扫码] 线程异常: {}'.format(e))
            time.sleep(10)


def start_relay_thread():
    if _relay_started[0]:
        return
    _relay_started[0] = True
    t = threading.Thread(target=relay_thread, name='napcat-relay', daemon=True)
    t.start()


# ---------- 内存治理 ----------
class MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [('dwLength', wt.DWORD), ('dwMemLoad', wt.DWORD),
                ('ullTotalPhys', ctypes.c_uint64), ('ullAvailPhys', ctypes.c_uint64),
                ('ullTotalPage', ctypes.c_uint64), ('ullAvailPage', ctypes.c_uint64),
                ('ullTotalVirtual', ctypes.c_uint64), ('ullAvailVirtual', ctypes.c_uint64),
                ('ullAvailExt', ctypes.c_uint64)]


def avail_mem_gb():
    st = MEMORYSTATUSEX()
    st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    k.GlobalMemoryStatusEx(ctypes.byref(st))
    return st.ullAvailPhys / (1024 ** 3)


def clean_standby():
    try:
        subprocess.run(['powershell', '-NoProfile', '-Command', PS_EMPTY_STANDBY],
                       capture_output=True, timeout=40, env=clean_env(),
                       creationflags=0x08000000)
        return True
    except Exception:
        return False


# 内存治理后台线程
_mem_start = [time.time()]
_mem_last = [0.0]
_mem_stop = [False]


def memory_thread():
    while not _mem_stop[0]:
        try:
            # 电池供电（节能挂起）：不跑 PS 内存清理（耗电），按探测间隔轮询
            if on_battery():
                time.sleep(BATTERY_PROBE)
                continue
            now = time.time()
            run = now - _mem_last[0] >= CLEAN_FLUSH_HOUR * 3600       # L2 周期
            if avail_mem_gb() < STANDBY_MIN_AVAIL / (1024 ** 3):      # L1 低内存
                run = True
            if run:
                gb = avail_mem_gb()
                if clean_standby():
                    log('内存治理: 可用 {:.1f}GB，已交还 Standby 缓存'.format(gb))
                _mem_last[0] = now
        except Exception as e:
            log('内存治理异常: {}'.format(e))
        time.sleep(60)


def start_memory_thread():
    threading.Thread(target=memory_thread, daemon=True).start()


# ---------- 用户日常 QQ 感知 ----------
def napcat_host_pid():
    try:
        r = subprocess.run(['netstat', '-ano', '-p', 'tcp'], capture_output=True,
                           timeout=20, creationflags=0x08000000)
        for line in _decode_bytes(r.stdout).splitlines():
            if ':' + str(HOST_PORT) in line and 'LISTENING' in line.upper():
                parts = line.split()
                if parts and parts[-1].isdigit():
                    return int(parts[-1])
    except Exception:
        pass
    return 0


def _qq_proc_pids():
    """返回 [(pid, start_ts)]，start_ts='YYYYMMDDHHMMSS'。失败 []。"""
    out = exec_shell(['powershell', '-NoProfile', '-Command',
                      'Get-CimInstance Win32_Process -Filter "Name=\'QQ.exe\'" '
                      '| ForEach-Object { "$($_.ProcessId)|$($_.CreationDate.ToString(\'yyyyMMddHHmmss\'))" }'],
                     timeout=25)
    procs = []
    for line in out.splitlines():
        line = line.strip()
        m = re.match(r'^(\d+)\|(\d{14})$', line)
        if m:
            procs.append((int(m.group(1)), m.group(2)))
    return procs


def user_qq_present():
    """是否检测到用户日常 QQ 客户端（非 NapCat 宿主）。

    判据：用户日常 QQ 是【宿主启动时刻之后】才被打开的独立 QQ 实例。
    NapCat 宿主子进程与其同启动(≤2s)，NapCat 重启前的残留旧进程则"早于宿主"，
    二者都不算用户 QQ；仅当存在启动时间**严格晚于宿主**的其它 QQ 进程，
    才视为用户手动打开(或单独启动)的日常 QQ。返回 (detected, detail)。"""
    host = napcat_host_pid()
    procs = _qq_proc_pids()
    if not procs:
        return False, 'no-proc'
    host_ts = None
    for pid, ts in procs:
        if pid == host:
            host_ts = ts
            break
    if host_ts is None:
        return False, 'no-host'
    try:
        d_host = datetime.datetime.strptime(host_ts, '%Y%m%d%H%M%S')
    except Exception:
        d_host = None
    users = []
    for pid, ts in procs:
        if pid == host:
            continue
        if d_host is None:
            continue   # 无法解析宿主时间，保守不判
        try:
            d2 = datetime.datetime.strptime(ts, '%Y%m%d%H%M%S')
        except Exception:
            continue
        # 严格晚于宿主启动（>3s，排除同秒一并拉起的宿主子进程）
        if (d2 - d_host).total_seconds() > 3:
            users.append(pid)
    if users:
        return True, ','.join(str(x) for x in users)
    return False, 'only-host'


# ---------- 风控熔断（三级：单号限频 / 失败退避 / 全局风暴）----------
# 状态落盘，重启守护不丢（否则重启即清零 = 熔断失效）
_circuit = {
    'tries': {},        # aid -> [ts...]  单号补码尝试时间戳
    'storm': [],        # [ts...]         全局补码尝试时间戳
    'failStreak': {},   # aid -> n        连续失败次数（退避阶梯用）
    'switchFail': {},   # aid -> n        连续切号失败次数（判票据失效）
    'nextOk': {},       # aid -> ts       该号下次允许补码的时间
    'manual': {},       # aid -> {since,reason}  需人工扫码，停止自动重试
    'pausedUntil': 0.0,  # 全局暂停截止时间戳
}


def circuit_load():
    try:
        if os.path.exists(CIRCUIT_FILE):
            d = json.load(open(CIRCUIT_FILE, encoding='utf-8'))
            if isinstance(d, dict):
                for k in list(_circuit.keys()):
                    if k in d:
                        _circuit[k] = d[k]
    except Exception as e:
        log('熔断状态加载失败（按空状态继续）: {}'.format(e))


def circuit_save():
    try:
        json.dump(_circuit, open(CIRCUIT_FILE, 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=1)
    except Exception:
        pass


def circuit_reset():
    """--reset：清空全部熔断状态（解封/人工扫码后使用）"""
    for k in list(_circuit.keys()):
        _circuit[k] = {} if isinstance(_circuit[k], dict) else ([] if isinstance(_circuit[k], list) else 0.0)
    _circuit['storm'] = []
    _circuit['pausedUntil'] = 0.0
    circuit_save()
    log('熔断状态已重置（单号限频/退避/人工标记/全局暂停全部清空）')


def _prune(arr, win):
    now = time.time()
    return [t for t in arr if now - float(t) < win]


def notify(title, content):
    """PushPlus 告警（PUSHPLUS_URL 置空则静默）"""
    if not PUSHPLUS_URL:
        return
    try:
        post_json(PUSHPLUS_URL, {'title': title, 'content': content, 'template': 'txt'},
                  timeout=10)
    except Exception:
        pass


def circuit_block_reason(aid):
    """返回 None=允许补码；否则返回原因字符串（供日志展示）"""
    key = str(aid)
    now = time.time()
    if now < float(_circuit.get('pausedUntil', 0) or 0):
        return '全局熔断暂停中(剩{}s)'.format(int(float(_circuit['pausedUntil']) - now))
    if key in (_circuit.get('manual') or {}):
        return '需人工扫码({})'.format((_circuit['manual'][key] or {}).get('reason', ''))
    nxt = float((_circuit.get('nextOk') or {}).get(key, 0) or 0)
    if now < nxt:
        return '冷却中(剩{}s)'.format(int(nxt - now))
    tries = _prune((_circuit.get('tries') or {}).get(key, []), RATE_WINDOW)
    if len(tries) >= RATE_MAX_PER_ACCOUNT_HOUR:
        return '本小时已达上限{}/{}'.format(len(tries), RATE_MAX_PER_ACCOUNT_HOUR)
    return None


def circuit_note_try(aid):
    """记录一次补码尝试并做全局风暴检测"""
    key = str(aid)
    tries = _circuit.setdefault('tries', {})
    tries[key] = _prune(tries.get(key, []), RATE_WINDOW) + [time.time()]
    storm = _circuit.get('storm') or []
    _circuit['storm'] = _prune(storm, STORM_WINDOW) + [time.time()]
    if len(_circuit['storm']) >= STORM_MAX_TRY:
        _circuit['pausedUntil'] = time.time() + STORM_PAUSE
        _circuit['storm'] = []
        msg = '{}s 内补码尝试达 {} 次，触发全局熔断，暂停 {}s。常见原因：账号被风控/封禁或服务端会话反复崩溃，请人工确认后再放行'.format(
            int(STORM_WINDOW), STORM_MAX_TRY, int(STORM_PAUSE))
        log('[熔断] ' + msg)
        notify('farm 守护：全局熔断', msg)
    circuit_save()


def circuit_note_result(aid, ok, switch_failed=False):
    """记录补码结果：成功→冷却 MIN_FIX_INTERVAL；失败→阶梯退避；连续切号失败→标记人工"""
    key = str(aid)
    if ok:
        _circuit.setdefault('failStreak', {})[key] = 0
        _circuit.setdefault('switchFail', {})[key] = 0
        _circuit.setdefault('nextOk', {})[key] = time.time() + MIN_FIX_INTERVAL
        (_circuit.setdefault('manual', {})).pop(key, None)
    else:
        st = int((_circuit.setdefault('failStreak', {})).get(key, 0) or 0) + 1
        _circuit['failStreak'][key] = st
        idx = min(st - 1, len(BACKOFF_STEPS) - 1)
        wait = BACKOFF_STEPS[idx]
        _circuit.setdefault('nextOk', {})[key] = time.time() + wait
        log('[熔断] id={} 连续失败 {} 次，退避 {}s'.format(aid, st, int(wait)))
        if switch_failed:
            sf = int((_circuit.setdefault('switchFail', {})).get(key, 0) or 0) + 1
            _circuit['switchFail'][key] = sf
            if sf >= SWITCH_FAIL_TO_MANUAL:
                (_circuit.setdefault('manual', {}))[key] = {
                    'since': time.time(), 'reason': '切号连续失败，票据失效'}
                msg = ('账号 id={} 连续 {} 次切号失败，已标记"需人工扫码"，'
                       '守护停止自动重试。请到 NapCat webui(http://127.0.0.1:6099) 手动登录后，'
                       '执行 python napcat-code-guard.py --reset 放行'.format(aid, sf))
                log('[熔断] ' + msg)
                notify('farm 守护：需人工扫码', msg)
    circuit_save()


# ---------- 主流程 ----------
def switch_to_account(uin):
    """把 NapCat 宿主切到目标号 uin。核心：避免用 RestartNapCat（在 QQ 9.9.33+
    NapCat 4.18.19 下会强制杀进程树致 GPU/Network 崩、宿主死透）。

    改用已验证可靠的链路：SetQuickLoginQQ 写 webui.json 的 autoLogin=目标号
    → 优雅停当前宿主（taskkill /T 只杀监听 6099 的宿主树）→ launch_napcat_host()
    重新拉起（autoLogin 已是目标号 → 免扫码自动登录目标号）。"""
    cur = napcat_online_uin()
    if cur is not None and str(cur) == str(uin):
        log('  NapCat 已是目标账号 uin={}'.format(uin))
        return True
    # 修复：宿主休眠（webui 不可达，cur=None）时，先唤醒宿主再继续，
    # 否则 SetQuickLoginQQ 会因连不上而失败，被误判"票据失效"冻结进 manual。
    if cur is None and not napcat_alive():
        log('  宿主休眠中，先唤醒再切号 target={}'.format(uin))
        mark_host_busy()
        if not ensure_host_awake(timeout=45.0):
            log('  唤醒宿主失败，取消本次切号')
            return False
        # 唤醒后宿主可能已自动登录了驻留号，重新读取当前 uin
        cur = napcat_online_uin()
    log('  NapCat 切号: cur={} -> target={}'.format(cur, uin))

    # 1) 写 autoLogin=目标号（不重启，安全）
    if not napcat_set_autologin(uin):
        log('    SetQuickLoginQQ 失败（write autoLogin）')
        return False

    # 2) 优雅停宿主并等其彻底退出（napcat_stop_host 已内含 6099 释放等待）
    stopped = napcat_stop_host()
    if stopped == 0:
        log('    宿主未在运行，直接拉起')
    else:
        log('    宿主已停并彻底退出，准备拉起新宿主')

    # 3) 重新拉起宿主（webui autoLogin 已是目标号 → 自动登录）
    #    同时显式传 quick_uin：只靠 webui.json 的 autoLoginAccount 在冷启动时会因
    #    getQQQuickLoginList() 为空而不触发（见 launch_napcat_host 注释）。
    if not launch_napcat_host(quick_uin=uin):
        log('    切号：拉起宿主失败')
        return False

    log('    切号：宿主拉起，等待自动登录 uin={}'.format(uin))
    if not napcat_wait_uin(uin):
        log('    登录等待超时 (uin={})'.format(uin))
        return False
    return True


def _release_account(aid):
    """补码成功后把 NapCat 登录态从该账号"让出"（用户诉求）。

    farm 端账号在线由服务端会话维持（注入 code 后即 running=True），本机 NapCat
    无需持续登录该号。因此补完码后把宿主切到驻留号（默认希恩斯，纯 bot 号），
    释放该 QQ 号的登录态，用户便能用自己的 QQ 客户端正常登录聊天/传文件。
    仅对 RELEASE_AFTER_FIX 列表内的账号生效；宿主当前若已不在该号则跳过。
    """
    if str(aid) not in [str(x) for x in RELEASE_AFTER_FIX]:
        return
    if not RELEASE_TARGET_UIN:
        return
    try:
        cur = napcat_online_uin()
    except Exception:
        cur = None
    try:
        ok = switch_to_account(RELEASE_TARGET_UIN)
        if ok:
            log('  已让出账号 id={}（宿主切驻留 uin={}），该号可被用户正常登录'.format(
                aid, RELEASE_TARGET_UIN))
        else:
            log('  让出账号 id={} 失败（切驻留号未成功）'.format(aid))
    except Exception as e:
        log('  让出账号 id={} 异常: {}'.format(aid, e))


_last_switch_failed = False       # 本次 fix_one 是否卡在切号（判票据失效用）


def fix_one(acc):
    global _last_switch_failed
    _last_switch_failed = False
    # 补码即使用宿主，标记为本段活跃，防止空闲停机线程在补码中途杀宿主
    mark_host_busy()
    aid = acc['id']
    uin = ACCOUNT_UIN.get(aid)
    if not uin:
        log('  账号 {} 无映射，跳过'.format(aid))
        return False
    if not acc.get('openId'):
        log('  账号 {} 无 openId，跳过'.format(aid))
        return False
    if not switch_to_account(uin):
        log('  切号失败 (id={})'.format(aid))
        _last_switch_failed = True
        return False

    code = napcat_fetch_code()
    if not code:
        log('  取码失败 (id={})'.format(aid))
        return False
    log('  取码成功 code={}... (id={})'.format(code[:8], aid))

    token = panel_login()
    if not token:
        log('  farm 登录失败 (id={})'.format(aid))
        return False
    # ⭐ 僵尸 worker 必须先 stop 再 complete（2026-11-01）。
    # 现状：gateway 重启后 worker 进程活着但 socket 已断，且它自己不会重连。
    # 若只 inject+complete 而不停旧进程，新 Code 会注入进去、complete 也返回 ok，
    # 但旧 worker 依然挂在断开的 socket 上发不出去请求，表现仍是"离线"。
    # 先 stop 让主容器杀掉该 worker 进程，complete 时才会 fork 一个干净的新进程。
    if acc.get('running'):
        try:
            panel_stop_account(token, aid)
            time.sleep(2)
            log('  已先停止僵尸 worker 进程 (id={})'.format(aid))
        except Exception as e:
            log('  停止僵尸 worker 失败(继续尝试): {}'.format(str(e)[:60]))
    flow = panel_create_flow(token, aid)
    if not flow:
        log('  建 flow 失败 (id={})'.format(aid))
        return False
    if not panel_inject(token, flow, code, acc['openId'], acc.get('gid', '')):
        log('  inject 失败 (id={})'.format(aid))
        return False
    if not panel_complete(token, flow):
        log('  complete 失败 (id={})'.format(aid))
        return False
    log('  已 complete，farm 拉起账号 (id={})'.format(aid))

    # 补完码即让出：把 NapCat 登录态从该号切走，还给用户（用户可正常登 QQ）
    _release_account(aid)
    return True


def one_scan(token):
    """跑一轮掉线检查并补码。fixed==-1 表示列表拉取异常。"""
    accs = panel_qq_accounts(token)
    if not accs:
        return -1
    fixed = 0
    for ac in accs:
        # ⭐ 判定"是否需要补码"必须看 connected，而不是 running（2026-11-01 修正）。
        # running 只表示 worker 进程存活；gateway 重启后会留下"僵尸 worker"：
        # 进程活着、socket 已断、既不重连也不退出 → 按 running 判定会永远认为"没掉线"，
        # 实际面板显示离线、守护却报"无掉线账号"，账号就这么一直挂着。
        # 策略：
        #   - running=False            → 确定掉线（进程都没了）
        #   - running=True 且 connected=False → 僵尸 worker，也要补码
        #   - connected 查询失败(None)  → 保守按 running 判定，不因接口抖动误补码
        needs_fix = False
        if not ac['running']:
            needs_fix = True
        else:
            connected = panel_qq_connected(token, ac['id'])
            if connected is False:
                needs_fix = True
                bkey = 'zombie:{}'.format(ac['id'])
                if time.time() - _last_skip_log.get(bkey, 0) >= 600:
                    _last_skip_log[bkey] = time.time()
                    log('检测到僵尸 worker(进程在但连接已断): id={} {}'.format(ac['id'], ac['name']))
        if not needs_fix:
            continue
        # 主动让给用户的账号：不补码、不切号、不重启宿主
        if str(ac['id']) in [str(x) for x in SKIP_ACCOUNT_IDS]:
            if time.time() - _last_skip_log.get(str(ac['id']), 0) >= 3600:
                _last_skip_log[str(ac['id'])] = time.time()
                log('跳过补码(已让给用户): id={} {}'.format(ac['id'], ac['name']))
            continue
        # 风控熔断：单号限频 / 冷却 / 需人工扫码
        reason = circuit_block_reason(ac['id'])
        if reason:
            bkey = 'block:{}'.format(ac['id'])
            if time.time() - _last_skip_log.get(bkey, 0) >= 1800:
                _last_skip_log[bkey] = time.time()
                log('跳过补码[{}]: id={} {}'.format(reason, ac['id'], ac['name']))
            continue
        log('检测到掉线: id={} {}'.format(ac['id'], ac['name']))
        circuit_note_try(ac['id'])
        try:
            ok = fix_one(ac)
        except Exception as e:
            log('账号 {} 处理异常: {}'.format(ac['id'], e))
            ok = False
        circuit_note_result(ac['id'], ok, switch_failed=_last_switch_failed)
        if ok:
            fixed += 1
    if fixed == 0:
        # 去噪：不每轮都打"本轮无掉线账号"（原每 120s 一条→占用日志）。
        # 只在"首次进入空闲"和"空闲超过 N 小时"时提醒一次。
        now = time.time()
        if (_last_no_drop_log[0] == 0) or (now - _last_no_drop_log[0] >= 3600):
            _last_no_drop_log[0] = now
            log('  无掉线账号（已空闲，不逐轮重复记录）')
    else:
        _last_no_drop_log[0] = 0   # 有补码动作→刷新去噪基准
        log('  本轮补码成功 {} 个'.format(fixed))
    return fixed


def one_scan_debug():
    """--once 调试入口。"""
    token = panel_login()
    if not token:
        return 'panel_off', '面板不可达'
    if not napcat_alive():
        if not HOST_HIBERNATE:
            return 'napcat_off', 'NapCat 不可达'
        # 休眠模式下宿主休眠属正常态，继续跑掉线检测
        print('note: host hibernating (HOST_HIBERNATE=True), will wake on demand if drop')
    user_det, user_dtl = user_qq_present()
    print('user_qq_present: {} ({})'.format(user_det, user_dtl))
    if USER_QQ_POLICY == 'skip' and user_det:
        return 'skip', '用户QQ占用'
    fixed = one_scan(token)
    return 'ok', 'fixed={}'.format(fixed)


def main():
    load_config()
    circuit_load()
    if '--reset' in sys.argv:
        circuit_reset()
        return
    if STOP:
        stop_daemon()
    if ONCE:
        s, msg = one_scan_debug()
        print('scan done, state={} msg={}'.format(s, msg))
        try:
            print('circuit:', json.dumps(_circuit, ensure_ascii=False)[:800])
        except Exception:
            pass
        return
    handle_singleton()
    log('========== napcat-code-guard 启动 userQqPolicy={} memCtrl={} relay={} hiber={} powerSave={} =========='.format(
        USER_QQ_POLICY, 'on' if MEM_CTRL else 'off',
        'on' if (RELAY_ENABLED and RELAY_TOKEN) else 'off',
        'on' if HOST_HIBERNATE else 'off',
        ('battery-{}s'.format(int(BATTERY_POLL))) if POWER_SAVE_ON_BATTERY else 'off'))
    if MEM_CTRL:
        start_memory_thread()
    # QQ 扫码中转（与补码主循环互斥，独立线程）
    start_relay_thread()
    # 宿主休眠模式：空闲自动停宿主（初始处于休眠则预估按需启停）
    if HOST_HIBERNATE:
        start_host_idle_thread()
        log('  宿主休眠模式已启用：无任务时按需启停宿主（空闲 {}min 自动停）'.format(
            HOST_IDLE_STOP_MIN))
        mark_host_busy()
    # 确保常驻 NapCat 控制台隐藏监控在守护启动后立即就位（幂等单例），
    # 这样无论宿主何时/多次(重)拉起，其 Electron 日志控制台都被极快隐藏，不弹不抢焦点。
    _ensure_hide_console()

    was_off = True
    last_warn = [0.0]
    _bat_logged = [False]   # 电池挂起日志去噪（进入/退出各打一次）
    while True:
        # 0) 电源感知节能：仅电池供电时轻挂起——不做任何补码/切号/拉宿主，
        #    只按 BATTERY_POLL 间隔醒来看一眼电源，插电后自动恢复正常轮询。
        if on_battery():
            if not _bat_logged[0]:
                _bat_logged[0] = True
                ac, pct = _power_status()
                log('[节能] 当前为电池供电（电量{}%）→ 挂起监测（每{}s 探测电源，插电即刻恢复；不补码不拉宿主）'.format(
                    pct if pct >= 0 else '?', int(BATTERY_PROBE)))
            # 电池模式下若宿主还开着（刚拔电瞬间），主动停掉以省电
            if HOST_HIBERNATE and napcat_alive():
                try:
                    napcat_stop_host()
                except Exception:
                    pass
            # 分片睡眠：不一次性长睡 BATTERY_POLL，而是每 BATTERY_PROBE 秒醒一次
            # 检查电源，一旦插电立即跳出恢复（最长延迟=BATTERY_PROBE），避免
            # "插了电还要等半小时才恢复"的糟糕体验。挂起期间几乎零 CPU/网络开销。
            slept = 0.0
            while slept < BATTERY_POLL:
                time.sleep(BATTERY_PROBE)
                slept += BATTERY_PROBE
                if not on_battery():
                    break
            continue
        if _bat_logged[0]:
            _bat_logged[0] = False
            log('[节能] 已恢复交流供电 → 恢复正常轮询（{}s）'.format(POLL))
        # 0.5) 扫码任务占用宿主时让路（不补码、不切号、不自愈）
        if _relay_busy[0]:
            time.sleep(3)
            continue
        # 1) 面板可达
        token = panel_login()
        if not token:
            if not was_off:
                log('面板不可达（断网/服务器），离线; {}s 后重试'.format(NET_RETRY))
            was_off = True
            time.sleep(NET_RETRY)
            continue
        # 2) NapCat 可达
        if not napcat_alive():
            if HOST_HIBERNATE:
                # 休眠模式：宿主休眠时 webui 不可达属"正常态"，不强制拉起宿主，
                # 也不死等重试。farm 账号在线由服务器端 gateway 会话维持，与宿主无关；
                # 只有检测到掉线需补码 / 收到扫码任务时才会按需唤醒宿主
                # （在 switch_to_account / ensure_host_awake 内）。
                # 不动 was_off：避免把"宿主休眠"误报成网络离线/连接恢复。
                pass
            else:
                # 传统常驻模式：NapCat 失联即自愈拉起（cooldown 限频）
                if not was_off:
                    log('NapCat 不可达（宿主未启动），尝试自愈拉起，{}s 重试'.format(NAPCAT_RETRY))
                launch_napcat_host(force=False)
                was_off = True
                time.sleep(NAPCAT_RETRY)
                continue
        if was_off and napcat_alive():
            log('连接恢复，补扫')
        was_off = False

        # 3) 用户 QQ 感知 + 策略
        ud, udtl = user_qq_present()
        if ud:
            if time.time() - last_warn[0] >= USER_QQ_WARN_REPEAT:
                last_warn[0] = time.time()
                log('[感知] 检测到用户日常 QQ：{}（策略={}）'.format(
                    udtl, '照常补码' if USER_QQ_POLICY == 'normal' else '跳过补码'))
            if USER_QQ_POLICY == 'skip':
                time.sleep(POLL)
                continue

        # 3.5) 全局熔断暂停（风暴保护：暂停期内不做任何补码/切号）
        if time.time() < float(_circuit.get('pausedUntil', 0) or 0):
            left = int(float(_circuit['pausedUntil']) - time.time())
            if time.time() - _last_skip_log.get('storm', 0) >= 600:
                _last_skip_log['storm'] = time.time()
                log('[熔断] 全局暂停中，剩 {}s，本轮不补码（确认无封禁后可 --reset 提前放行）'.format(left))
            time.sleep(min(POLL, 60))
            continue

        # 4) 补码（占用宿主机，置闸门让扫码线程等待）
        _scan_busy[0] = True
        try:
            one_scan(token)
        except Exception as e:
            log('扫描异常: {}'.format(e))
        finally:
            _scan_busy[0] = False

        time.sleep(POLL)


if __name__ == '__main__':
    main()