import test from 'node:test';
import assert from 'node:assert/strict';
import { registryState, publishPackage, validateManifest } from './release.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const response = (status, value) => ({ status, stdout: Buffer.from(JSON.stringify(value)) });
test('单包恢复记录拒绝版本、包名、路径与产物摘要冲突', t => {
  const base = mkdtempSync(join(tmpdir(), 'ssh-release-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'docs/releases'), { recursive: true }); mkdirSync(join(base, 'dist/packages'), { recursive: true });
  writeFileSync(join(base, 'package.json'), JSON.stringify({ version: '0.2.0' })); writeFileSync(join(base, 'docs/releases/0.2.0.md'), '迁移。');
  const payload = Buffer.from('用于摘要验证的测试产物'), filename = 'sanjeever-ssh-mcp-0.2.0.tgz';
  writeFileSync(join(base, 'dist/packages', filename), payload);
  const manifest = { version: '0.2.0', package: { name: '@sanjeever/ssh-mcp', filename, integrity: 'sha512-' + createHash('sha512').update(payload).digest('base64') } };
  validateManifest(manifest, base);
  for (const patch of [{ name: 'other' }, { filename: '../escape.tgz' }, { integrity: 'sha512-wrong' }]) assert.throws(() => validateManifest({ ...manifest, package: { ...manifest.package, ...patch } }, base));
  assert.throws(() => validateManifest({ ...manifest, version: '0.1.1' }, base));
  writeFileSync(join(base, 'dist/packages', filename), '内容变化'); assert.throws(() => validateManifest(manifest, base));
});
test('恢复发布只跳过完整性匹配的版本，拒绝其他 registry 错误', () => {
  assert.equal(registryState(response(0, 'sha512-test'), 'sha512-test'), 'identical');
  assert.equal(registryState(response(1, { error: { code: 'E404' } }), 'sha512-test'), 'missing');
  assert.throws(() => registryState(response(0, 'sha512-other'), 'sha512-test'), /不一致/);
  for (const code of ['E401', 'E403', 'E500', 'ECONNRESET', 'EAI_AGAIN']) {
    assert.throws(() => registryState(response(1, { error: { code } }), 'sha512-test'), /停止发布/);
  }
  assert.throws(() => registryState({ status: 1, stdout: Buffer.from('invalid') }, 'sha512-test'), /停止发布/);
});
test('发布错误向上传递，不将发布失败当成已存在', () => {
  let calls = 0;
  const pkg = { name: '@sanjeever/ssh-mcp', filename: 'test.tgz', integrity: 'sha512-test' };
  assert.throws(() => publishPackage(pkg, '0.1.0', args => {
    calls++;
    if (args[0] === 'view') return response(1, { error: { code: 'E404' } });
    throw new Error('测试发布失败');
  }), /测试发布失败/);
  assert.equal(calls, 2);
  calls = 0;
  publishPackage(pkg, '0.1.0', args => { calls++; assert.equal(args[0], 'view'); return response(0, 'sha512-test'); });
  assert.equal(calls, 1);
});
