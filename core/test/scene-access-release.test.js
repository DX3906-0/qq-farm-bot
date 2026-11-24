const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('牧场发布只对固定保护记录备份提权，安装仍用原账号且任何失败不自动续发', () => {
  const python = process.env.FARM_DEPLOY_PYTHON || (process.platform === 'win32' ? 'C:/Program Files/Python310/python.exe' : 'python3');
  const script = String.raw`
import ast,pathlib,sys,itertools
source=pathlib.Path(sys.argv[1])/'cloudbase/.ref/deploy.py'
tree=ast.parse(source.read_text(encoding='utf-8'))
names={'RELEASE_INSTALL_SCRIPT','RANCH_INTERRUPTED_SAFETY_BACKUP','RANCH_INTERRUPTED_INSTALL_VERIFY'}
nodes=[n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id in names for t in n.targets)
 or isinstance(n,ast.FunctionDef) and n.name=='install_ranch_release_with_protected_backup']
migrations=('ranch-panel-automation-20261121','ranch-combined-20261121','ranch-grass-verification-20261121')
ns={'RELEASE_RANCH_RUNTIME_PROFILES':dict.fromkeys(migrations,{})}
exec(compile(ast.Module(body=nodes,type_ignores=[]),str(source),'exec'),ns)
payload={'stage':'/home/azureuser/qq-farm-bot-main/.workbuddy/releases/20261121-222446-96c3452b45',
 'manifest':{'migration':'ranch-combined-20261121','name':'ranch-combined-20261121','planSha256':'reviewed','files':[]},
 'changed':[],'parts':[],'deltaSha256':'fixed','baseline':{'sourceHashes':{}}}
for migration,mode in itertools.product(migrations,('normal','backup-fails','verify-fails')):
 payload['manifest'].update({'migration':migration,'name':migration})
 calls=[]
 def remote(cli,code,p,**kw):
  calls.append((code,p,kw))
  name=kw['script_name']
  if name=='qq_farm_ranch_prepare_install.py':
   assert 'backup.mkdir' in code and 'data_root = ' not in code
   return {'prepared':True,'previous':[]}
  if name=='qq_farm_ranch_protected_backup.py':
   assert kw.get('sudo') is True and p=={'stage':payload['stage']}
   assert code==ns['RANCH_INTERRUPTED_SAFETY_BACKUP']
   if mode=='backup-fails':raise PermissionError('backup denied')
   return {'protectedSafetyFiles':[{'path':'friend-visit-recovery/1.attempt.json','sha256':'kept'}]}
  if name=='qq_farm_ranch_prepared_verify.py':
   if mode=='verify-fails':raise RuntimeError('baseline changed')
   return {'previous':[]}
  assert name=='qq_farm_ranch_finish_install.py'
  assert p['state']['reloadCount']==0 and p['state']['backupComplete'] is True
  assert p['state']['protectedSafetyFiles'][0]['sha256']=='kept'
  assert 'def install(src, dst):' in code
  return {'installedCount':0,'verifiedCount':0}
 ns['remote_file_json']=remote
 try:
  result=ns['install_ranch_release_with_protected_backup'](None,payload)
  assert mode=='normal' and result['installedCount']==0
 except (PermissionError,RuntimeError):assert mode!='normal'
 assert len(calls)=={'normal':4,'backup-fails':2,'verify-fails':3}[mode]
 assert sum(bool(c[2].get('sudo')) for c in calls)==1
 assert all(not c[2].get('sudo') for c in calls if c[2]['script_name']!='qq_farm_ranch_protected_backup.py')
try:ns['install_ranch_release_with_protected_backup'](None,{**payload,'manifest':{'migration':'unreviewed'}})
except RuntimeError:pass
else:raise AssertionError('Unreviewed migration accepted')
print('PROTECTED_BACKUP_PRIVILEGE_BOUNDARY_OK')
`;
  const output = execFileSync(python, ['-c', script, path.resolve(__dirname, '../..')], { encoding: 'utf8', timeout: 30000 });
  assert.match(output, /PROTECTED_BACKUP_PRIVILEGE_BOUNDARY_OK/);
});

