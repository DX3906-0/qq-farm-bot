#!/usr/bin/env python3
"""后台触发 QQ 农场窗口加载 —— 不抢前台焦点。

核心策略
--------
农场是 QQ 小程序（Chromium/Electron）窗口，处于后台或被遮挡时会暂停渲染 → 白屏。
必须在它出现后激活一次才能触发加载。但激活时机非常关键：

  打开快捷方式 → 弹「选择账号」框(400x400, title=[QQ]) → pick-account.py 点掉
  → 农场窗口才创建(title=[QQ经典农场])

原实现在 launchShortcut 后固定 sleep 3s 就跑一次查找，此时农场窗口尚未创建，
直接 FARM_WINDOW_NOT_FOUND 退出 → 从未激活 → 白屏。这就是"后台白屏"的根因。

本脚本改为：
  1. 轮询等待农场窗口出现（默认最长 90s），不再依赖外部 sleep 的时序巧合；
  2. 找到后移到屏幕外(x=-800)激活 —— 用户看不到、也不占用屏幕中央；
  3. 持续监测窗口尺寸：Chromium 被遮挡时会把窗口缩到 ~200x405 并暂停渲染，
     监测到异常缩小就补一次激活（避免持续抢焦点打断用户操作）；
  4. 加载完成后停靠：默认 --dock corner 只露左边缘 24px（一个角），
     不占屏幕工作区；--dock off 完全屏幕外；--dock orig 移回原位。
     抓包完成后由 remote-capture.js 调 close-farm.ps1 自动关闭小程序。

用法:
  python activate-farm.py [--wait 90] [--load 8] [--verify 20]
                          [--dock corner|off|orig] [--logfile _activate.log]

退出码: 0=成功  2=等待超时未找到农场窗口  3=窗口无效
"""
import ctypes
import os
import sys
import time
from ctypes import wintypes

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_DPI_AWARE
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

u = ctypes.windll.user32
k = ctypes.windll.kernel32
p = ctypes.windll.psapi

SWP_NOSIZE = 0x0001
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SW_RESTORE = 9
SW_SHOWNA = 8
HIDDEN_COORD = -32000

# 农场窗口正常尺寸下限（物理像素）。Chromium 被遮挡时会缩到 ~200x405，
# 低于此阈值视为"渲染被挂起"，需要补一次激活。
MIN_EXPECTED_W = 380
MIN_EXPECTED_H = 700

OFFSCREEN_X = -800

# 结束停靠模式：corner=只露左边缘一角(默认) / off=完全屏幕外 / orig=移回原位
DOCK_EDGE_PX = 24  # corner 模式露出的宽度（物理像素）


class RECT(ctypes.Structure):
    _fields_ = [('l', wintypes.LONG), ('t', wintypes.LONG),
                ('r', wintypes.LONG), ('b', wintypes.LONG)]


# --------------------------------------------------------------------------
# 参数
# --------------------------------------------------------------------------
def parse_args(argv):
    a = {'wait': 90, 'load': 8, 'verify': 20, 'dock': 'corner', 'logfile': None}
    i = 1
    while i < len(argv):
        key = argv[i]
        nxt = argv[i + 1] if i + 1 < len(argv) else None
        if key == '--wait' and nxt:
            a['wait'] = int(nxt); i += 2
        elif key == '--load' and nxt:
            a['load'] = int(nxt); i += 2
        elif key == '--verify' and nxt:
            a['verify'] = int(nxt); i += 2
        elif key == '--dock' and nxt in ('corner', 'off', 'orig'):
            a['dock'] = nxt; i += 2
        elif key == '--logfile' and nxt:
            a['logfile'] = nxt; i += 2
        else:
            i += 1
    return a


ARGS = parse_args(sys.argv)
HERE = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(HERE, ARGS['logfile'] or '_activate-farm.log')


