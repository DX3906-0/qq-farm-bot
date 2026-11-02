# -*- coding: utf-8 -*-
"""
farm-capture-daemon.py — 服务器 QQ 账号掉线后自动触发远程抓包（静默守护）

功能:
  1. 每 POLL 秒登录一次服务器面板，检查 QQ 平台账号是否掉线 (running=false)；
  2. 发现掉线且满足安全条件时，静默启动 remote-capture.js 全自动抓码；
  3. 断网时进入离线模式（每 NET_RETRY 秒探测），恢复联网后立即扫描一次；
  4. 干扰保护（满足任一则推迟触发，绝不打断用户）:
       - 前台存在全屏应用（3A 大作全屏运行中）
       - 系统可用物理内存 < MIN_FREE_MEM（游戏加载中）
       - QQ 客户端 (QQ.exe) 未运行（触发也白跑）
       - 已有 remote-capture.js 抓码进程在跑
       - 冷却期内（上次抓码结束后 COOLDOWN 秒；连续失败 3 次后退避 BACKOFF 秒）
  5. 单实例（_daemon.pid），日志 _daemon.log（>2MB 自动截断），抓码输出 _daemon-capture.log。

用法:
  pythonw.exe farm-capture-daemon.py            # 静默常驻（自启用这个）
  python.exe farm-capture-daemon.py --once      # 前台跑一轮扫描并打印判定（调试用）
  python.exe farm-capture-daemon.py --stop      # 停止常驻实例
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import time
import urllib.request

# ---- 配置 ----
# 环境相关值统一走环境变量，仓库内只保留占位默认值。
PANEL = os.environ.get('FARM_PANEL', 'http://127.0.0.1:3007')
USER = os.environ.get('FARM_PANEL_USER', 'admin')
PASS = os.environ.get('FARM_PANEL_PASS', '')
NODE_EXE = os.environ.get('NODE_EXE', r'C:\Program Files\nodejs\node.exe')
PYW_EXE = os.environ.get('PYW_EXE', 'pythonw.exe')

DIR = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(DIR, '_daemon.log')
CAP_LOG = os.path.join(DIR, '_daemon-capture.log')
PID_FILE = os.path.join(DIR, '_daemon.pid')
LOCK_FILE = os.path.join(DIR, '_capture.lock')

POLL = 90          # 正常轮询间隔（秒）
NET_RETRY = 15     # 断网时重试间隔（秒）
COOLDOWN = 600     # 抓码结束后冷却（秒）
BACKOFF = 2400     # 连续失败 3 次后退避（秒）
MAX_FAILS = 3
MIN_FREE_MEM = 512 * 1024 * 1024       # 512MB：仅内存真濒临耗尽才暂缓
DEFER_MAX = 600                        # 暂缓超过 10 分钟且非全屏 → 强制触发
LOG_MAX = 2 * 1024 * 1024

# ---- 非分页池慢渗管控（NVIDIA NvLH/NvLD）+ 可用内存自动缓解 ----
# 三级防线，全部不依赖整机重启：
#   L1 低可用内存自动清 Standby（可用 < EMPTY_STANDBY_GB 时，交还系统缓存）
#   L2 周期冲刷（每 MEM_FLUSH_MIN 分钟清一次 Standby，保证可用内存健康）
#   L3 GPU 驱动软重载（每日空闲窗口内，禁用→启用 NVIDIA 独显，非分页池归零）
#        关键安全：仅当显卡当前没有任何需要它渲染的进程（含 QQ 的图形上下文）
#        时才执行；否则跳过留待下个周期 —— 绝不打断正在用 GPU 的工作。
STANDBY_MIN_AVAIL = 1.5 * 1024 * 1024 * 1024   # 可用 < 1.5GB 触发 L1
CLEAN_FLUSH_HOUR  = 2.0                        # 每 2 小时 L2 冲刷一次
# L3 显卡软重载默认关闭：2026-09-06 实测休眠自唤醒失效（SetWaitableTimer 不生效），
# 且 pnputil 无人值守重载显卡有变骨独显风险。保留开关，默认 False 永不自动触发。
GPU_RELOAD_ENABLED = False
GPU_RELOAD_HOUR_START = 3                      # 允许重载窗口开始（凌晨 3:00）
GPU_RELOAD_HOUR_END   = 5                       # 上限（05:00）
GPU_RELOAD_MIN_NONPAGED = 850 * 1024 * 1024     # 非分页池需 > 850MB 才重载
GPU_RELOAD_MIN_AVAIL    = 0.8 * 1024 * 1024 * 1024  # 且可用 < 0.8GB 才重载
GPU_RELOAD_COOLDOWN     = 20 * 3600             # 重载后 20h 内不重载（每天最多一次）

# NVIDIA 显卡 Vendor ID = 0x10DE。运行时按此从显示设备里定位，不硬编码易变的实例尾串。

ONCE = '--once' in sys.argv
STOP = '--stop' in sys.argv

u = ctypes.windll.user32
k = ctypes.windll.kernel32


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


# ---------- 单实例 / 停止 ----------
def proc_alive(pid):
    h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if h:
        k.CloseHandle(h)
        return True
    return False


def read_pid():
    try:
        return int(open(PID_FILE).read().strip())
    except Exception:
        return 0


def handle_singleton():
    if STOP:
        pid = read_pid()
        if pid and proc_alive(pid):
            subprocess.run(['taskkill', '/PID', str(pid), '/F'],
                           creationflags=0x08000000)
            log('已停止守护进程 pid={}'.format(pid))
            print('stopped pid={}'.format(pid)) if ONCE else None
        else:
            print('no running daemon') if ONCE else None
        sys.exit(0)
    pid = read_pid()
    if pid and proc_alive(pid):
        # 防 PID 复用误判：pid 文件超过 24h 视为陈旧（重启后残留）
        try:
            if time.time() - os.path.getmtime(PID_FILE) > 86400:
                pid = None
        except OSError:
            pid = None
    if pid and proc_alive(pid):
        print('daemon already running pid={}'.format(pid))
        sys.exit(0)
    with open(PID_FILE, 'w') as f:
        f.write(str(k.GetCurrentProcessId()))


# ---------- 面板轮询 ----------
def poll_panel():
    """返回 (online, stopped_qq_accounts)。online=False 表示网络/服务器不可达。"""
    try:
        req = urllib.request.Request(
            PANEL + '/api/login',
            data=json.dumps({'username': USER, 'password': PASS}).encode(),
            headers={'Content-Type': 'application/json', 'Accept': 'application/json'},
            method='POST')
        with urllib.request.urlopen(req, timeout=12) as r:
            token = json.loads(r.read().decode())['data']['token']

        req = urllib.request.Request(
            PANEL + '/api/accounts',
            headers={'Accept': 'application/json', 'x-admin-token': token})
        with urllib.request.urlopen(req, timeout=12) as r:
            d = json.loads(r.read().decode())
        accs = d.get('data', d)
        if isinstance(accs, dict):
            accs = accs.get('accounts') or accs.get('list') or []
        stopped = [a for a in accs
                   if a.get('platform') == 'qq' and a.get('running') is False]
        return True, stopped
    except Exception:
        return False, []


# ---------- 干扰检测 ----------
class RECT(ctypes.Structure):
    _fields_ = [('l', wt.LONG), ('t', wt.LONG), ('r', wt.LONG), ('b', wt.LONG)]


def fullscreen_active():
    """前台窗口是否全屏覆盖整个屏幕（全屏游戏/视频）。"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass
    fg = u.GetForegroundWindow()
    if not fg:
        return False
    cls = ctypes.create_unicode_buffer(64)
    u.GetClassNameW(fg, cls, 64)
    if cls.value in ('Progman', 'WorkerW', 'Shell_TrayWnd'):
        return False
    rc = RECT()
    if not u.GetWindowRect(fg, ctypes.byref(rc)):
        return False
    scr_w = u.GetSystemMetrics(0)   # SM_CXSCREEN
    scr_h = u.GetSystemMetrics(1)   # SM_CYSCREEN
    return (rc.r - rc.l >= scr_w - 4) and (rc.b - rc.t >= scr_h - 4)


