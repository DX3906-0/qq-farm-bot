'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildClosure, readDeployCandidates, allowed, ENTRY_SEEDS } = require('../../.workbuddy/scripts/ranch-release-closure.cjs');

function fixture(t, entries) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ranch-closure-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [name, content] of Object.entries(entries)) {
        const filename = path.join(root, name);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, typeof content === 'string' ? content : JSON.stringify(content));
    }
    return root;
}
const scan = (root, seeds, extra = {}) => buildClosure({ root, seeds, includeEntries: false, ...extra });
const paths = report => report.files.map(file => file.path);

test('静态递归本地依赖、循环、proto import 与字面资源，绝不执行源码', t => {
    const root = fixture(t, {
        'core/client.js': "throw Error('禁止执行业务'); require('./src/a'); require('./src/a');",
        'core/src/a.js': "const { getResourcePath } = require('./config/runtime-paths'); require('./b'); getResourcePath('proto', 'a.proto'); getResourcePath('gameConfig', 'ranch', 'Goods.json');",
        'core/src/b/index.js': "require('../a'); require('node:fs');",
        'core/src/config/runtime-paths.js': 'exports.getResourcePath = () => { throw Error("不得执行"); };',
        'core/src/proto/a.proto': '// import "absent.proto";\nimport public "b.proto";\nmessage A {}',
        'core/src/proto/b.proto': 'message B {}',
        'core/src/gameConfig/ranch/Goods.json': [],
    });
    const report = scan(root, ['core/client.js']);
    assert.equal(report.complete, true);
    assert.equal(report.files.length, 7);
    assert(report.edges.some(edge => edge.kind === 'proto-import' && edge.line === 2));
    assert(report.edges.filter(edge => edge.to === 'core/src/a.js').length >= 3);
    for (const file of report.files) {
        assert.match(file.sha256, /^[a-f0-9]{64}$/);
        assert.equal(file.size, fs.statSync(path.join(root, file.path)).size);
    }
});

test('仅解析 Python 候选常量，不执行 import、函数和顶层副作用', t => {
    const root = fixture(t, {
        'deploy.py': "import package_that_does_not_exist\nraise RuntimeError('不得运行')\nRANCH_BACKEND_FILES = ['core/src/a.js']\nRANCH_FRONTEND_FILES = ['web/src/a.ts']\nOTHER = ['/private/key']\n",
        'core/src/a.js': '',
        'web/src/a.ts': '',
    });
    const constants = readDeployCandidates(path.join(root, 'deploy.py'));
    assert.deepEqual(constants.map(item => item.name), ['RANCH_BACKEND_FILES', 'RANCH_FRONTEND_FILES']);
    const report = buildClosure({ root, includeEntries: false });
    assert.equal(report.complete, true);
    assert(report.inputs.some(input => input.kind === 'python-ast'));
    assert(report.inputs.some(input => input.kind === 'analyzer' && input.parser.name === 'typescript'));
    assert.equal(report.seeds.length, 2);
    assert(!paths(report).includes('deploy.py'));
});

test('缺少候选清单或存在非字面常量时不得宣称 complete', t => {
    const root = fixture(t, { 'core/client.js': '' });
    const missing = buildClosure({ root, includeEntries: false });
    assert.equal(missing.complete, false);
    assert(missing.errors.some(item => item.kind === 'candidate-seeds'));
    fs.writeFileSync(path.join(root, 'deploy.py'), "RANCH_BACKEND_FILES = list_files()\n");
    const dynamic = buildClosure({ root, includeEntries: false });
    assert(dynamic.errors.some(item => item.kind === 'candidate-constant'));
    assert.equal(dynamic.complete, false);
});

