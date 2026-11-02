"""以完全脱离父进程的方式启动补码守护（2026-11-01）。

为什么不直接用 subprocess.Popen：
- 普通 Popen 启动的子进程仍挂在当前会话/作业对象下，工具调用结束时可能被一起清理，
  实测 pythonw 启动 10 秒后进程消失、日志停在 21:57:51。
- Windows 上要真正"脱离"，必须给 DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP，
  并让 stdout/stderr 不继承（pythonw 本身无控制台，这一步尤其重要）。

用法：python start_guard_detached.py
"""
import os
import subprocess
import sys
import time

DIR = os.path.dirname(os.path.abspath(__file__))
PYW = r"C:\Users\HP\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe"
SCRIPT = os.path.join(DIR, 'napcat-code-guard.py')
PID_FILE = os.path.join(DIR, 'napcat_guard.pid')
LOG = os.path.join(DIR, 'napcat_guard.log')


def proc_alive(pid):
    if not pid:
        return False
    try:
        out = subprocess.run(['tasklist', '/FI', 'PID eq %d' % pid, '/NH'],
                             capture_output=True, text=True, errors='ignore', timeout=10)
        return str(pid) in (out.stdout or '')
    except Exception:
        return False


def main():
    if not os.path.isfile(PYW) or not os.path.isfile(SCRIPT):
        print('缺少文件: PYW=%s SCRIPT=%s' % (os.path.isfile(PYW), os.path.isfile(SCRIPT)))
        return 1

    # 先看是否已有活着的守护
    old_pid = 0
    if os.path.exists(PID_FILE):
        try:
            old_pid = int(open(PID_FILE).read().strip() or 0)
        except Exception:
            old_pid = 0
    if old_pid and proc_alive(old_pid):
        print('已有守护在运行 pid=%d，无需重复启动' % old_pid)
        return 0
    if old_pid:
        print('清理陈旧 PID 文件（%d 已不存在）' % old_pid)
        try:
            os.remove(PID_FILE)
        except Exception:
            pass

    # Windows 分离标志
    DETACHED_PROCESS = 0x00000008
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    CREATE_NO_WINDOW = 0x08000000
    flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW

    p = subprocess.Popen(
        [PYW, SCRIPT],
        cwd=DIR,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=flags,
        close_fds=True,
    )
    print('已启动守护 pid=%d（分离模式）' % p.pid)

    # 等它写完 PID 文件并产生日志
    for _ in range(15):
        time.sleep(1)
        if os.path.exists(PID_FILE):
            break
    time.sleep(3)

    new_pid = 0
    if os.path.exists(PID_FILE):
        try:
            new_pid = int(open(PID_FILE).read().strip() or 0)
        except Exception:
            new_pid = 0
    print('PID 文件: %s' % (new_pid or '(无)'))
    print('存活检查: %s' % ('OK' if proc_alive(new_pid or p.pid) else 'FAILED'))

    if os.path.exists(LOG):
        with open(LOG, 'r', encoding='utf-8', errors='replace') as f:
            lines = f.readlines()[-5:]
        print('--- 日志尾部 ---')
        sys.stdout.writelines(lines)
    return 0


if __name__ == '__main__':
    sys.exit(main())