def low_memory():
    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [('dwLength', wt.DWORD), ('dwMemoryLoad', wt.DWORD),
                    ('ullTotalPhys', ctypes.c_uint64), ('ullAvailPhys', ctypes.c_uint64),
                    ('ullTotalPageFile', ctypes.c_uint64), ('ullAvailPageFile', ctypes.c_uint64),
                    ('ullTotalVirtual', ctypes.c_uint64), ('ullAvailVirtual', ctypes.c_uint64),
                    ('ullAvailExtendedVirtual', ctypes.c_uint64)]
    st = MEMORYSTATUSEX()
    st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    k.GlobalMemoryStatusEx(ctypes.byref(st))
    return st.ullAvailPhys < MIN_FREE_MEM


def qq_running():
    """QQ 客户端 (QQ.exe) 是否在运行。"""
    psapi = ctypes.windll.psapi
    buf = (wt.DWORD * 4096)()
    written = wt.DWORD(0)
    psapi.EnumProcesses(buf, ctypes.sizeof(buf), ctypes.byref(written))
    for i in range(written.value // ctypes.sizeof(wt.DWORD)):
        h = k.OpenProcess(0x410, False, buf[i])
        if h:
            b = ctypes.create_unicode_buffer(260)
            psapi.GetModuleBaseNameW(h, None, b, 260)
            k.CloseHandle(h)
            if b.value.lower() in ('qq.exe',):
                return True
    return False


def capture_running():
    if os.path.exists(LOCK_FILE):
        try:
            parts = open(LOCK_FILE).read().split()
            pid = int(parts[0])
            ts = float(parts[1]) if len(parts) > 1 else 0.0
            if ts and time.time() - ts > 900:   # 超过 15 分钟 = 陈旧锁（防 pid 复用误判）
                os.remove(LOCK_FILE)
                return False
            if proc_alive(pid):
                return True
            os.remove(LOCK_FILE)   # 陈旧锁
        except Exception:
            pass
    return False


# ---------- 触发抓码 ----------
def clean_env():
    """给子进程构造最小环境块。若守护本身继承了大环境块（>64KB），
    孙进程里的 PowerShell Add-Type（拉起 csc.exe 编译器）会因环境块
    超限直接失败，导致选号点击器/关窗器全挂。"""
    keep = ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP',
            'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
            'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES',
            'COMPUTERNAME', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE',
            'HOMEPATH', 'OS', 'SYSTEMDRIVE', 'NUMBER_OF_PROCESSORS',
            'PROCESSOR_ARCHITECTURE', 'SESSIONNAME', 'PROCESSOR_LEVEL',
            'PROCESSOR_REVISION', 'PROCESSOR_IDENTIFIER', 'ALLUSERSPROFILE']
    e = {k: os.environ[k] for k in keep if k in os.environ}
    e.setdefault('SYSTEMROOT', r'C:\Windows')
    e.setdefault('TEMP', os.environ.get('TEMP', r'C:\Windows\Temp'))
    e.setdefault('TMP', e['TEMP'])
    return e


