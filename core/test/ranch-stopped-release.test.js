const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const deploy = path.join(root, 'cloudbase/.ref/deploy.py');

// 仅编译发布配置和指定函数，禁止执行部署脚本的顶层 import 或 CLI。
const runtimeGatePrelude = String.raw`
import ast, pathlib, sys, hashlib, json, copy, io, tarfile, tempfile, contextlib, stat
source = pathlib.Path(sys.argv[1])
text = source.read_text(encoding='utf-8')
tree = ast.parse(text)
constants = {'RELEASE_SESSION_FILES', 'RELEASE_BACKEND_ALLOWLIST', 'RELEASE_STATIC_ALLOWLIST',
             'RELEASE_COMBINED_MIGRATION', 'RELEASE_INSPECT_SCRIPT', 'RELEASE_INSTALL_SCRIPT',
             'RELEASE_RANCH_RUNTIME_SAFETY_VERIFY', 'RELEASE_RESUME_SCRIPT', 'RANCH_INTERRUPTED_INSTALL_VERIFY'}
functions = {'ranch_runtime_profile', 'validate_ranch_runtime_manifest', 'package_ranch_runtime_release', 'package_static_frontend', 'load_release_manifest',
             'registered_release_artwork', 'deploy_release', 'inspect_release'}
nodes = [node for node in tree.body if
    (isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and
        (target.id in constants or target.id.startswith(('RELEASE_RANCH_RUNTIME_', 'RELEASE_RANCH_COMBINED_', 'RELEASE_RANCH_GRASS_', 'RELEASE_RANCH_VISIT_', 'RELEASE_RANCH_ACTIVITY_', 'RELEASE_RANCH_MUGE_', 'RELEASE_RANCH_UNIFIED_', 'RELEASE_RANCH_LOCK_', 'RELEASE_RANCH_UPSTREAM_TASK_')))
        for target in node.targets)) or
    (isinstance(node, ast.FunctionDef) and node.name in functions)]
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), 'exec'))
def seal(manifest):
    manifest.pop('planSha256', None)
    manifest['planSha256'] = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return manifest
def candidate(migration):
    profile = ranch_runtime_profile({'migration': migration})
    original = {name: '1' * 64 for name in profile['files']}
    original.update({name: review['before'] for name, review in profile['reviewed'].items()})
    original.update(profile['baseline'])
    for name in profile.get('newFiles', set()): original[name] = hashlib.sha256(b'').hexdigest()
    entries = [{'path': name, 'size': 1, 'sha256': profile['reviewed'].get(name, {}).get('after',
               original[name] if name in profile['preserved'] else '2' * 64)} for name in sorted(profile['files'])]
    entries.append({'path': 'web-dist/index.html', 'size': 1, 'sha256': '3' * 64})
    manifest = {'name': migration, 'migration': migration, 'frontendBuild': profile['build'],
        'gatewayRestartAllowed': False, 'noGameRpcAcceptance': True, 'files': entries,
        'backendFiles': sorted(profile['files']), 'changedFilesAllowed': sorted(profile['changed']),
        'requiredUnchangedFiles': sorted(profile['preserved']), 'newFilesAllowed': sorted(profile.get('newFiles', set())),
        'originalSourceHashes': original, 'reviewedTransportChanges': copy.deepcopy(profile['reviewed'])}
    if profile['baseline']: manifest['requiredBaselineHashes'] = dict(profile['baseline'])
    return seal(manifest)
def rejected(action):
    try: action()
    except RuntimeError: return
    raise AssertionError('门禁未拒绝非法输入')
`;

test('停号维护使用独立远端脚本并显式覆盖延迟启号、unknown账本和一次性计数', () => {
    const script = String.raw`
import ast, pathlib, sys
source = pathlib.Path(sys.argv[1])
text = source.read_text(encoding='utf-8')
tree = ast.parse(text)
assert 'RANCH_STOPPED_MAINTENANCE_SCRIPT' in text
assert 'unknown-ledger' in text
assert "docker','compose','stop','qq-farm-bot" in text
assert "docker','compose','start','qq-farm-bot" in text
assert 'deployment-resume票据' in text
assert 'time.sleep(4)' in text
assert 'pong' in text
assert 'ranch_stopped_release' in text
assert 'RELEASE_INSTALL_SCRIPT' in text
assert 'remote_json(cli, RANCH_STOPPED_MAINTENANCE_SCRIPT' in text
assert 'gatewayRestartAllowed' in text
assert "if RANCH_RELEASE_BLOCKERS:" in text
assert '可信闭包/审批基线' in text
`;
    execFileSync('python', ['-c', script, deploy], { encoding: 'utf8', timeout: 15000, windowsHide: true });
});

