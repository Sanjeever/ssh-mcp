import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bump, check, validVersion } from './version.mjs';
import { metadata } from './build.mjs';
import { platforms } from './platforms.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'ssh-mcp-version-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'docs/releases'), { recursive: true });
  writeFileSync(join(base, 'package.json'), JSON.stringify({ name: '@sanjeever/ssh-mcp', version: '0.1.0', license: 'MIT', repository: { type: 'git', url: 'git+https://github.com/Sanjeever/ssh-mcp.git' }, optionalDependencies: Object.fromEntries(platforms.map(p => [p.name, '0.1.0'])) }));
  writeFileSync(join(base, 'LICENSE'), '测试许可证');
  writeFileSync(join(base, 'docs/releases/0.1.0.md'), '## 新增\n\n- 实现 SSH 工具。\n');
  return base;
}

test('bump 与 check 同步六个平台版本和元数据', t => {
  const base = fixture(t);
  assert.equal(check(base, 'v0.1.0'), '0.1.0');
  writeFileSync(join(base, 'docs/releases/0.2.0.md'), '## 新增\n\n- 测试版本。\n');
  bump(base, '0.2.0');
  assert.equal(check(base, 'v0.2.0'), '0.2.0');
  const pkg = JSON.parse(readFileSync(join(base, 'package.json')));
  assert.deepEqual(Object.values(pkg.optionalDependencies), Array(6).fill('0.2.0'));
  for (const p of platforms) {
    const manifest = JSON.parse(readFileSync(join(base, 'dist/npm', p.id, 'package.json')));
    assert.equal(manifest.name, p.name); assert.equal(manifest.version, '0.2.0');
    assert.deepEqual(manifest.os, [p.os]); assert.deepEqual(manifest.cpu, [p.cpu]);
    assert.equal(p.goos, p.os === 'win32' ? 'windows' : p.os);
    assert.equal(p.goarch, p.cpu === 'x64' ? 'amd64' : 'arm64');
    assert.equal(readFileSync(join(base, 'dist/npm', p.id, 'LICENSE'), 'utf8'), '测试许可证');
  }
  pkg.optionalDependencies[platforms[0].name] = '^0.2.0'; writeFileSync(join(base, 'package.json'), JSON.stringify(pkg));
  assert.throws(() => check(base, 'v0.2.0'), /精确依赖/);
});

test('非法版本、标签、缺失或空日志不会部分改写版本', t => {
  const base = fixture(t); metadata(base);
  const before = readFileSync(join(base, 'package.json'), 'utf8');
  for (const version of ['01.0.0', '1.00.0', 'v1.0.0', '1.0', '1.0.0-beta.1', '1.0.0+meta', '1.0.9007199254740992', '', undefined]) {
    assert.equal(validVersion(version), false); assert.throws(() => bump(base, version));
  }
  for (const tag of ['v01.0.0', 'v0.1.0-beta', 'v0.1.1', '0.1.0']) assert.throws(() => check(base, tag));
  assert.throws(() => bump(base, '0.2.0'), /缺少更新日志/);
  writeFileSync(join(base, 'docs/releases/0.2.0.md'), ' \n\t');
  assert.throws(() => bump(base, '0.2.0'), /不能为空/);
  assert.equal(readFileSync(join(base, 'package.json'), 'utf8'), before);
  assert.equal(JSON.parse(readFileSync(join(base, 'dist/npm', platforms[0].id, 'package.json'))).version, '0.1.0');
  writeFileSync(join(base, 'docs/releases/0.1.0.md'), '');
  assert.throws(() => check(base, 'v0.1.0'), /不能为空/);
});