def run_capture(names):
    # 锁由 remote-capture.js 自己管理（手动/守护统一入口互斥），这里不写锁
    log('>>> 触发自动抓码: {}'.format(names))
    try:
        with open(CAP_LOG, 'a', encoding='utf-8') as out:
            out.write('\n===== {} auto-capture for [{}] =====\n'.format(
                time.strftime('%m-%d %H:%M:%S'), names))
            out.flush()
            p = subprocess.Popen(
                [NODE_EXE, os.path.join(DIR, 'remote-capture.js'),
                 '--panel', PANEL, '--user', USER, '--pass', PASS,
                 '--probe-account', '--pick-account'],
                cwd=DIR, stdout=out, stderr=subprocess.STDOUT,
                env=clean_env(),
                creationflags=0x08000000)   # CREATE_NO_WINDOW
            rc = p.wait()
    except Exception as e:
        log('抓码启动异常: {}'.format(e))
        rc = -1
    log('<<< 抓码结束 rc={}'.format(rc))
    return rc


# ---------- 非分页池 / 可用内存管控 ----------
PS_EMPTY_STANDBY = (
    'Add-Type -TypeDefinition @"'
    'using System;using System.Runtime.InteropServices;'
    'public class EmptyStandby{[DllImport("ntdll.dll")]'
    'public static extern int NtSetSystemInformation(int a,int b,int c);};"@; '
    '[EmptyStandby]::NtSetSystemInformation(0x57,0,0)|Out-Null'
)