def log(msg):
    line = f'[{time.strftime("%H:%M:%S")}] {msg}'
    print(line, flush=True)
    try:
        with open(LOG_PATH, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


# --------------------------------------------------------------------------
# Win32 helpers
# --------------------------------------------------------------------------
def get_title(hwnd):
    n = u.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ''
    buf = ctypes.create_unicode_buffer(n + 1)
    u.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def get_proc(pid):
    h = k.OpenProcess(0x410, False, pid)
    if not h:
        return ''
    try:
        buf = ctypes.create_unicode_buffer(512)
        p.GetModuleBaseNameW(h, None, buf, 512)
        raw = buf.value
        return raw[:-4] if raw.lower().endswith('.exe') else raw
    finally:
        k.CloseHandle(h)


def find_farm_window():
    """枚举所有 QQ 窗口，找标题含「农场」的可见/可恢复窗口。

    注意：选号框 title 是 [QQ]，不含「农场」，不会被误匹配。
    """
    Proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    found = {}

    @Proc
    def cb(hwnd, _):
        pid = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if get_proc(pid.value) not in ('QQ', 'QQNT'):
            return True
        title = get_title(hwnd)
        if '农场' not in title:
            return True
        found['hwnd'] = hwnd
        found['title'] = title
        found['pid'] = pid.value
        return False

    u.EnumWindows(cb, 0)
    return found.get('hwnd'), found.get('title', '')


def rect_of(hwnd):
    rc = RECT()
    u.GetWindowRect(hwnd, ctypes.byref(rc))
    return rc.l, rc.t, rc.r - rc.l, rc.b - rc.t


def ensure_visible(hwnd):
    """窗口坐标为 -32000 表示最小化/隐藏状态，先恢复可见性。"""
    x, y, w, h = rect_of(hwnd)
    if x != HIDDEN_COORD and y != HIDDEN_COORD:
        return x, y, w, h
    log(f'  窗口处于隐藏状态 ({x},{y})，先 ShowWindow(SW_RESTORE)')
    u.ShowWindow(hwnd, SW_RESTORE)
    time.sleep(0.4)
    x, y, w, h = rect_of(hwnd)
    if x == HIDDEN_COORD or y == HIDDEN_COORD:
        log('  SW_RESTORE 无效，改用 SW_SHOWNA')
        u.ShowWindow(hwnd, SW_SHOWNA)
        time.sleep(0.4)
        x, y, w, h = rect_of(hwnd)
    log(f'  恢复后 rect=({x},{y} {w}x{h})')
    return x, y, w, h


def force_foreground(hwnd):
    """绕过 Windows 前台锁定（后台进程直接 SetForegroundWindow 会被拒绝 → 白屏根因）。

    三连招，任一成功即返回 True：
      1. ALT 键技巧：模拟一次 ALT 按下/释放，会给当前线程解锁 SetForegroundWindow 权限；
      2. AttachThreadInput：把当前线程附加到前台线程/目标线程的输入队列后抢前台；
      3. SwitchToThisWindow： undocumented 但对后台进程最宽容。
    """
    # 1) ALT 技巧
    VK_MENU = 0x12
    KEYEVENTF_KEYUP = 0x0002
    u.keybd_event(VK_MENU, 0, 0, 0)
    u.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
    u.BringWindowToTop(hwnd)
    u.SetForegroundWindow(hwnd)
    if u.GetForegroundWindow() == hwnd:
        return True

    # 2) AttachThreadInput
    try:
        cur_tid = k.GetCurrentThreadId()
        pid_buf = wintypes.DWORD(0)
        target_tid = u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid_buf))
        fg = u.GetForegroundWindow()
        fg_tid = 0
        if fg:
            fg_buf = wintypes.DWORD(0)
            fg_tid = u.GetWindowThreadProcessId(fg, ctypes.byref(fg_buf))
        attached = []
        for tid in (fg_tid, target_tid):
            if tid and tid != cur_tid and u.AttachThreadInput(cur_tid, tid, 1):
                attached.append(tid)
        try:
            u.BringWindowToTop(hwnd)
            u.SetForegroundWindow(hwnd)
        finally:
            for tid in attached:
                u.AttachThreadInput(cur_tid, tid, 0)
        if u.GetForegroundWindow() == hwnd:
            return True
    except Exception:
        pass

    # 3) SwitchToThisWindow 兜底
    try:
        u.SwitchToThisWindow(hwnd, True)
        time.sleep(0.15)
        if u.GetForegroundWindow() == hwnd:
            return True
    except Exception:
        pass
    return False


