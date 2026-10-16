import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bump, check, validVersion } from './version.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'ssh-version-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'docs/releases'), { recursive: true });
  writeFileSync(join(base, 'package.json'), JSON.stringify({ name: '@sanjeever/ssh-mcp', version: '0.1.1', dependencies: { ssh2: '1.17.0' } }));
  writeFileSync(join(base, 'docs/releases/0.1.1.md'), '修复握手超时。');
  return base;
}
test('单包 bump 与标签检查保留运行依赖', t => {
  const base = fixture(t); assert.equal(check(base, 'v0.1.1'), '0.1.1');
  writeFileSync(join(base, 'docs/releases/0.2.0.md'), '迁移 TypeScript。');
  bump(base, '0.2.0'); assert.equal(check(base, 'v0.2.0'), '0.2.0');
  const pkg = JSON.parse(readFileSync(join(base, 'package.json')));
  assert.deepEqual(pkg.dependencies, { ssh2: '1.17.0' }); assert.equal(pkg.optionalDependencies, undefined);
});
test('非法版本、标签、缺失、空或非中文日志不会部分改写版本', t => {
  const base = fixture(t), before = readFileSync(join(base, 'package.json'), 'utf8');
  for (const version of ['01.0.0', '1.00.0', 'v1.0.0', '1.0', '1.0.0-beta.1', '1.0.0+meta', '1.0.9007199254740992', '', undefined]) { assert.equal(validVersion(version), false); assert.throws(() => bump(base, version)); }
  for (const tag of ['v01.0.0', 'v0.1.1-beta', 'v0.2.0', '0.1.1']) assert.throws(() => check(base, tag));
  assert.throws(() => bump(base, '0.2.0'), /缺少更新日志/);
  for (const notes of [' \n\t', 'English only']) { writeFileSync(join(base, 'docs/releases/0.2.0.md'), notes); assert.throws(() => bump(base, '0.2.0')); }
  assert.equal(readFileSync(join(base, 'package.json'), 'utf8'), before);
  writeFileSync(join(base, 'docs/releases/0.1.1.md'), ''); assert.throws(() => check(base, 'v0.1.1'), /不能为空/);
});