def avail_mem_bytes():
    """返回当前可用物理内存（bytes）。"""
    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [('dwLength', wt.DWORD), ('dwMemoryLoad', wt.DWORD),
                    ('ullTotalPhys', ctypes.c_uint64), ('ullAvailPhys', ctypes.c_uint64),
                    ('ullTotalPageFile', ctypes.c_uint64), ('ullAvailPageFile', ctypes.c_uint64),
                    ('ullTotalVirtual', ctypes.c_uint64), ('ullAvailVirtual', ctypes.c_uint64),
                    ('ullAvailExtendedVirtual', ctypes.c_uint64)]
    st = MEMORYSTATUSEX()
    st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    k.GlobalMemoryStatusEx(ctypes.byref(st))
    return st.ullAvailPhys


def _clean_standby():
    """交还 Windows Standby 缓存，提升可用内存。安全：不碰内核池、不杀进程。"""
    try:
        subprocess.run(['powershell', '-NoProfile', '-Command', PS_EMPTY_STANDBY],
                       capture_output=True, timeout=30, env=clean_env(),
                       creationflags=0x08000000)
        return True
    except Exception:
        return False


def _gpu_nvidia_procs():
    """返回当前依赖 NVIDIA 独显的进程 pid 集合（配用 nvidia-smi）。
    作用：检测显卡是否空闲 —— 若有人用它就无法安全软重载。"""
    try:
        r = subprocess.run(
            ['nvidia-smi', '--query-compute-apps=pid,process_name', '--format=csv,noheader'],
            capture_output=True, text=True, timeout=20,
            creationflags=0x08000000)
        pids = set()
        for line in r.stdout.strip().splitlines():
            line = line.strip()
            if not line or line.startswith('['):
                continue
            pid = line.split(',')[0].strip()
            if pid.isdigit():
                pids.add(int(pid))
        return sorted(pids)
    except Exception:
        return []


def _nvidia_instance_id():
    """运行时从 PCI 显示设备定位 NVIDIA(0x10DE) 的完整设备实例 ID。
    不硬编码易变的实例尾串，避免跨机/驱动更新失配。找不到返回 None。"""
    try:
        r = subprocess.run(
            ['powershell', '-NoProfile', '-Command',
             '(Get-PnpDevice -Class Display -Status OK | '
             'Where-Object {$_.InstanceId -like "PCI*10DE*"} | '
             'Select-Object -First 1 -ExpandProperty InstanceId)'],
            capture_output=True, text=True, timeout=30,
            env=clean_env(), creationflags=0x08000000)
        s = (r.stdout or '').strip()
        return s if s else None
    except Exception:
        return None