test('动态 require 必须留定位和精确范围哈希，审核不能使用通配目录', t => {
    const root = fixture(t, {
        'core/src/a.js': "const target = './b'; require(target);",
        'core/src/b.js': 'module.exports = 1;',
    });
    const initial = scan(root, ['core/src/a.js']);
    assert.equal(initial.complete, false);
    const item = initial.pending.find(entry => entry.kind === 'dynamic-require');
    assert(item && item.line === 1 && item.column > 1);
    assert.match(item.rangeSha256, /^[a-f0-9]{64}$/);
    assert(paths(initial).includes('core/src/b.js'));
    const target = initial.files.find(file => file.path === 'core/src/b.js');
    const review = { id: item.id, fileSha256: item.fileSha256, rangeSha256: item.rangeSha256, reviewer: '本地测试审核', reason: '精确有限目标已核对', mode: 'exact-targets', targets: [target] };
    const approved = scan(root, ['core/src/a.js'], { reviews: [review] });
    assert.equal(approved.complete, true);
    assert.equal(approved.reviewed.length, 1);
    const wide = scan(root, ['core/src/a.js'], { reviews: [{ ...review, targets: [{ ...target, path: 'core/src/**' }] }] });
    assert.equal(wide.complete, false);
    fs.appendFileSync(path.join(root, 'core/src/a.js'), '\n// 任何文件漂移均使审核失效\n');
    const drifted = scan(root, ['core/src/a.js'], { reviews: [review] });
    assert.equal(drifted.complete, false);
    assert(drifted.errors.some(entry => entry.kind === 'invalid-review'));
});

test('fs 计算资源及目录枚举不得自动纳入整树或被忽略', t => {
    const root = fixture(t, {
        'core/src/a.js': "const fs = require('fs'); const path = require('path'); const base = path.join(__dirname, 'gameConfig'); const file = path.join(base, 'A.json'); fs.readFileSync(file); fs.readdirSync(base); fs.readFileSync(runtimePath);",
        'core/src/gameConfig/A.json': [],
        'core/src/gameConfig/private.json': { mustNotInclude: true },
    });
    const report = scan(root, ['core/src/a.js']);
    assert(paths(report).includes('core/src/gameConfig/A.json'));
    assert(!paths(report).includes('core/src/gameConfig/private.json'));
    assert.equal(report.pending.filter(item => item.kind === 'resource-directory').length, 1);
    assert.equal(report.pending.filter(item => item.kind === 'fs-resource').length, 1);
    assert.equal(report.complete, false);
});

test('词法参数遮蔽不得错误解析为上层资源常量', t => {
    const root = fixture(t, {
        'core/src/a.js': "const fs = require('fs'); const file = './fixed.json'; function read(file) { fs.readFileSync(file); }",
        'core/src/fixed.json': [],
    });
    const report = scan(root, ['core/src/a.js']);
    assert.equal(report.pending.length, 1);
    assert(!paths(report).includes('core/src/fixed.json'));
});

test('数据、环境、个人路径、目录及符号链接均禁止打包', t => {
    const root = fixture(t, {
        'core/src/a.js': "require('../data/accounts.json'); require('./.env.json');",
        'core/data/accounts.json': { secret: '测试夹具' },
        'core/src/.env.json': { secret: '测试夹具' },
    });
    const report = scan(root, ['core/src/a.js']);
    assert.equal(report.complete, false);
    assert.deepEqual(paths(report), ['core/src/a.js']);
    assert.equal(allowed('core/src/../../local_cfg.json'), false);
    assert.equal(allowed('web/public/personal/a.json'), false);
    assert.equal(allowed('core/node_modules/ws/index.js'), false);
    assert.equal(allowed('core/src/config/key.pem'), false);
    assert.equal(scan(root, ['core/src/']).complete, false);
    try { fs.symlinkSync(path.join(root, 'core/src/a.js'), path.join(root, 'core/src/link.js')); }
    catch (err) { if (err.code === 'EPERM' || err.code === 'EACCES') return; throw err; }
    assert.equal(scan(root, ['core/src/link.js']).complete, false);
});

test('外部依赖核对 dependencies、lock 和安装元数据但不打包 node_modules', t => {
    const root = fixture(t, {
        'core/src/a.js': "require('test-external');",
        'core/package.json': { dependencies: { 'test-external': '^1.0.0' } },
        'core/package-lock.json': { lockfileVersion: 3, packages: { '': { dependencies: { 'test-external': '^1.0.0' } }, 'node_modules/test-external': { version: '1.2.0', integrity: 'sha512-test' } } },
        'core/node_modules/test-external/package.json': { name: 'test-external', version: '1.2.0', main: 'index.js' },
        'core/node_modules/test-external/index.js': 'throw Error("禁止执行外部依赖");',
    });
    const report = scan(root, ['core/src/a.js']);
    assert.equal(report.complete, true);
    assert.equal(report.externals[0].valid, true);
    assert.equal(report.externals[0].packaged, false);
    assert(!paths(report).some(name => name.includes('node_modules')));
    fs.writeFileSync(path.join(root, 'core/node_modules/test-external/package.json'), JSON.stringify({ name: 'test-external', version: '2.0.0', main: 'index.js' }));
    const mismatch = scan(root, ['core/src/a.js']);
    assert.equal(mismatch.complete, false);
    assert(mismatch.errors.some(item => item.kind === 'external-declaration'));
});