def activate(hwnd, retries=8):
    """把窗口移到屏幕外并强制激活（失败重试，不成功不罢休）。"""
    _, y, _, _ = rect_of(hwnd)
    u.SetWindowPos(hwnd, 0, OFFSCREEN_X, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
    time.sleep(0.12)
    for attempt in range(1, retries + 1):
        if force_foreground(hwnd):
            if attempt > 1:
                log(f'  激活成功（第 {attempt} 次尝试）')
            return True
        time.sleep(0.5)
    return u.GetForegroundWindow() == hwnd


def is_degraded(hwnd):
    """Chromium 被遮挡/挂起时会把窗口缩到远小于正常尺寸。"""
    _, _, w, h = rect_of(hwnd)
    return w < MIN_EXPECTED_W or h < MIN_EXPECTED_H


CONSOLE_PROCS = ('cmd', 'conhost', 'windowsterminal', 'powershell', 'pwcs', 'pwsh')


def give_focus_back(hwnd):
    """把前台还给用户原来在用的窗口（SwitchToThisWindow 比 SetForegroundWindow 可靠）。

    例外：bat 双击运行时 prev_fg 往往是 cmd 控制台——把它切到最前会打断用户
    当前工作（用户实测抱怨过），console 类进程一律跳过，让系统自然落焦。
    """
    try:
        pid = wintypes.DWORD(0)
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        proc = get_proc(pid.value).lower()
        if proc in CONSOLE_PROCS:
            log(f'  prev_fg 是控制台 ({proc})，不还前台')
            return
    except Exception:
        pass
    try:
        u.SwitchToThisWindow(hwnd, True)
    except Exception:
        u.SetForegroundWindow(hwnd)


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def main():
    log('=' * 56)
    log(f'activate-farm 启动 (wait={ARGS["wait"]}s load={ARGS["load"]}s verify={ARGS["verify"]}s dock={ARGS["dock"]})')

    # 1) 轮询等待农场窗口出现
    deadline = time.time() + ARGS['wait']
    hwnd, title = None, ''
    waited = 0
    while time.time() < deadline:
        hwnd, title = find_farm_window()
        if hwnd and u.IsWindow(hwnd):
            break
        hwnd = None
        time.sleep(0.5)
        waited += 1
        if waited % 20 == 0:
            log(f'  等待农场窗口出现... {waited // 2}s')

    if not hwnd:
        log(f'FARM_WINDOW_NOT_FOUND (等待 {ARGS["wait"]}s 超时)')
        sys.exit(2)

    log(f'FARM_FOUND hwnd={hwnd} title=[{title}]')

    prev_fg = u.GetForegroundWindow()
    log(f'prev_fg={prev_fg}')

    ox, oy, ow, oh = ensure_visible(hwnd)
    log(f'原位 rect=({ox},{oy} {ow}x{oh})')

    # 2) 屏幕外激活，等加载
    activated_ok = activate(hwnd)
    log(f'屏幕外激活: fg_ok={activated_ok}' + ('' if activated_ok else ' ← 前台锁定未解除，验证期继续重试'))
    time.sleep(ARGS['load'])
    log(f'加载等待 {ARGS["load"]}s 完成，当前 rect={rect_of(hwnd)}')

    # 3) 监测期：激活失败或窗口被缩小时补激活，不持续抢焦点
    re_activations = 0
    for t in range(1, ARGS['verify'] + 1):
        time.sleep(1)
        if not activated_ok:
            if force_foreground(hwnd):
                activated_ok = True
                re_activations += 1
                log(f'  t={t}s 补激活成功 #{re_activations}，重新等待加载...')
                time.sleep(ARGS['load'])
            continue
        if is_degraded(hwnd):
            x, y, w, h = rect_of(hwnd)
            log(f'  t={t}s 检测到窗口被降级 ({w}x{h})，补一次激活 #{re_activations + 1}')
            activate(hwnd)
            re_activations += 1
            time.sleep(2)
            if is_degraded(hwnd):
                log(f'  补激活后仍为 {rect_of(hwnd)[2]}x{rect_of(hwnd)[3]}，强制恢复尺寸')
                u.SetWindowPos(hwnd, 0, OFFSCREEN_X, oy, ow, oh, SWP_NOZORDER)
                force_foreground(hwnd)
                time.sleep(1.5)
        elif t % 5 == 0:
            x, y, w, h = rect_of(hwnd)
            log(f'  t={t}s 正常 {w}x{h}')

    if not activated_ok:
        log('严重: 验证期内始终无法激活窗口，农场大概率仍是白屏！')
        log('建议: 把农场窗口手动点出来一下（点击即激活），登录请求会立刻发出')

    # 4) 结束停靠：默认只露左边缘一角，不占屏幕工作区；前台还给用户
    if ARGS['dock'] == 'orig':
        dock_x, dock_y = ox, oy
    elif ARGS['dock'] == 'off':
        dock_x, dock_y = OFFSCREEN_X, oy
    else:  # corner：左边缘露 24px，需要时可用鼠标把这个角拖出来
        dock_x, dock_y = -(ow - DOCK_EDGE_PX), oy
    u.SetWindowPos(hwnd, 0, dock_x, dock_y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
    time.sleep(0.15)
    if prev_fg and prev_fg != hwnd:
        give_focus_back(prev_fg)
        time.sleep(0.15)

    x, y, w, h = rect_of(hwnd)
    match = u.GetForegroundWindow() == prev_fg
    log(f'停靠 dock={ARGS["dock"]} → ({x},{y} {w}x{h})，前台已还回 match_prev={match}')
    log(f'完成 (补激活 {re_activations} 次)')
    sys.exit(0)


if __name__ == '__main__':
    main()