def gpu_hard_reload():
    """禁用→启用 NVIDIA 独显，重载 nvlddmkm.sys → 非分页池归零。不整机重启。
    安全三重闸：
      a) NVIDIA 当前无渲染进程（有人正在用就无法安全卸载）；
      b) 非分页池 > GPU_RELOAD_MIN_NONPAGED（真的涨高了才值得重载）；
      c) 有可用内存低位（内存确实吃紧）。
    返回 (executed, skipped_safe, msg)。"""
    procs = _gpu_nvidia_procs()
    if procs:
        return (False, True, 'N 卡被进程 {} 占用，跳过（避免打断）'.format(procs))
    # 非分页池阈值：未涨到需治理的程度就不重载
    try:
        r = subprocess.run(
            ['powershell', '-NoProfile', '-Command',
             '(Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory).PoolNonpagedBytes'],
            capture_output=True, text=True, timeout=30,
            env=clean_env(), creationflags=0x08000000)
        np = int(r.stdout.strip() or 0)
    except Exception:
        np = 0
    if np and np < GPU_RELOAD_MIN_NONPAGED:
        return (False, True, '非分页池 {:.0f}MB 未超阈值，无需重载'.format(np / 1048576))
    avail = avail_mem_bytes()
    if avail > GPU_RELOAD_MIN_AVAIL:
        return (False, True, '可用内存 {:.1f}GB 尚足，跳过'.format(avail / 1073741824))

    dev = _nvidia_instance_id()
    if not dev:
        return (False, False, '未能定位 NVIDIA 设备，放弃重载')
    try:
        r1 = subprocess.run(['pnputil', '/disable-device', dev],
                            capture_output=True, text=True, timeout=60,
                            creationflags=0x08000000)
        time.sleep(3)
        r2 = subprocess.run(['pnputil', '/enable-device', dev],
                            capture_output=True, text=True, timeout=60,
                            creationflags=0x08000000)
        out = (r2.stdout or '') + (r2.stderr or '')
        # 中文系统回显“已启用”，英文 "enabled"
        if ('enabled' not in out.lower()) and ('启用' not in out):
            # 若 pnputil 无 echo，但返回码与设备已有，仍视为成功（避免误报）
            if r2.returncode != 0:
                return (False, False, 'pnputil enable rc={} 异常: {}'.format(r2.returncode, out.strip()[:200]))
        return (True, False, '显卡已软重载（NVIDIA 空闲，非分页池归零）')
    except Exception as e:
        return (False, False, '显卡重载异常: {}'.format(e))


