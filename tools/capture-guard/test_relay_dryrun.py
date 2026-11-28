# -*- coding: utf-8 -*-
"""napcat-code-guard relay 客户端 DryRun：假 NapCat + 假服务器，验证任务状态机。

只验证守护侧（本机）逻辑，不碰真 NapCat、不碰真服务器、不动任何 QQ 会话。
用法: python test_relay_dryrun.py
"""
import importlib.util
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
GUARD = os.path.join(HERE, 'napcat-code-guard.py')

# ---------- 假中转服务器 ----------
REPORTS = []
TASKS = []


class FakeServer(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n).decode('utf-8') if n else '{}'
        body = json.loads(raw or '{}')
        if self.headers.get('x-relay-token') != 'test-relay-token':
            self.send_response(401)
            self.end_headers()
            return
        if self.path.endswith('/heartbeat'):
            self._json({'ok': True, 'data': {'tasks': list(TASKS), 'serverTime': int(time.time() * 1000)}})
            return
        if self.path.endswith('/report'):
            REPORTS.append(body)
            for t in TASKS:
                if t['id'] == body.get('id'):
                    for k, v in body.items():
                        if k in ('status', 'qrImage', 'uin', 'nickname', 'code', 'error'):
                            t[k] = v
            self._json({'ok': True, 'data': body})
            return
        self._json({'ok': False, 'error': 'not found'})


def load_guard():
    spec = importlib.util.spec_from_file_location('guardmod', GUARD)
    mod = importlib.util.module_from_spec(spec)
    sys.modules['guardmod'] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    srv = ThreadingHTTPServer(('127.0.0.1', 0), FakeServer)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    g = load_guard()
    g.RELAY_URL = 'http://127.0.0.1:{}'.format(port)
    g.RELAY_TOKEN = 'test-relay-token'
    g.RELAY_SCAN_TIMEOUT = 12.0
    g.RELAY_QR_REFRESH = 3.0
    g.RELAY_TASK_STEP = 0.3
    g.APP_ID = '1112386029'
    g.log = lambda m: print('   ' + str(m))

    # ---- 场景1：正常扫码 -> 取码 -> done ----
    TASKS.append({'id': 'task-ok', 'status': 'pending'})
    state = {'n': 0}

    def login_state():
        state['n'] += 1
        return {'isLogin': state['n'] >= 3, 'isOffline': False, 'qrcodeurl': '', 'loginError': ''}

    g.napcat_enter_scan_mode = lambda: (True, '')
    g.napcat_take_qrcode = lambda: 'https://txz.qq.com/p?k=dryrun'
    g.napcat_refresh_qrcode = lambda: None
    g.napcat_login_state = login_state
    g.napcat_take_farm_code = lambda: ('CODE-DRYRUN-1', '10001', '测试号')
    g.napcat_online_uin = lambda: None
    g.napcat_alive = lambda: True
    g.switch_to_account = lambda uin: True

    print('[场景1] 正常扫码取码')
    g.relay_handle_task(dict(TASKS[0]))
    seq = [r.get('status') for r in REPORTS if r.get('id') == 'task-ok']
    done = [r for r in REPORTS if r.get('id') == 'task-ok' and r.get('status') == 'done']
    assert 'scanning' in seq, seq
    assert done and done[-1].get('code') == 'CODE-DRYRUN-1', done
    assert done[-1].get('uin') == '10001', done
    assert any(r.get('qrImage') for r in REPORTS), '未回填二维码'
    print('   reports =', seq, '-> code/uin 回填 OK')

    # ---- 场景2：扫码超时 -> error ----
    REPORTS.clear()
    TASKS.clear()
    TASKS.append({'id': 'task-timeout', 'status': 'pending'})
    g.RELAY_SCAN_TIMEOUT = 1.5
    g.napcat_login_state = lambda: {'isLogin': False, 'isOffline': False, 'qrcodeurl': '', 'loginError': ''}
    print('[场景2] 扫码超时')
    t0 = time.time()
    g.relay_handle_task(dict(TASKS[0]))
    errs = [r for r in REPORTS if r.get('status') == 'error']
    assert errs, REPORTS
    assert '超时' in errs[-1].get('error', ''), errs
    assert time.time() - t0 < 12, '超时保护未按时结束'
    print('   error =', errs[-1]['error'])

    # ---- 场景3：换码失败 -> error（不静默） ----
    REPORTS.clear()
    TASKS.clear()
    TASKS.append({'id': 'task-nocode', 'status': 'pending'})
    g.RELAY_SCAN_TIMEOUT = 6.0
    g.napcat_login_state = lambda: {'isLogin': True, 'isOffline': False, 'qrcodeurl': '', 'loginError': ''}
    g.napcat_take_farm_code = lambda: ('', '', '')
    print('[场景3] 已登录但换码失败')
    g.relay_handle_task(dict(TASKS[0]))
    errs = [r for r in REPORTS if r.get('status') == 'error']
    assert errs and 'Code' in errs[-1].get('error', ''), errs
    print('   error =', errs[-1]['error'])

    # ---- 场景4：进扫码模式失败（如 NapCat 未就绪）-> error ----
    REPORTS.clear()
    TASKS.clear()
    TASKS.append({'id': 'task-nonapcat', 'status': 'pending'})
    g.napcat_enter_scan_mode = lambda: (False, 'NapCat 登录状态查询失败')
    print('[场景4] NapCat 不可用')
    g.relay_handle_task(dict(TASKS[0]))
    errs = [r for r in REPORTS if r.get('status') == 'error']
    assert errs and 'NapCat' in errs[-1].get('error', ''), errs
    print('   error =', errs[-1]['error'])

    # ---- 场景5：心跳/列表解析 ----
    TASKS.clear()
    TASKS.append({'id': 'task-hb', 'status': 'scanning'})
    tasks = g.relay_heartbeat(True, '10001', False)
    assert isinstance(tasks, list) and tasks and tasks[0]['id'] == 'task-hb', tasks
    print('[场景5] 心跳返回任务列表 OK:', [t['id'] for t in tasks])

    # ---- 场景6：终端任务不再处理 ----
    assert g.relay_handle_task({'id': 'x', 'status': 'done'}) is True
    assert g.relay_handle_task({'id': 'x', 'status': 'cancelled'}) is True
    print('[场景6] 终端任务直接跳过 OK')

    srv.shutdown()
    print('\nALL DRYRUN PASSED')


if __name__ == '__main__':
    main()
