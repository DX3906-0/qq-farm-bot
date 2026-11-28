const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('维护标记仅缺失时正常放行；无效、符号链接或读取失败必须保持停号', () => {
  let value;
  let failure;
  let symlink = false;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/account-maintenance-hold.js'), 'utf8'), {
    module, exports: module.exports,
    require(id) {
      if (id === '../config/runtime-paths') return { getDataFile: name => '/memory/data/' + name };
      if (id === 'node:fs') return {
        lstatSync() {
          if (failure) throw Object.assign(new Error(failure), { code: failure });
          if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return { isFile: () => true, isSymbolicLink: () => symlink, size: value.length };
        },
        readFileSync: () => value,
      };
      throw new Error('Unexpected module: ' + id);
    },
  });
  const held = module.exports.isAccountMaintenanceHeld;
  assert.equal(held('1'), false);
  value = JSON.stringify({ schemaVersion: 1, held: true, accountIds: ['1', '2', '10'] });
  assert.equal(held('1'), true);
  assert.equal(held('10'), true);
  assert.equal(held('99'), false);
  symlink = true; assert.equal(held('99'), true); symlink = false;
  for (const invalid of ['{', '{}', 'null', JSON.stringify({ schemaVersion: 1, held: false, accountIds: ['1'] }), 'x'.repeat(17000)]) {
    value = invalid; assert.equal(held('1'), true);
  }
  failure = 'EACCES'; assert.equal(held('1'), true);
});