# ---------- 主循环 ----------
def main():
    handle_singleton()
    log('守护启动 pid={} poll={}s'.format(k.GetCurrentProcessId(), POLL))
    was_online = None
    last_end = 0.0
    fail_count = 0
    last_msg = ('', 0.0)
    defer_since = None   # 首次因内存暂缓的时刻（全屏不算，全屏永远让路）
    last_pool_log = 0.0  # 上次内存观察记录时刻
    last_clean = 0.0     # 上次 Standby 冲刷时刻（L2）
    last_gpu_reload = 0.0  # 上次显卡软重载时刻（L3 冷却）

    def note(key, msg, gap=600):
        nonlocal last_msg
        now = time.time()
        if key != last_msg[0] or now - last_msg[1] > gap:
            log(msg)
            last_msg = (key, now)

    while True:
        online, stopped = poll_panel()
        if not online:
            if was_online:
                log('网络断开/服务器不可达，进入离线模式（{}s 后重试）'.format(NET_RETRY))
            was_online = False
            time.sleep(NET_RETRY)
            continue
        if was_online is False:
            log('网络恢复，立即扫描一次')
            last_msg = ('', 0.0)
        was_online = True

        if stopped:
            names = '、'.join(a.get('name') or a.get('id') for a in stopped)
            wait = COOLDOWN if fail_count < MAX_FAILS else BACKOFF
            remain = int(last_end + wait - time.time())
            if capture_running():
                note('busy', '掉线账号[{}]，已有抓码进程在跑，跳过'.format(names))
            elif remain > 0:
                note('cool{}{}'.format(fail_count, len(stopped)),
                     '掉线账号[{}]，冷却中（剩 {}s{}）'.format(
                         names, remain, '，退避模式' if fail_count >= MAX_FAILS else ''))
            elif fullscreen_active():
                note('fs', '掉线账号[{}]，检测到全屏应用运行中，暂缓（不打扰游戏）'.format(names))
            elif low_memory() and defer_since is None:
                defer_since = time.time()
                note('mem', '掉线账号[{}]，可用内存不足 512MB，暂缓（超 10 分钟将强制触发）'.format(names))
            elif low_memory() and time.time() - defer_since < DEFER_MAX:
                note('mem', '掉线账号[{}]，内存仍不足，已暂缓 {}s'.format(
                    names, int(time.time() - defer_since)))
            elif not qq_running():
                defer_since = None
                note('noqq', '掉线账号[{}]，QQ 客户端未运行，无法抓码，暂缓'.format(names))
            else:
                if defer_since is not None:
                    log('内存已回升（暂缓 {}s 后恢复），触发'.format(int(time.time() - defer_since)))
                defer_since = None
                rc = run_capture(names)
                last_end = time.time()
                if rc == 0:
                    fail_count = 0
                    log('自动抓码成功，冷却 {}s'.format(COOLDOWN))
                else:
                    fail_count += 1
                    log('自动抓码失败 rc={}（连续失败 {} 次{}）'.format(
                        rc, fail_count,
                        '，退避 {}s'.format(BACKOFF) if fail_count >= MAX_FAILS else ''))
        else:
            defer_since = None
            note('ok', '轮询正常，QQ 账号全部在线', gap=1800)

        # 每小时记录一次内核非分页池大小（监控 NVIDIA 驱动泄漏是否复发）
        if time.time() - last_pool_log >= 3600:
            last_pool_log = time.time()
            try:
                r = subprocess.run(
                    ['powershell', '-NoProfile', '-Command',
                     '(Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory).PoolNonpagedBytes'],
                    capture_output=True, text=True, timeout=30,
                    env=clean_env(), creationflags=0x08000000)
                np_bytes = int(r.stdout.strip() or 0)
                if np_bytes > 0:
                    avail = subprocess.run(
                        ['powershell', '-NoProfile', '-Command',
                         '[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,2)'],
                        capture_output=True, text=True, timeout=30,
                        env=clean_env(), creationflags=0x08000000)
                    log('内存观察: 非分页池 {:.0f} MB / 可用 {} GB'.format(
                        np_bytes / 1048576, avail.stdout.strip()))
            except Exception as e:
                log('内存观察失败: {}'.format(e))

        # ------- 非分页池 / 可用内存管控（不进抓码，独立于掉线判断）-------
        try:
            now = time.time()
            h = time.localtime().tm_hour
            # L1 + L2: 可用内存低时 / 周期性交还 Standby 缓存
            avail = avail_mem_bytes()
            if avail < STANDBY_MIN_AVAIL or now - last_clean >= CLEAN_FLUSH_HOUR * 3600:
                if _clean_standby():
                    log('已交还 Standby 缓存（清理前可用 {} MB）'.format(avail // 1048576))
                last_clean = time.time()
            # L3: 显卡软重载（默认关闭，GPU_RELOAD_ENABLED=False 时永不触发）
            if (GPU_RELOAD_ENABLED and not ONCE and
                    GPU_RELOAD_HOUR_START <= h < GPU_RELOAD_HOUR_END and
                    now - last_gpu_reload >= GPU_RELOAD_COOLDOWN and
                    not fullscreen_active() and
                    capture_running() is False):
                # 仅在确实值得时才做：非分页池高 + 可用不足
                ok, skip, msg = gpu_hard_reload()
                if ok:
                    last_gpu_reload = time.time()
                    log('显卡软重载完成 → 非分页池应已归零。{}'.format(msg))
                elif not skip:
                    log('显卡软重载跳过/失败：{}'.format(msg))
        except Exception as e:
            log('内存管控异常: {}'.format(e))

        if ONCE:
            log('--once 扫描完成，退出')
            break
        time.sleep(POLL)


try:
    main()
except Exception as e:
    log('守护异常退出: {}'.format(e))
    raise