test('场景诊断发布包仅含七项变更及原会话基线，不允许网关或自动写', () => {
  const python = process.env.FARM_DEPLOY_PYTHON || (process.platform === 'win32' ? 'C:/Program Files/Python310/python.exe' : 'python3');
  const script = String.raw`
import runpy,pathlib,tempfile,json,hashlib,sys
h=runpy.run_path(str(pathlib.Path(sys.argv[1])/'.workbuddy/scripts/scene-access-release.py'))
sessions={'core/src/runtime/runtime-engine.js','core/src/runtime/worker-manager.js','core/src/runtime/gateway-client.js','core/src/runtime/auto-code-refresh.js','core/src/utils/network.js','core/src/core/worker.js'}
assert len(h['CHANGED'])==7 and not any('gateway-process' in p for p in h['CHANGED'])
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);work=root/'.workbuddy';work.mkdir();build=work/'frontend';build.mkdir()
 names=h['CHANGED']|sessions|{'web-dist/index.html'}
 old=[]
 for name in names:
  file=build/'index.html' if name=='web-dist/index.html' else root/name
  file.parent.mkdir(parents=True,exist_ok=True);raw=b'// base';file.write_bytes(raw)
  old.append({'path':name,'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
 previous={'planSha256':'a'*64,'files':old,'dependencyEvidence':old,'installedRuntime':{}}
 (work/'ranch-maintenance-reviewed-plan.json').write_text(json.dumps(previous))
 (work/'ranch-maintenance-deployment-receipt.json').write_text(json.dumps({'ok':True,'planSha256':'a'*64,'stage':'prior'}))
 for name in h['CHANGED']:(root/name).write_bytes(b'// diagnostic')
 result=h['prepare'](root,sessions,build);m=h['load'](result['archive'],sessions)
 assert len(m['files'])==12 and m['gatewayChangeAllowed'] is False and m['automaticRanchWritesAllowed'] is False
 assert h['prepare'](root,sessions,build)['reused'] is True
 (work/'scene-access-deployment-receipt.json').write_text(json.dumps({'ok':True,'planSha256':m['planSha256'],'archive':result['archive'],'stage':'diagnostic'}))
 helper=root/'core/src/services/player-login-protocol.js';helper.write_bytes(b'// pure login adapter')
 for name in h['UPGRADE_CHANGED']:
  if name!=str(helper.relative_to(root)).replace('\\\\','/'):(root/name).write_bytes(b'// upgrade')
 upgraded=h['prepare'](root,sessions,build,upgrade=True)
 upgraded_manifest=h['load'](upgraded['archive'],sessions)
 assert upgraded_manifest['upgradeAccountIds']==['2']
 assert upgraded_manifest['originalSourceHashes']['core/src/services/player-login-protocol.js'] is None
 assert len(upgraded_manifest['files'])==11
 # Restore the first-stage changed files before testing protected baseline drift.
 for name in h['CHANGED']:(root/name).write_bytes(b'// diagnostic')
 (root/'core/src/runtime/gateway-client.js').write_bytes(b'// unexpected drift')
 try:h['prepare'](root,sessions,build)
 except RuntimeError:pass
 else:raise AssertionError('Protected session drift accepted')
print('ok')
`;
  assert.equal(execFileSync(python, ['-c', script, path.resolve(__dirname, '../..')],
    { encoding: 'utf8', timeout: 90000, windowsHide: true }).trim(), 'ok');
});