test('停号维护保留过期恢复票原字节，但拒绝未来有效票与无法解析的票', () => {
    const script = String.raw`
import ast,pathlib,sys,tempfile,textwrap,json,hashlib,time
source=pathlib.Path(sys.argv[1]);tree=ast.parse(source.read_text(encoding='utf-8'))
node=next(n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='RANCH_STOPPED_MAINTENANCE_SCRIPT' for t in n.targets))
remote=ast.literal_eval(node.value)
code=textwrap.dedent(remote[remote.index("    resume=data/'deployment-resume.json'"):remote.index('    accounts=panel_snapshot()')])
with tempfile.TemporaryDirectory() as directory:
 data=pathlib.Path(directory);file=data/'deployment-resume.json'
 def probe(raw=None):
  if raw is not None:file.write_bytes(raw)
  env={'data':data,'hashlib':hashlib,'json':json,'time':time}
  exec(code,env)
  if raw is not None:assert file.read_bytes()==raw
  return env
 assert probe()['resume_pending'] is False
 expired=b'{"accountIds":["1","2","10"],"expiresAt":1}'
 assert probe(expired)['resume_pending'] is False
 assert probe(json.dumps({'accountIds':['1'],'expiresAt':(time.time()+3600)*1000}).encode())['resume_pending'] is True
 assert probe(b'{broken')['resume_pending'] is True
 assert probe(b'{"expiresAt":null}')['resume_pending'] is True
print('ok')
`;
    const result = execFileSync('python', ['-c', script, deploy], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(result.trim(), 'ok');
});

test('停号维护后置门禁允许网关替换，但拒绝账号复活和计数漂移', () => {
    const script = String.raw`
import ast, pathlib, sys, re
source = pathlib.Path(sys.argv[1]); tree = ast.parse(source.read_text(encoding='utf-8'))
env = {'re': re}
needed = {'_ranch_stopped_snapshot','check_ranch_stopped_preflight','check_ranch_stopped_maintenance_postflight'}
funcs = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in needed]
exec(compile(ast.Module(body=funcs, type_ignores=[]), str(source), 'exec'), env)

def snapshot(gateway_restart=0, main_id='a'*64, main_start=100, gateway_id='b'*64, gateway_pid=20, gateway_start=200, revived=False):
    return {
        'mode':'stopped-account',
        'accounts':[{'id':'1','running':False,'connected':False}, {'id':'2','running':False,'connected':False}, {'id':'10','running':revived,'connected':revived}],
        'pendingCount':0, 'workerCount':0, 'autoStartEnabled':False, 'resumePending':False, 'codeGuardRunning':False,
        'startupSettled':True, 'startupGuard':{'bootstrapAutoStartAccountsFalse':True,'delayedResumePathAudited':True,
            'environmentAutoStartEmpty':True,'resumeFileAbsent':True,'gatewayAccountsCoverAll':True,
            'codeRefreshDisabledByGatewayOwnership':True},
        'networkMode':'gateway', 'externalGateway':'1', 'gatewayAccounts':'', 'gameSockets':[],
        'activity':{'complete':True,'id':'c'*32,'seq':0 if main_start == 100 else 1,
                    'mainReloadRequests':0 if main_start == 100 else 1,
                    'mainReloads':0 if main_start == 100 else 1,
                    'gatewayRestarts':gateway_restart,'accountStarts':0,'codeGuardStarts':0,'gameTcpConnections':0},
        'containers':{
            'qq-farm-bot':{'id':main_id,'running':True,'health':'healthy','pid':10,'starttime':main_start},
            'farm-gateway':{'id':gateway_id,'running':True,'health':'healthy','pid':gateway_pid,'starttime':gateway_start},
        },
        'gatewayEvidence':{'ipcPing':True},
        'dataIntegrity':{'unknownLedgerUnchanged':True},
    }

before = snapshot()
after = snapshot(1, 'd'*64, 300, 'e'*64, 30, 400)
env['check_ranch_stopped_maintenance_postflight'](before, after, True)
failed = False
try:
    env['check_ranch_stopped_maintenance_postflight'](before, snapshot(1, 'd'*64, 300, 'e'*64, 30, 400, True), True)
except RuntimeError:
    failed = True
assert failed
failed = False
try:
    bad = snapshot(0, 'd'*64, 300, 'e'*64, 30, 400)
    bad['activity']['mainReloads'] = 2
    env['check_ranch_stopped_maintenance_postflight'](before, bad, False)
except RuntimeError:
    failed = True
assert failed
`;
    execFileSync('python', ['-c', script, deploy], { encoding: 'utf8', timeout: 15000, windowsHide: true });
});

test('合并版只允许四业务文件，旧 runtime 闭包和三项双向审核保持兼容', () => {
    const script = runtimeGatePrelude + String.raw`
expected = {'core/src/services/ranch-automation.js', 'core/src/services/ranch-manual.js',
            'core/src/models/store.js', 'core/src/utils/utils.js'}
assert RELEASE_RANCH_COMBINED_CHANGED == expected
assert RELEASE_RANCH_COMBINED_PRESERVED == RELEASE_RANCH_RUNTIME_FILES - expected
assert RELEASE_RANCH_COMBINED_BASELINE == {
    'core/src/runtime/gateway-client.js': '80a0464e30bea355f60ba8a171a806510f094825ce9e271ba34edd0e26b595d7',
    'core/src/services/ranch-friends.js': '4eea352322213026250b13aa5e03658df126a6e0877f43a535c382bd21916504',
    'core/src/utils/network.js': 'f97fbb54c3c771d76500b1a7e0b28022ad7bf578bef2ab81de577c74ce73b792',
}
assert RELEASE_RANCH_RUNTIME_CHANGED == {
    'core/src/core/worker.js', 'core/src/services/ranch-automation.js',
    'core/src/services/account-operation-coordinator.js', 'core/src/services/ranch-manual.js',
    'core/src/services/ranch-friends.js', 'core/src/runtime/gateway-client.js', 'core/src/utils/network.js'}
assert {name: review['before'] for name, review in RELEASE_RANCH_RUNTIME_REVIEWED.items()} == {
    'core/src/runtime/gateway-client.js': 'baea6cc973e73016fbcf49424a4fa6a0ed62c641baa39cca4ef007f27656ed27',
    'core/src/services/ranch-friends.js': 'd4c7c0c4ed8ad176cb9ba977b9d30df9e00f2977881e9f01159e3587a436d306',
    'core/src/utils/network.js': '8bd0ec2919978302a7971ada7dbce7ab3b3946e11283e8366877e9670dba9ee1',
}
for migration in RELEASE_RANCH_RUNTIME_PROFILES:
    manifest = candidate(migration)
    validate_ranch_runtime_manifest(manifest)
    for field, value in [('frontendBuild', 'frontend-readonly'), ('gatewayRestartAllowed', True),
                         ('noGameRpcAcceptance', False), ('changedFilesAllowed', []),
                         ('requiredUnchangedFiles', []), ('backendFiles', [])]:
        bad = copy.deepcopy(manifest); bad[field] = value
        rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
    for name in RELEASE_RANCH_RUNTIME_PROFILES[migration]['preserved']:
        bad = copy.deepcopy(manifest)
        next(item for item in bad['files'] if item['path'] == name)['sha256'] = '4' * 64
        rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
    bad = copy.deepcopy(manifest); bad['planSha256'] = '0' * 64
    rejected(lambda: validate_ranch_runtime_manifest(bad))
    bad = copy.deepcopy(manifest)
    bad['files'].append({'path': 'core/src/runtime/gateway-process.js', 'size': 1, 'sha256': '4' * 64})
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
manifest = candidate(RELEASE_RANCH_COMBINED_MIGRATION)
for name in RELEASE_RANCH_COMBINED_BASELINE:
    for digest in (RELEASE_RANCH_RUNTIME_REVIEWED[name]['before'], '4' * 64):
        bad = copy.deepcopy(manifest)
        bad['originalSourceHashes'][name] = digest
        next(item for item in bad['files'] if item['path'] == name)['sha256'] = digest
        rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
for field, value in [('requiredBaselineHashes', {}), ('name', RELEASE_RANCH_RUNTIME_MIGRATION),
                     ('reviewedTransportChanges', RELEASE_RANCH_RUNTIME_REVIEWED)]:
    bad = copy.deepcopy(manifest); bad[field] = value
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
`;
    execFileSync('python', ['-c', script, deploy], { encoding: 'utf8', timeout: 15000, windowsHide: true });
});

test('牧草核验版仅允许手动牧场变更，combined21完整闭包和运输审核后哈希必须保留', () => {
    const script = runtimeGatePrelude + String.raw`
assert RELEASE_RANCH_GRASS_MIGRATION == 'ranch-grass-verification-20261121'
profile = RELEASE_RANCH_RUNTIME_PROFILES[RELEASE_RANCH_GRASS_MIGRATION]
assert profile['build'] == 'frontend-ranch-grass-verification-20261121-prod'
assert profile['changed'] == {'core/src/services/ranch-manual.js'}
assert profile['files'] == RELEASE_RANCH_COMBINED_FILES
assert profile['preserved'] == RELEASE_RANCH_COMBINED_FILES - profile['changed']
assert profile['reviewed'] == {}
assert profile['baseline'] == RELEASE_RANCH_COMBINED_BASELINE
assert profile['baseline'] == {name: review['after'] for name, review in RELEASE_RANCH_RUNTIME_REVIEWED.items()}
assert set(RELEASE_RANCH_RUNTIME_PROFILES) == {
    RELEASE_RANCH_RUNTIME_MIGRATION, RELEASE_RANCH_COMBINED_MIGRATION, RELEASE_RANCH_GRASS_MIGRATION}
manifest = candidate(RELEASE_RANCH_GRASS_MIGRATION)
validate_ranch_runtime_manifest(manifest)
for name in profile['preserved']:
    bad = copy.deepcopy(manifest)
    bad['changedFilesAllowed'].append(name)
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
for name in profile['baseline']:
    for digest in (RELEASE_RANCH_RUNTIME_REVIEWED[name]['before'], '4' * 64):
        bad = copy.deepcopy(manifest)
        bad['originalSourceHashes'][name] = digest
        next(item for item in bad['files'] if item['path'] == name)['sha256'] = digest
        bad['requiredBaselineHashes'][name] = digest
        rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
for field, value in [('requiredBaselineHashes', {}), ('name', RELEASE_RANCH_COMBINED_MIGRATION),
                     ('reviewedTransportChanges', RELEASE_RANCH_RUNTIME_REVIEWED),
                     ('frontendBuild', RELEASE_RANCH_RUNTIME_PROFILES[RELEASE_RANCH_COMBINED_MIGRATION]['build'])]:
    bad = copy.deepcopy(manifest); bad[field] = value
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
`;
    execFileSync('python', ['-c', script, deploy], { encoding: 'utf8', timeout: 15000, windowsHide: true });
});

test('访友场景租约修复具有精确发布闭包并保留真实Gateway核验与旧预算', () => {
    const script = runtimeGatePrelude + String.raw`
assert RELEASE_RANCH_VISIT_MIGRATION == 'ranch-visit-scene-lease-20261122'
profile = RELEASE_RANCH_VISIT_PROFILES[RELEASE_RANCH_VISIT_MIGRATION]
assert profile['build'] == 'frontend-ranch-visit-scene-lease-20261122-prod'
assert profile['changed'] == {
    'core/src/core/worker.js', 'core/src/services/friend-api.js',
    'core/src/services/account-operation-coordinator.js',
    'core/src/services/account-operation-barrier.js', 'core/src/services/scene-session.js',
    'core/src/services/friend-visit-session.js'}
assert profile['files'] == RELEASE_RANCH_RUNTIME_FILES | profile['changed']
assert profile['preserved'] == profile['files'] - profile['changed']
assert profile['baseline'] == RELEASE_RANCH_COMBINED_BASELINE
manifest = candidate(RELEASE_RANCH_VISIT_MIGRATION)
validate_ranch_runtime_manifest(manifest)
assert ranch_runtime_profile(manifest) is profile
for name in profile['preserved']:
    bad = copy.deepcopy(manifest)
    bad['changedFilesAllowed'].append(name)
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
for name in profile['changed']:
    bad = copy.deepcopy(manifest)
    bad['changedFilesAllowed'].remove(name)
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
for field, value in [('gatewayRestartAllowed', True), ('frontendBuild', 'wrong-build'),
                     ('noGameRpcAcceptance', False), ('reviewedTransportChanges', {'unexpected': {}})]:
    bad = copy.deepcopy(manifest); bad[field] = value
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
`;
    execFileSync('python', ['-c', script, deploy], { encoding: 'utf8', timeout: 15000, windowsHide: true });
});

test('节令答题与牧场日志修复精确限制业务差异，保留访友租约和网关基线', () => {
    const script = runtimeGatePrelude + String.raw`
assert RELEASE_RANCH_ACTIVITY_MIGRATION == 'ranch-activity-answer-idle-log-20261122'
profile = RELEASE_RANCH_ACTIVITY_PROFILES[RELEASE_RANCH_ACTIVITY_MIGRATION]
assert profile['build'] == 'frontend-ranch-activity-answer-idle-log-20261122-prod'
assert profile['changed'] == {'core/src/core/worker.js', 'core/src/services/solar-calendar.js', 'core/src/services/ranch-automation.js'}
assert profile['files'] == RELEASE_RANCH_VISIT_FILES | profile['changed']
assert profile['preserved'] == profile['files'] - profile['changed']
assert profile['baseline'] == RELEASE_RANCH_COMBINED_BASELINE
manifest = candidate(RELEASE_RANCH_ACTIVITY_MIGRATION)
validate_ranch_runtime_manifest(manifest)
for name in profile['preserved']:
    bad = copy.deepcopy(manifest); bad['changedFilesAllowed'].append(name)
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
for field, value in [('gatewayRestartAllowed', True), ('frontendBuild', 'wrong-build'),
                     ('noGameRpcAcceptance', False), ('requiredBaselineHashes', {})]:
    bad = copy.deepcopy(manifest); bad[field] = value
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
`;
    execFileSync('python', ['-c', script, deploy], { encoding: 'utf8', timeout: 15000, windowsHide: true });
});

test('牧歌活动具名发布仅覆盖专用协议/路由/页面和审核过的前端构建', () => {
    const script = runtimeGatePrelude + String.raw`
assert RELEASE_RANCH_MUGE_MIGRATION == 'ranch-muge-adaptation-20261122'
profile = RELEASE_RANCH_MUGE_PROFILES[RELEASE_RANCH_MUGE_MIGRATION]
assert profile['build'] == 'frontend-ranch-muge-activity-v5-20261122-prod'
assert profile['newFiles'] == {'core/src/proto/muge.proto', 'core/src/activity-data/muge-20261117.json', 'core/src/services/ranch-muge.js'}
assert profile['changed'] == RELEASE_RANCH_ACTIVITY_CHANGED | {
    'core/src/runtime/data-provider.js', 'core/src/utils/proto.js',
    'core/src/proto/muge.proto', 'core/src/activity-data/muge-20261117.json',
    'core/src/services/ranch-muge.js', 'core/src/services/ranch-market.js',
    'core/src/controllers/admin-ranch-routes.js'}
assert profile['files'] == RELEASE_RANCH_ACTIVITY_FILES | {
    'core/src/runtime/data-provider.js', 'core/src/utils/proto.js',
    'core/src/proto/muge.proto', 'core/src/activity-data/muge-20261117.json',
    'core/src/services/ranch-muge.js', 'core/src/services/ranch-market.js',
    'core/src/controllers/admin-ranch-routes.js'}
assert profile['preserved'] == profile['files'] - profile['changed']
assert profile['baseline'] == RELEASE_RANCH_COMBINED_BASELINE
manifest = candidate(RELEASE_RANCH_MUGE_MIGRATION)
validate_ranch_runtime_manifest(manifest)
assert ranch_runtime_profile(manifest) is profile
for name in profile['preserved']:
    bad = copy.deepcopy(manifest); bad['changedFilesAllowed'].append(name)
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
for field, value in [('gatewayRestartAllowed', True), ('frontendBuild', 'wrong-build'),
                     ('noGameRpcAcceptance', False), ('requiredBaselineHashes', {})]:
    bad = copy.deepcopy(manifest); bad[field] = value
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
`;
    execFileSync('python', ['-c', script, deploy], { encoding: 'utf8', timeout: 15000, windowsHide: true });
});

test('牧场视觉/金券/问卷修复发布profile精确绑定全部业务文件与v2生产构建', () => {
    const script = runtimeGatePrelude + String.raw`
assert RELEASE_RANCH_UNIFIED_MIGRATION == 'ranch-ui-currency-quiz-unified-20261122'
profile = RELEASE_RANCH_UNIFIED_PROFILES[RELEASE_RANCH_UNIFIED_MIGRATION]
assert profile['build'] == 'frontend-ranch-upstream-automation-v9-20261123-prod'
assert profile['newFiles'] == set()
assert profile['changed'] == RELEASE_RANCH_MUGE_PROFILE_CHANGED | {'core/src/models/store.js', 'core/src/services/ranch-manual.js'}
assert profile['files'] == RELEASE_RANCH_MUGE_FILES | {'core/src/models/store.js', 'core/src/services/ranch-manual.js'}
assert profile['preserved'] == profile['files'] - profile['changed']
assert profile['baseline'] == RELEASE_RANCH_COMBINED_BASELINE
manifest = candidate(RELEASE_RANCH_UNIFIED_MIGRATION)
validate_ranch_runtime_manifest(manifest)
assert ranch_runtime_profile(manifest) is profile
for name in profile['preserved']:
    bad = copy.deepcopy(manifest); bad['changedFilesAllowed'].append(name)
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
for field, value in [('gatewayRestartAllowed', True), ('frontendBuild', 'wrong-build'),
                     ('noGameRpcAcceptance', False), ('requiredBaselineHashes', {})]:
    bad = copy.deepcopy(manifest); bad[field] = value
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
`;
    execFileSync('python', ['-c', script, deploy], { encoding: 'utf8', timeout: 15000, windowsHide: true });
});

test('目标级待核对锁发布只含三个审核后端文件并绑定前端构建与基线', () => {
    const script = runtimeGatePrelude + String.raw`
assert RELEASE_RANCH_LOCK_MIGRATION == 'ranch-target-locks-and-share-auto-20261124'
profile = RELEASE_RANCH_LOCK_PROFILES[RELEASE_RANCH_LOCK_MIGRATION]
assert profile['build'] == 'frontend-ranch-locks-release-20261124-prod'
assert profile['changed'] == {'core/src/services/ranch-manual.js', 'core/src/services/ranch-operations-ledger.js', 'core/src/services/ranch-automation.js', 'core/src/services/ranch-progression.js'}
assert profile['files'] == RELEASE_RANCH_UNIFIED_TASK_RESULT_FILES
assert profile['preserved'] == profile['files'] - profile['changed']
assert profile['newFiles'] == set()
assert profile['baseline'] == RELEASE_RANCH_COMBINED_BASELINE
assert set(profile['reviewed']) == profile['changed']
manifest = candidate(RELEASE_RANCH_LOCK_MIGRATION)
validate_ranch_runtime_manifest(manifest)
assert ranch_runtime_profile(manifest) is profile
for name in profile['preserved']:
    bad = copy.deepcopy(manifest); bad['changedFilesAllowed'].append(name)
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
for field, value in [('gatewayRestartAllowed', True), ('frontendBuild', 'wrong-build'),
                     ('noGameRpcAcceptance', False), ('requiredBaselineHashes', {})]:
    bad = copy.deepcopy(manifest); bad[field] = value
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
`;
    execFileSync('python', ['-c', script, deploy], { encoding: 'utf8', timeout: 15000, windowsHide: true });
});

test('上游任务回包修正精确发布仅变更领奖核验、批量领取与任务目标互锁文件', () => {
    const script = runtimeGatePrelude + String.raw`
assert RELEASE_RANCH_UPSTREAM_TASK_MIGRATION == 'ranch-upstream-task-receipts-20261124'
profile = RELEASE_RANCH_UPSTREAM_TASK_PROFILES[RELEASE_RANCH_UPSTREAM_TASK_MIGRATION]
assert profile['build'] == 'frontend-ranch-upstream-claims-20261124-prod'
assert profile['changed'] == {'core/src/services/ranch-manual.js', 'core/src/services/ranch-progression.js',
                              'core/src/services/ranch-automation.js'}
assert profile['reviewed']['core/src/services/ranch-automation.js']['before'] == '8687eb5556e6cdf78fcad188239e18126d353de88cbaaaac794f54bd2a537c5e'
assert profile['reviewed']['core/src/services/ranch-automation.js']['after'] == 'b9c6910ca27788e125071883153e431349e9b4ea89517f4bbaa165fb56d73d46'
assert profile['files'] == RELEASE_RANCH_LOCK_FILES
assert profile['preserved'] == profile['files'] - profile['changed']
assert profile['newFiles'] == set()
assert profile['baseline'] == RELEASE_RANCH_COMBINED_BASELINE
assert set(profile['reviewed']) == profile['changed']
manifest = candidate(RELEASE_RANCH_UPSTREAM_TASK_MIGRATION)
validate_ranch_runtime_manifest(manifest)
assert ranch_runtime_profile(manifest) is profile
for name in profile['preserved']:
    bad = copy.deepcopy(manifest); bad['changedFilesAllowed'].append(name)
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
for field, value in [('gatewayRestartAllowed', True), ('frontendBuild', 'wrong-build'),
                     ('noGameRpcAcceptance', False), ('requiredBaselineHashes', {})]:
    bad = copy.deepcopy(manifest); bad[field] = value
    rejected(lambda: validate_ranch_runtime_manifest(seal(bad)))
`;
    execFileSync('python', ['-c', script, deploy], { encoding: 'utf8', timeout: 15000, windowsHide: true });
});

test('中断发布验收允许原路径缺失的新协议源码，并拒绝任何已存在的新增源文件', () => {
    const script = runtimeGatePrelude + String.raw`
import textwrap, tarfile, pathlib, tempfile, hashlib, io, json, sys, contextlib
remote = textwrap.dedent(RANCH_INTERRUPTED_INSTALL_VERIFY)
with tempfile.TemporaryDirectory() as directory:
    base = pathlib.Path(directory); root = base / 'repo'; root.mkdir(); web = base / 'web'; web.mkdir()
    stage = root / '.workbuddy/releases/stage'; (stage / 'backup').mkdir(parents=True)
    relative = 'core/src/proto/muge.proto'; content = b'new protocol'
    payload = stage / 'payload' / relative; payload.parent.mkdir(parents=True); payload.write_bytes(content)
    archive = stage / 'delta.tar.gz'
    with tarfile.open(archive, 'w:gz') as output:
        info = tarfile.TarInfo(relative); info.size = len(content); output.addfile(info, io.BytesIO(content))
    entry = {'path': relative, 'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
    manifest = {'files': [entry], 'originalSourceHashes': {relative: hashlib.sha256(b'').hexdigest()}, 'newFilesAllowed': [relative]}
    payload_json = {'stage': str(stage), 'deltaSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                    'manifest': manifest, 'changed': [relative]}
    remote = remote.replace("pathlib.Path('/home/azureuser/qq-farm-bot-main')", f'pathlib.Path({str(root)!r})')
    remote = remote.replace("pathlib.Path('/home/azureuser/web-dist')", f'pathlib.Path({str(web)!r})')
    stdin = sys.stdin
    try:
        sys.stdin = io.StringIO(json.dumps(payload_json))
        with contextlib.redirect_stdout(io.StringIO()) as output: exec(remote, {})
        assert json.loads(output.getvalue())['ok'] is True
    finally: sys.stdin = stdin
`;
    execFileSync('python', ['-c', script, deploy], { encoding: 'utf8', timeout: 15000, windowsHide: true });
});

test('新旧具名构建离线模拟打包与清单加载，CLI 明确选择版本且拒绝交叉构建', () => {
    const script = runtimeGatePrelude + String.raw`
main = next(node for node in tree.body if isinstance(node, ast.If) and
            ast.unparse(node.test) == "__name__ == '__main__'")
for flag, migration in [('--package-ranch-runtime', RELEASE_RANCH_RUNTIME_MIGRATION),
                        ('--package-ranch-combined', RELEASE_RANCH_COMBINED_MIGRATION),
                        ('--package-ranch-grass', RELEASE_RANCH_GRASS_MIGRATION),
                        ('--package-ranch-visit', RELEASE_RANCH_VISIT_MIGRATION),
                        ('--package-ranch-activity', RELEASE_RANCH_ACTIVITY_MIGRATION),
                        ('--package-ranch-muge', RELEASE_RANCH_MUGE_MIGRATION),
                        ('--package-ranch-unified', RELEASE_RANCH_UNIFIED_MIGRATION),
                        ('--package-ranch-task-result', RELEASE_RANCH_UNIFIED_TASK_RESULT_MIGRATION),
                        ('--package-ranch-target-locks', RELEASE_RANCH_LOCK_MIGRATION),
                        ('--package-ranch-upstream-tasks', RELEASE_RANCH_UPSTREAM_TASK_MIGRATION)]:
    branch = next(node for node in main.body if isinstance(node, ast.If) and flag in ast.unparse(node.test))
    calls = []
    def capture(*args): calls.append(args)
    cli_env = {'sys': type('Args', (), {'argv': ['deploy.py', flag, 'build', 'output']})(),
               'package_ranch_runtime_release': capture,
               'RELEASE_RANCH_COMBINED_MIGRATION': RELEASE_RANCH_COMBINED_MIGRATION,
               'RELEASE_RANCH_GRASS_MIGRATION': RELEASE_RANCH_GRASS_MIGRATION,
               'RELEASE_RANCH_VISIT_MIGRATION': RELEASE_RANCH_VISIT_MIGRATION,
               'RELEASE_RANCH_ACTIVITY_MIGRATION': RELEASE_RANCH_ACTIVITY_MIGRATION,
               'RELEASE_RANCH_MUGE_MIGRATION': RELEASE_RANCH_MUGE_MIGRATION,
               'RELEASE_RANCH_UNIFIED_MIGRATION': RELEASE_RANCH_UNIFIED_MIGRATION,
               'RELEASE_RANCH_UNIFIED_TASK_RESULT_MIGRATION': RELEASE_RANCH_UNIFIED_TASK_RESULT_MIGRATION,
               'RELEASE_RANCH_LOCK_MIGRATION': RELEASE_RANCH_LOCK_MIGRATION,
               'RELEASE_RANCH_UPSTREAM_TASK_MIGRATION': RELEASE_RANCH_UPSTREAM_TASK_MIGRATION}
    try: exec(compile(ast.Module(body=[branch], type_ignores=[]), str(source), 'exec'), cli_env)
    except SystemExit as exit: assert exit.code == 0
    expected_args = ('build', 'output') if migration == RELEASE_RANCH_RUNTIME_MIGRATION else ('build', 'output', migration)
    assert calls == [expected_args]
with tempfile.TemporaryDirectory() as directory:
    BASE = directory
    root = pathlib.Path(directory); work = root / '.workbuddy'; work.mkdir()
    REMOTE = '/offline-fixture'
    connection_count = 0
    previous = {}
    new_files = set()
    new_contents = {}
    class Sftp:
        def lstat(self, name):
            if name[len(REMOTE) + 1:] in new_files: raise FileNotFoundError(2, 'missing')
            return type('Mode', (), {'st_mode': stat.S_IFREG})()
        def open(self, name, mode): return io.BytesIO(previous[name[len(REMOTE) + 1:]])
        def close(self): pass
    class Client:
        def open_sftp(self): return Sftp()
        def close(self): pass
    def ssh_connect():
        global connection_count
        connection_count += 1
        return Client()
    for migration, profile in {**RELEASE_RANCH_RUNTIME_PROFILES, **RELEASE_RANCH_VISIT_PROFILES, **RELEASE_RANCH_ACTIVITY_PROFILES, **RELEASE_RANCH_MUGE_PROFILES, **RELEASE_RANCH_UNIFIED_PROFILES}.items():
        # 模拟远端字节，实际三项常量另由上一个测试逐字固定。
        new_files = set(profile.get('newFiles', set()))
        previous = {name: ('original:' + name).encode() for name in profile['files'] if name not in new_files}
        new_contents = {name: ('new:' + name).encode() for name in new_files}
        for name in profile['files']:
            file = root / name; file.parent.mkdir(parents=True, exist_ok=True)
            if name in new_files: file.write_bytes(new_contents[name])
            else: file.write_bytes(previous[name] if name in profile['preserved'] else b'patched:' + previous[name])
        profile['reviewed'] = {name: {'before': hashlib.sha256(previous[name]).hexdigest(),
            'after': hashlib.sha256((root / name).read_bytes()).hexdigest()} for name in profile['reviewed']}
        profile['baseline'] = {name: hashlib.sha256(previous[name]).hexdigest() for name in profile['baseline']}
        build = work / profile['build']; build.mkdir(exist_ok=True); (build / 'index.html').write_bytes(b'production')
        (build / 'assets').mkdir(exist_ok=True); (build / 'assets/app.js').write_bytes(b'production-js')
        output = work / (migration + '.tar.gz')
        with contextlib.redirect_stdout(io.StringIO()):
            package_ranch_runtime_release(build, output, migration)
        manifest = load_release_manifest(output)
        assert manifest['migration'] == migration
        assert set(manifest['changedFilesAllowed']) == profile['changed']
        assert set(manifest['requiredUnchangedFiles']) == profile['preserved']
        assert manifest['reviewedTransportChanges'] == profile['reviewed']
        if profile['baseline']: assert manifest['requiredBaselineHashes'] == profile['baseline']
        else: assert 'requiredBaselineHashes' not in manifest
        with tarfile.open(output, 'r:gz') as archive:
            for name in profile['preserved']: assert archive.extractfile(name).read() == previous[name]
            for name in profile['changed']:
                expected = new_contents[name] if name in new_files else b'patched:' + previous[name]
                assert archive.extractfile(name).read() == expected
        assert output.with_name(output.name + '.source-review.json').is_file()
        calls_before = connection_count
        rejected(lambda: package_ranch_runtime_release(build, output, migration))
        for other, other_profile in {**RELEASE_RANCH_RUNTIME_PROFILES, **RELEASE_RANCH_VISIT_PROFILES, **RELEASE_RANCH_ACTIVITY_PROFILES, **RELEASE_RANCH_MUGE_PROFILES, **RELEASE_RANCH_UNIFIED_PROFILES}.items():
            # 后端单文件补丁可显式复用v9前端；不同具名构建仍须在SSH前拒绝。
            if other != migration and other_profile['build'] != profile['build']:
                rejected(lambda: package_ranch_runtime_release(build, work / 'wrong.tar.gz', other))
        assert connection_count == calls_before
        # 保留项漂移必须中断打包，不能生成候选包。
        name = next(iter(profile['preserved'])); (root / name).write_bytes(b'drift')
        failed_output = work / ('drift-' + migration + '.tar.gz')
        rejected(lambda: package_ranch_runtime_release(build, failed_output, migration))
        assert not failed_output.exists()
`;
    execFileSync('python', ['-c', script, deploy], { encoding: 'utf8', timeout: 15000, windowsHide: true });
});

test('独立静态前端包仅含具名构建产物，可走无容器重启路径', () => {
    const script = runtimeGatePrelude + String.raw`
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory); work = root / '.workbuddy'; work.mkdir()
    build = work / 'frontend-ranch-overview-level-20261123-prod'; build.mkdir()
    (build / 'index.html').write_bytes(b'new-level-card')
    (build / 'assets').mkdir(); (build / 'assets/ranch.js').write_bytes(b'new-ranch-view')
    output = work / 'ranch-overview-static.tar.gz'
    BASE = str(root)
    package_static_frontend(build, output, 'frontend-static-ranch-overview-level-20261123', build.name)
    manifest = load_release_manifest(output)
    assert manifest['migration'] == 'frontend-static-ranch-overview-level-20261123'
    assert set(row['path'] for row in manifest['files']) == {'web-dist/index.html', 'web-dist/assets/ranch.js'}
    assert all(row['path'].startswith('web-dist/') for row in manifest['files'])
    with tarfile.open(output, 'r:gz') as archive:
        assert archive.extractfile('web-dist/index.html').read() == b'new-level-card'
        assert archive.extractfile('web-dist/assets/ranch.js').read() == b'new-ranch-view'
`;
    execFileSync('python', ['-c', script, deploy], { encoding: 'utf8', timeout: 15000, windowsHide: true });
});

test('任务回包补丁仅允许已审核的单文件差异，保留全部v9依赖与原前端构建', () => {
    const script = runtimeGatePrelude + String.raw`
manifest = candidate(RELEASE_RANCH_UNIFIED_TASK_RESULT_MIGRATION)
profile = ranch_runtime_profile(manifest)
name = 'core/src/services/ranch-progression.js'
assert profile['changed'] == {name}
assert profile['preserved'] == RELEASE_RANCH_UNIFIED_FILES
assert profile['files'] == RELEASE_RANCH_UNIFIED_FILES | {name}
assert profile['newFiles'] == set()
assert profile['build'] == RELEASE_RANCH_UNIFIED_PROFILES[RELEASE_RANCH_UNIFIED_MIGRATION]['build']
review = profile['reviewed'][name]
assert len(review['before']) == 64 and len(review['after']) == 64
assert manifest['originalSourceHashes'][name] == review['before']
assert next(item for item in manifest['files'] if item['path'] == name)['sha256'] == review['after']
validate_ranch_runtime_manifest(manifest)
for mutation in ['before', 'after', 'scope']:
    altered = copy.deepcopy(manifest)
    if mutation == 'before': altered['originalSourceHashes'][name] = '9' * 64
    elif mutation == 'after': next(item for item in altered['files'] if item['path'] == name)['sha256'] = '8' * 64
    else: altered['changedFilesAllowed'].append('core/src/services/ranch-operations-ledger.js')
    rejected(lambda: validate_ranch_runtime_manifest(seal(altered)))
assert '--package-ranch-task-result' in text
`;
    execFileSync('python', ['-c', script, deploy], { encoding: 'utf8', timeout: 15000, windowsHide: true });
});

test('三笔任务人工核对先备份再结束，仅指定记录且失败即停，不重放或补记原RPC成功', () => {
    const script = String.raw`
import importlib.util, pathlib, json, contextlib, io, sys, subprocess, tempfile, hashlib, time, copy
helper = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('verify_deploy_review', helper)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for mode in ['valid', 'unclaimed', 'changed-record', 'costs', 'disk-mismatch', 'wrong-patch', 'post-failure']:
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        data = root / 'data'; ledger = data / 'ranch-operations'; ledger.mkdir(parents=True)
        releases = root / '.workbuddy/releases'; releases.mkdir(parents=True)
        code = root / 'core/src/services/ranch-progression.js'; code.parent.mkdir(parents=True); code.write_bytes(b'fixed-task-code')
        protected_file = data / 'friend-visit-recovery/1.attempt.json'
        protected_file.parent.mkdir(parents=True); protected_file.write_bytes(b'{"phase":"unknown"}')
        records, before, evidence, rows, files, acks = {}, {}, [], [], {}, []
        for aid, record_id in module.KNOWN_TASK_REVIEW_RECORDS.items():
            record = {'id': record_id, 'target': 'ranch:claimTasks:400001', 'label': 'ordinary task',
                      'createdAt': 1, 'message': 'scene2返回了农场任务', 'costs': []}
            if aid == '1' and mode == 'changed-record': record['id'] = 'different'
            if aid == '1' and mode == 'costs': record['costs'] = [{'resourceKey':'item:1007','amount':'1'}]
            records[aid] = [record]
            file = ledger / (hashlib.sha256(aid.encode()).hexdigest()[:24] + '.json'); files[aid] = file
            file.write_text(json.dumps(records[aid]), encoding='utf-8'); before[aid] = file.read_bytes()
            if aid == '1' and mode == 'disk-mismatch': file.write_text('[]', encoding='utf-8')
            evidence.append({'accountId': aid, 'recordId': record_id, 'ownerGid': 'gid-' + aid, 'dateKey': 'day'})
            rows.append({'accountId': aid, 'ok': True, 'ownerGid': 'gid-' + aid, 'dateKey': 'day',
                         'observedAt': int(time.time() * 1000), 'cache': {'hit': False},
                         'task400001': {'id':'400001','configConfirmed':True,'claimed':not (aid == '1' and mode == 'unclaimed')}})
        def api(route, body=None, account=None, token=None):
            if route == '/api/ranch/operations': return {'ok':True,'accountId':account,'data':{'pending':copy.deepcopy(records[account])}}
            assert route == '/api/ranch/operations/acknowledge'
            stages = list(releases.iterdir()); assert len(stages) == 1
            backup = stages[0] / 'original-ranch-operations'
            for aid, file in files.items(): assert (backup / file.name).read_bytes() == before[aid]
            state = json.loads((stages[0] / 'review-state.json').read_text())
            assert state['originalOutcome'] == 'unknown' and state['legacySuccessRecorded'] is False and state['gameClaimSent'] is False
            assert body == {'id':module.KNOWN_TASK_REVIEW_RECORDS[account]}
            acks.append(account)
            if mode == 'post-failure' and account == '2': return {'ok':False,'status':503}
            records[account] = [row for row in records[account] if row['id'] != body['id']]
            files[account].write_text(json.dumps(records[account]), encoding='utf-8')
            return {'ok':True,'accountId':account,'data':{'ok':True}}
        digest = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()
        payload = {'reviewedRecords':evidence,'expectedTaskServiceSha':'wrong' if mode == 'wrong-patch' else digest(code),'planSha256':'offline'}
        script_body = module.TASK_REVIEW_CLOSE_BODY.replace("pathlib.Path('/home/azureuser/data')", f'pathlib.Path({str(data)!r})')
        env = {'root':root,'pathlib':pathlib,'hashlib':hashlib,'json':json,'p':payload,'rows':rows,'api':api,'token':'offline','digest':digest}
        if mode == 'valid':
            with contextlib.redirect_stdout(io.StringIO()) as output: exec(script_body, env)
            result = json.loads(output.getvalue())
            assert result['reviewComplete'] is True and result['originalOutcome'] == 'unknown'
            assert result['legacySuccessRecorded'] is False and result['gameClaimSent'] is False
            assert acks == ['1','2','10'] and all(value == [] for value in records.values())
        else:
            try: exec(script_body, env)
            except RuntimeError: pass
            else: raise AssertionError('guard did not stop invalid review')
            assert acks == (['1','2'] if mode == 'post-failure' else [])
        assert protected_file.read_bytes() == b'{"phase":"unknown"}'
blocked = subprocess.run([sys.executable,str(helper),'--close-reviewed-task400001','patch.tar.gz','evidence.json'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
assert blocked.returncode != 0 and '--confirm-reviewed-records' in blocked.stderr
`;
    execFileSync('python', ['-c', script, path.join(root, '.workbuddy/scripts/verify-deploy.py')], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
});

test('牧场任务终态诊断显式授权，只逐号读取且不将缺失或错账号数据当作已领取', () => {
    const script = String.raw`
import importlib.util, pathlib, json, contextlib, io, sys, subprocess
helper = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('verify_deploy_readonly', helper)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for mode in ['valid', 'missing', 'wrong-account', 'wrong-scene', 'forbidden']:
    calls = []
    def api(route, body=None, account=None, token=None):
        calls.append((route, str(account)))
        if mode == 'forbidden': return {'ok': False, 'status': 403, 'error': 'no access'}
        account_id = 'wrong' if mode == 'wrong-account' and route == '/api/ranch/tasks' else str(account)
        if route == '/api/ranch/tasks':
            return {'ok': True, 'accountId': account_id,
                    'data': {'sceneId': 1 if mode == 'wrong-scene' else 2,
                             'tasks': [] if mode == 'missing' else [{'id': '400001', 'claimed': True}]}}
        if route == '/api/settings':
            return {'ok': True, 'data': {'automation': {'ranch_daily_tasks_claim': True}}}
        if route == '/api/ranch/bag':
            return {'ok': True, 'accountId': str(account), 'data': {'sceneId': 2, 'receivedAt': 1,
                    'cacheHit': False, 'goldVoucherBalance': '1007', 'items': [], 'pens': [],
                    'buckets': {'normal': '0', 'organic': '0'}}}
        if route == '/api/ranch/operations':
            return {'ok': True, 'accountId': str(account), 'data': {'pending': []}}
        raise AssertionError(route)
    with contextlib.redirect_stdout(io.StringIO()) as output:
        exec(module.TASK_TERMINAL_READ_BODY, {'json': json, 'api': api, 'token': 'offline'})
    result = json.loads(output.getvalue())
    assert result['claimSent'] is False and result['acknowledgeSent'] is False
    expected_accounts = ['1', '2', '10'] if mode in ['valid', 'missing'] else ['1']
    assert [aid for route, aid in calls if route == '/api/ranch/tasks'] == expected_accounts
    extra_reads = expected_accounts if mode in ['valid', 'missing'] else []
    assert [(route, aid) for route, aid in calls if route != '/api/ranch/tasks'] == [
        (route, aid) for aid in extra_reads for route in ['/api/settings', '/api/ranch/bag', '/api/ranch/operations']
    ]
    for row in result['accounts']:
        if mode == 'valid':
            assert row['task400001']['claimed'] is True and row['targetMissing'] is False
            assert row['dailyTasksAutoEnabled'] is True and row['bagRead']['goldVoucherBalance'] == '1007'
            assert row['bagRead']['voucherType'] == 'str' and row['bagRead']['itemsIsArray'] and row['bagRead']['pensIsArray']
        elif mode == 'missing': assert row['task400001'] is None and row['targetMissing'] is True
        else: assert row['ok'] is False
blocked = subprocess.run([sys.executable, str(helper), '--ranch-task-terminal', 'offline.tar.gz'],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
assert blocked.returncode != 0 and '--allow-task-read' in blocked.stderr
assert '登录 OK' not in blocked.stdout
`;
    execFileSync('python', ['-c', script, path.join(root, '.workbuddy/scripts/verify-deploy.py')], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
});

test('成长任务自动领取只改单字段，逐号预读/回读；未知结果不重试', () => {
    const script = String.raw`
import importlib.util, pathlib, json, contextlib, io, sys, subprocess
helper = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('verify_growth_setting', helper)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
for mode in ['success', 'already-one', 'offline', 'missing-key', 'write-error', 'readback-mismatch']:
    writes, calls = [], []
    state = {aid: {'ranch': True, 'ranch_daily_tasks_claim': True, 'ranch_growth_tasks_claim': mode == 'already-one' and aid == '1',
                   'ranch_activity_claim': True, 'ranch_daily_share_claim': False} for aid in ['1','2','10']}
    def api(route, body=None, account=None, token=None):
        aid = str(account); calls.append((route, aid))
        if route == '/api/status':
            return {'ok':True,'data':{'connection':{'connected': not (mode == 'offline' and aid == '1')}}}
        if route == '/api/settings':
            if mode == 'missing-key' and aid == '1': return {'ok':True,'data':{'automation':{'ranch':True}}}
            values = dict(state[aid])
            if mode == 'readback-mismatch' and aid == '1' and writes: values['ranch_growth_tasks_claim'] = False
            return {'ok':True,'data':{'automation':values}}
        assert route == '/api/automation'
        assert body == {'ranch_growth_tasks_claim':True}
        writes.append(aid)
        if mode == 'write-error' and aid == '2': return {'ok':False,'error':'offline'}
        state[aid].update(body)
        return {'ok':True,'data':{}}
    try:
        with contextlib.redirect_stdout(io.StringIO()) as output:
            exec(module.GROWTH_AUTO_ENABLE_BODY, {'json':json,'api':api,'token':'offline'})
        result = json.loads(output.getvalue())
        if mode in ['offline','missing-key','write-error','readback-mismatch']:
            raise AssertionError('guard accepted ' + mode)
        expected_writes = ['2','10'] if mode == 'already-one' else ['1','2','10']
        assert writes == expected_writes, (mode, writes)
        assert result['gameRpcSent'] is False
        assert result['patch'] == {'ranch_growth_tasks_claim':True}
        for row in result['accounts']:
            assert row['after']['ranch_growth_tasks_claim'] is True
            assert row['after']['ranch'] is True and row['after']['ranch_daily_tasks_claim'] is True
            assert row['after']['ranch_activity_claim'] is True and row['after']['ranch_daily_share_claim'] is False
    except RuntimeError:
        assert mode in ['offline','missing-key','write-error','readback-mismatch']
        if mode == 'offline': assert writes == []
        if mode == 'missing-key': assert writes == []
        if mode == 'write-error': assert writes == ['1','2']
        if mode == 'readback-mismatch': assert writes == ['1']
blocked = subprocess.run([sys.executable,str(helper),'--enable-growth-task-auto'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
assert blocked.returncode != 0 and '--confirm-growth-task-auto' in blocked.stderr
`;
    execFileSync('python', ['-c', script, path.join(root, '.workbuddy/scripts/verify-deploy.py')], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
});

test('全部牧场运行修复版本共用保护备份和单次重载门禁', () => {
    const script = runtimeGatePrelude + String.raw`
for script in (RELEASE_INSPECT_SCRIPT, RELEASE_INSTALL_SCRIPT, RELEASE_RANCH_RUNTIME_SAFETY_VERIFY):
    parsed = ast.parse(script)
    whitelists = [set(ast.literal_eval(node.comparators[0])) for node in ast.walk(parsed)
                  if isinstance(node, ast.Compare) and isinstance(node.left, ast.Call)
                  and isinstance(node.left.func, ast.Attribute) and node.left.func.attr == 'get'
                  and node.left.args and isinstance(node.left.args[0], ast.Constant)
                  and node.left.args[0].value in {'migration', 'manifestName'}
                  and isinstance(node.comparators[0], ast.Set)]
    assert (set(RELEASE_RANCH_RUNTIME_PROFILES) | set(RELEASE_RANCH_VISIT_PROFILES) | set(RELEASE_RANCH_ACTIVITY_PROFILES) | set(RELEASE_RANCH_MUGE_PROFILES) | set(RELEASE_RANCH_UNIFIED_PROFILES) ) in whitelists
assert 'protected-safety' in RELEASE_INSTALL_SCRIPT
assert 'ranch-operations/' in RELEASE_INSTALL_SCRIPT
assert 'friend-visit-recovery/' in RELEASE_INSTALL_SCRIPT
assert 'game-command-state/decoration-shop/' in RELEASE_INSTALL_SCRIPT
assert 'protectedSafetyFiles' in RELEASE_INSTALL_SCRIPT
assert "s.get('reloadCount') != 0" in RELEASE_RESUME_SCRIPT
release_source = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')
assert "if ranch_runtime or any(name.startswith('core/src/')" in release_source, '牧场运行profile须走单次业务重载及后置安全验收，即使本次仅静态资源有差异'
for migration in {**RELEASE_RANCH_RUNTIME_PROFILES, **RELEASE_RANCH_VISIT_PROFILES, **RELEASE_RANCH_ACTIVITY_PROFILES, **RELEASE_RANCH_MUGE_PROFILES, **RELEASE_RANCH_UNIFIED_PROFILES}:
    manifest = candidate(migration)
    load_release_manifest = lambda archive: manifest
    def ssh_connect(): raise AssertionError('危险参数校验不应访问网络')
    for options in ({'frontend_only': True}, {'allow_gateway_change': True}, {'build_app_only': True},
                    {'preserve_friend_unknown': True}, {'friend_history_stage': 'old-stage'}, {}):
        rejected(lambda: deploy_release('offline.tar.gz', **options))
    class Client:
        def close(self): pass
    ssh_connect = lambda: Client()
    load_panel_credentials = lambda: {}
    def inspect_payload(client, script, payload, **options):
        assert payload['noGameRpc'] is True and payload['announcements'] is False
        assert payload['accept'] is False and payload['staticAccept'] is True
        return {}
    remote_file_json = inspect_payload
    with contextlib.redirect_stdout(io.StringIO()): inspect_release('offline.tar.gz', accept=True)
    REMOTE = '/offline-fixture'
    profile = ranch_runtime_profile({'migration': migration})
    expected_source_hashes = {name: digest for name, digest in manifest['originalSourceHashes'].items()
                              if name not in profile.get('newFiles', set())}
    baseline = {'containers': {
        'qq-farm-bot': {'mounts': {'/app/core/src': REMOTE + '/core/src', '/app/web/dist': '/home/azureuser/web-dist'}},
        'farm-gateway': {'health': 'healthy', 'running': True}},
        'sourceHashes': dict(expected_source_hashes)}
    remote_file_json = lambda *args, **options: baseline
    baseline['differences'] = [next(iter(profile['preserved']))]
    rejected(lambda: deploy_release('offline.tar.gz', allow_main_reload=True))
    baseline['differences'] = ['core/src/runtime/gateway-process.js']
    rejected(lambda: deploy_release('offline.tar.gz', allow_main_reload=True))
    baseline['differences'] = [next(iter(profile['changed']))]
    baseline['sourceHashes'][baseline['differences'][0]] = '9' * 64
    rejected(lambda: deploy_release('offline.tar.gz', allow_main_reload=True))
    if profile.get('newFiles'):
        baseline['differences'] = list(profile['newFiles'])
        baseline['sourceHashes'][next(iter(profile['newFiles']))] = '8' * 64
        rejected(lambda: deploy_release('offline.tar.gz', allow_main_reload=True))
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory); stage = root / 'releases/stage'; stage.mkdir(parents=True)
    data = root / 'data'; data.mkdir()
    relative = 'friend-visit-recovery/1.attempt.json'
    before = b'{"status":"unknown"}'
    backup = stage / 'backup/protected-safety' / relative
    backup.parent.mkdir(parents=True); backup.write_bytes(before)
    current = data / relative; current.parent.mkdir(parents=True); current.write_bytes(before)
    script = RELEASE_RANCH_RUNTIME_SAFETY_VERIFY.replace('/home/azureuser/qq-farm-bot-main/.workbuddy/releases',
        (root / 'releases').as_posix()).replace('/home/azureuser/data', data.as_posix())
    def verify(state):
        (stage / 'state.json').write_text(json.dumps(state))
        stdin = sys.stdin
        try:
            sys.stdin = io.StringIO(json.dumps({'stage': str(stage)}))
            with contextlib.redirect_stdout(io.StringIO()) as output: exec(script, {})
            return json.loads(output.getvalue())
        finally: sys.stdin = stdin
    for migration in {**RELEASE_RANCH_RUNTIME_PROFILES, **RELEASE_RANCH_VISIT_PROFILES, **RELEASE_RANCH_ACTIVITY_PROFILES, **RELEASE_RANCH_MUGE_PROFILES, **RELEASE_RANCH_UNIFIED_PROFILES}:
        state = {'manifestName': migration, 'reloadCount': 1, 'backupComplete': True,
            'protectedSafetyFiles': [{'path': relative, 'sha256': hashlib.sha256(before).hexdigest()}],
            'gatewayTcpBaseline': {}, 'resumeAccountIds': ['1', '10', '2']}
        assert verify(state)['protectedSafetyFilesUnchanged'] == [relative]
        for count in (0, 2): rejected(lambda: verify({**state, 'reloadCount': count}))
        rejected(lambda: verify({**state, 'backupComplete': False}))
        current.write_bytes(b'{"status":"cleared"}')
        rejected(lambda: verify(state)); current.write_bytes(before)
        backup.write_bytes(b'changed-backup')
        rejected(lambda: verify(state)); backup.write_bytes(before)
        assert current.read_bytes() == before and backup.read_bytes() == before
`;
    execFileSync('python', ['-c', script, deploy], { encoding: 'utf8', timeout: 15000, windowsHide: true });
});
