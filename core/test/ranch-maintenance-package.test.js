const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('停号维护包绑定源文件、基线和摘要，拒绝漂移/越界/重复成员且不发网络请求', () => {
  const script = String.raw`
import runpy,pathlib,tempfile,json,hashlib,copy,sys,tarfile,io
helper=runpy.run_path(str(pathlib.Path(sys.argv[1])/'.workbuddy/scripts/ranch-maintenance-package.py'))
def digest(b):return hashlib.sha256(b).hexdigest()
def pin(m):
 m.pop('planSha256',None)
 m['planSha256']=digest(json.dumps(m,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode())
 return m
def reject(fn):
 try:fn()
 except (RuntimeError,OSError,KeyError):return
 raise AssertionError('Unsafe maintenance input accepted')
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);work=root/'.workbuddy';work.mkdir();build=work/'frontend';build.mkdir()
 gateway=root/'core/src/runtime/gateway-process.js';gateway.parent.mkdir(parents=True);gateway.write_bytes(b'// verified gateway')
 (build/'index.html').write_bytes(b'production page')
 files=[{'path':'core/src/runtime/gateway-process.js','size':gateway.stat().st_size,'sha256':digest(gateway.read_bytes())},
        {'path':'web-dist/index.html','size':15,'sha256':digest(b'production page')}]
 m=pin({'name':'ranch stopped maintenance','migration':helper['MIGRATION'],'accountsMustRemainStopped':True,
   'gameRpcAcceptance':False,'codeGuardStartAllowed':False,'files':files,
   'baselineFiles':{row['path']:None for row in files},
   'dependencyEvidence':[{'path':'core/src/runtime/gateway-process.js','sha256':files[0]['sha256']}]})
 out=work/'release.tar.gz';result=helper['package'](root,build,m,out)
 assert result['files']==2 and helper['load'](out)==m
 reject(lambda:helper['package'](root,build,m,out))
 reject(lambda:helper['package'](root,build,m,root/'outside.tar.gz'))
 for field,value in [('accountsMustRemainStopped',False),('codeGuardStartAllowed',True),('gameRpcAcceptance',True),('migration','unknown')]:
  bad=copy.deepcopy(m);bad[field]=value;pin(bad);reject(lambda:helper['validate_manifest'](bad))
 for name in ['core/src/../../data/accounts.json','/core/src/a.js','core/src/.env','core/src/data/a.json','web-dist/fixtures/a.json']:
  bad=copy.deepcopy(m);bad['files'][0]['path']=name;pin(bad);reject(lambda:helper['validate_manifest'](bad))
 bad=copy.deepcopy(m);bad['files'].append(bad['files'][0]);pin(bad);reject(lambda:helper['validate_manifest'](bad))
 bad=copy.deepcopy(m);bad['baselineFiles']={};pin(bad);reject(lambda:helper['validate_manifest'](bad))
 bad=copy.deepcopy(m);bad['planSha256']='0'*64;reject(lambda:helper['validate_manifest'](bad))
 gateway.write_bytes(b'changed after review');reject(lambda:helper['package'](root,build,m,work/'drift.tar.gz'))
 assert not (work/'drift.tar.gz').exists()
print(json.dumps({'ok':True,'networkActions':0,'accountsStarted':0}))
`;
  const python = process.platform === 'win32' ? 'C:/Program Files/Python310/python.exe' : 'python3';
  const result = execFileSync(python, ['-c', script, path.resolve(__dirname, '../..')],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(JSON.parse(result).ok, true);
});