test('牧场运行修复包仅放行具名业务闭包，未审核迁移与兼容漂移仍阻断', () => {
  const python = process.env.FARM_DEPLOY_PYTHON || (process.platform === 'win32' ? 'C:/Program Files/Python310/python.exe' : 'python3');
  const script = String.raw`
import ast,pathlib,tempfile,sys,json,hashlib,tarfile,io,contextlib,types
source=pathlib.Path(sys.argv[1])/'cloudbase/.ref/deploy.py'
tree=ast.parse(source.read_text(encoding='utf-8'))
constants={'RELEASE_SESSION_FILES','RELEASE_RANCH_RUNTIME_MIGRATION','RELEASE_RANCH_RUNTIME_CHANGED','RELEASE_RANCH_RUNTIME_REVIEWED',
 'RELEASE_RANCH_RUNTIME_PRESERVED','RELEASE_RANCH_RUNTIME_FILES','RELEASE_BACKEND_ALLOWLIST',
 'RELEASE_STATIC_ALLOWLIST','RELEASE_COMBINED_MIGRATION'}
functions={'validate_ranch_runtime_manifest','registered_release_artwork','load_release_manifest','package_ranch_runtime_release'}
nodes=[node for node in tree.body if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and
 (target.id in constants or target.id.startswith(('RELEASE_RANCH_RUNTIME_', 'RELEASE_RANCH_COMBINED_', 'RELEASE_RANCH_GRASS_'))) for target in node.targets)
 or isinstance(node,ast.FunctionDef) and node.name in functions]
ns={'pathlib':pathlib,'json':json,'hashlib':hashlib,'tarfile':tarfile,'io':io}
exec(compile(ast.Module(body=nodes,type_ignores=[]),str(source),'exec'),ns)
assert 'core/src/runtime/gateway-process.js' not in ns['RELEASE_RANCH_RUNTIME_FILES']
assert ns['RELEASE_RANCH_RUNTIME_CHANGED'] & ns['RELEASE_RANCH_RUNTIME_PRESERVED']==set()
assert set(ns['RELEASE_RANCH_RUNTIME_REVIEWED'])=={'core/src/runtime/gateway-client.js','core/src/services/ranch-friends.js','core/src/utils/network.js'}
# Keep the real validation branch but replace live hashes with exact fake fixture bytes.
ns['RELEASE_RANCH_RUNTIME_REVIEWED'].update({name:{'before':hashlib.sha256(b'// base').hexdigest(),
 'after':hashlib.sha256(b'// fixed').hexdigest()} for name in ns['RELEASE_RANCH_RUNTIME_REVIEWED']})
class Sftp:
 def lstat(self,name): return types.SimpleNamespace(st_mode=0o100644)
 def open(self,name,mode): return io.BytesIO(b'// base')
 def close(self): pass
class Ssh:
 def open_sftp(self): return Sftp()
 def close(self): pass
ns['ssh_connect']=lambda:Ssh()
ns['REMOTE']='/fake/qq-farm-bot-main'
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);work=root/'.workbuddy';work.mkdir()
 build=work/'frontend-ranch-runtime-20261121-prod';build.mkdir();(build/'index.html').write_text('<html></html>')
 ns['BASE']=str(root)
 for name in ns['RELEASE_RANCH_RUNTIME_FILES']:
  file=root/name;file.parent.mkdir(parents=True,exist_ok=True)
  file.write_bytes(b'// fixed' if name in ns['RELEASE_RANCH_RUNTIME_CHANGED'] else b'// base')
 archive=work/'repair.tar.gz'
 with contextlib.redirect_stdout(io.StringIO()): ns['package_ranch_runtime_release'](build,archive)
 m=ns['load_release_manifest'](archive)
 assert m['gatewayRestartAllowed'] is False and m['noGameRpcAcceptance'] is True
 assert set(m['requiredUnchangedFiles'])==ns['RELEASE_RANCH_RUNTIME_PRESERVED']
 assert len(m['files'])==len(ns['RELEASE_RANCH_RUNTIME_FILES'])+1
 def sign(value):
  value=dict(value);value.pop('planSha256',None)
  value['planSha256']=hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
  return value
 def rejected(value):
  try: ns['validate_ranch_runtime_manifest'](sign(value))
  except RuntimeError: return
  raise AssertionError('Unsafe runtime manifest accepted')
 rejected(dict(m,gatewayRestartAllowed=True))
 rejected(dict(m,noGameRpcAcceptance=False))
 rejected(dict(m,frontendBuild='frontend-readonly'))
 rejected(dict(m,changedFilesAllowed=list(m['changedFilesAllowed'])+['core/src/runtime/gateway-process.js']))
 rejected(dict(m,reviewedTransportChanges={}))
 transport=sorted(ns['RELEASE_RANCH_RUNTIME_REVIEWED'])[0]
 forged=json.loads(json.dumps(m));next(row for row in forged['files'] if row['path']==transport)['sha256']='e'*64
 rejected(forged)
 forged=json.loads(json.dumps(m));forged['originalSourceHashes'][transport]='e'*64
 rejected(forged)
 name=sorted(ns['RELEASE_RANCH_RUNTIME_PRESERVED'])[0]
 altered=json.loads(json.dumps(m));next(row for row in altered['files'] if row['path']==name)['sha256']='f'*64
 rejected(altered)
 # The existing audit-only/unknown ranch migration remains rejected, not renamed to bypass a guard.
 with tarfile.open(work/'unknown.tar.gz','w:gz') as tar:
  value=json.dumps(dict(m,migration='ranch-unreviewed')).encode()
  item=tarfile.TarInfo('release-manifest.json');item.size=len(value);tar.addfile(item,io.BytesIO(value))
 try: ns['load_release_manifest'](work/'unknown.tar.gz')
 except RuntimeError: pass
 else: raise AssertionError('Unknown ranch migration accepted')
 # Local tests must use the same protected dependency bytes as the live source.
 (root/name).write_bytes(b'// unrelated local change')
 try:
  with contextlib.redirect_stdout(io.StringIO()): ns['package_ranch_runtime_release'](build,work/'drift.tar.gz')
 except RuntimeError: pass
 else: raise AssertionError('Protected local dependency drift accepted')
 assert not (work/'drift.tar.gz').exists()
 # Interrupted installation resumes only after exact original/payload verification.
 constants={}
 for node in tree.body:
  if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id.startswith('RANCH_INTERRUPTED_') for t in node.targets):
   exec(compile(ast.Module(body=[node],type_ignores=[]),'<recovery-constant>','exec'),constants)
 stage=root/'.workbuddy/releases/interrupted';stage.mkdir(parents=True)
 backup=stage/'backup';backup.mkdir()
 source=root/'core/src/unit.js';source.parent.mkdir(parents=True,exist_ok=True);source.write_bytes(b'old')
 old=backup/'core/src/unit.js';old.parent.mkdir(parents=True);old.write_bytes(b'old')
 payload=stage/'payload/core/src/unit.js';payload.parent.mkdir(parents=True);payload.write_bytes(b'new')
 with tarfile.open(stage/'delta.tar.gz','w:gz') as tar:
  item=tarfile.TarInfo('core/src/unit.js');item.size=3;tar.addfile(item,io.BytesIO(b'new'))
 sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
 data={'stage':str(stage),'changed':['core/src/unit.js'],'deltaSha256':sha(stage/'delta.tar.gz'),
       'manifest':{'files':[{'path':'core/src/unit.js','sha256':sha(payload)}],
                   'originalSourceHashes':{'core/src/unit.js':sha(source)}}}
 def invoke(code,values):
  code=code.replace('/home/azureuser/qq-farm-bot-main',root.as_posix()).replace('/home/azureuser/data',(root/'data').as_posix())
  oldin=__import__('sys').stdin;__import__('sys').stdin=io.StringIO(json.dumps(values));out=io.StringIO()
  try:
   with contextlib.redirect_stdout(out): exec(compile(code,'<interrupted-test>','exec'),{})
  finally: __import__('sys').stdin=oldin
  return json.loads(out.getvalue())
 verify=constants['RANCH_INTERRUPTED_INSTALL_VERIFY']
 assert invoke(verify,data)['ok']
 source.write_bytes(b'drift')
 try: invoke(verify,data)
 except RuntimeError: pass
 else: raise AssertionError('Original source drift accepted')
 source.write_bytes(b'old');(stage/'state.json').write_text('{}')
 try: invoke(verify,data)
 except RuntimeError: pass
 else: raise AssertionError('Repeated installation accepted')
 (stage/'state.json').unlink()
 safety=constants['RANCH_INTERRUPTED_SAFETY_BACKUP']
 record=root/'data/ranch-operations'/(hashlib.sha256(b'1').hexdigest()[:24]+'.json')
 record.parent.mkdir(parents=True);record.write_bytes(b'[{"pending":true}]')
 result=invoke(safety,{'stage':str(stage)})
 assert len(result['protectedSafetyFiles'])==1 and record.read_bytes()==b'[{"pending":true}]'
 assert invoke(safety,{'stage':str(stage)})==result
 record.write_bytes(b'[{"changed":true}]')
 try: invoke(safety,{'stage':str(stage)})
 except RuntimeError: pass
 else: raise AssertionError('Existing safety backup overwritten')
print('ok')
`;
  assert.equal(execFileSync(python, ['-c', script, path.resolve(__dirname, '../..')],
    { encoding: 'utf8', timeout: 90000, windowsHide: true }).trim(), 'ok');
});
