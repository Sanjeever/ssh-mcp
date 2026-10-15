import test from 'node:test';
import assert from 'node:assert/strict';
import { registryState, publishPackage } from './release.mjs';

const response = (status, value) => ({ status, stdout: Buffer.from(JSON.stringify(value)) });
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
  const pkg = { name: '@sanjeever/ssh-mcp-linux-x64', filename: 'test.tgz', integrity: 'sha512-test' };
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