test('前端 Vue/TS 静态 import、别名和资源递归解析', t => {
    const root = fixture(t, {
        'web/src/A.vue': '<template><img src="/game-config/ranch/a.png"></template>\n<script setup lang="ts">\nimport value from "@/value";\n</script>\n<style scoped>@import "./a.css";</style>',
        'web/src/value.ts': 'export default 1;',
        'web/src/a.css': 'body { background: url("../public/ranch/b.png"); }',
        'web/public/game-config/ranch/a.png': '测试图像夹具',
        'web/public/ranch/b.png': '测试图像夹具',
    });
    const report = scan(root, ['web/src/A.vue']);
    assert.equal(report.complete, true);
    assert.equal(report.files.length, 5);
    assert(report.edges.some(edge => edge.kind === 'import' && edge.line === 3));
});

test('本地目录 package.json main 优先于 index，并避免包入口自环', t => {
    const root = fixture(t, {
        'core/src/a.js': "require('./bundle');",
        'core/src/bundle/package.json': { main: 'main.js' },
        'core/src/bundle/main.js': '',
        'core/src/bundle/index.js': 'throw Error("不应选中");',
    });
    const report = scan(root, ['core/src/a.js']);
    assert.equal(report.complete, true);
    assert(paths(report).includes('core/src/bundle/main.js'));
    assert(!paths(report).includes('core/src/bundle/index.js'));
    fs.writeFileSync(path.join(root, 'core/src/bundle/package.json'), JSON.stringify({ main: '.' }));
    const cycle = scan(root, ['core/src/a.js']);
    assert.equal(cycle.complete, false);
    assert(cycle.errors.some(item => item.kind === 'local-package-cycle'));
});

test('fs/路径命名导入别名、计算成员和异步 API 不漏报', t => {
    const root = fixture(t, {
        'web/src/a.ts': "import {readFile as read} from 'node:fs/promises'; import {join as combine} from 'node:path'; read(combine(__dirname, 'value.json'));",
        'web/src/value.json': [],
        'core/src/a.js': "const fs = require('fs'); fs['readFileSync'](unknown); fs[operation](unknown); const load = require; load('./hidden');",
    });
    const frontend = scan(root, ['web/src/a.ts']);
    assert.equal(frontend.complete, true);
    assert(paths(frontend).includes('web/src/value.json'));
    const backend = scan(root, ['core/src/a.js']);
    assert.equal(backend.complete, false);
    for (const kind of ['fs-resource', 'dynamic-fs-method', 'dynamic-require-alias']) assert(backend.pending.some(item => item.kind === kind));
});

test('旧审核、目标字节漂移与代码依赖 runtime-exclusion 均不能通过', t => {
    const root = fixture(t, {
        'core/src/a.js': 'require(dynamic);',
        'core/src/b.js': '',
    });
    const initial = scan(root, ['core/src/a.js']);
    const item = initial.pending[0];
    const review = { id: item.id, fileSha256: item.fileSha256, rangeSha256: item.rangeSha256, reviewer: '本地测试审核', reason: '测试禁止排除代码边', mode: 'runtime-exclusion', targets: [] };
    assert.equal(scan(root, ['core/src/a.js'], { reviews: [review] }).complete, false);
    assert(scan(root, ['core/src/a.js'], { reviews: [{ ...review, id: '旧审核范围' }] }).errors.some(entry => entry.kind === 'stale-review'));
    const staleTarget = { path: 'core/src/b.js', size: 0, sha256: '0'.repeat(64) };
    assert.equal(scan(root, ['core/src/a.js'], { reviews: [{ ...review, mode: 'exact-targets', targets: [staleTarget] }] }).complete, false);
});

test('空白种子不能借默认入口伪装成发布候选闭包', t => {
    const root = fixture(t, { 'core/client.js': '' });
    assert.throws(() => buildClosure({ root, seeds: [] }), /非空精确路径数组/);
});

test('默认入口明确包含主入口、网关及五个微信 maintenance 模块', () => {
    assert.equal(ENTRY_SEEDS.length, 7);
    assert(ENTRY_SEEDS.includes('core/src/runtime/gateway-process.js'));
    assert(ENTRY_SEEDS.includes('core/src/services/wx-login/credential-storage.js'));
});
