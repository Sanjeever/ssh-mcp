import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { dial } from '../.build/test/ssh/client.js';
import { exec, cleanOutput, MAX_OUTPUT_BYTES } from '../.build/test/ssh/exec.js';
import { operationSignal } from '../.build/test/errors.js';
import { startSSH } from './helpers/ssh-server.mjs';
import { execSession } from './helpers/exec-session.mjs';
import { startCLI } from './helpers/stdio.mjs';

const initial = () => ({ stdout: '', stderr: '', exit_code: null, output_truncated: false });
test('命令输出、数值退出码、信号、缺失退出码与持续排空', async t => {
  const s = await startSSH(t, { session: execSession });
  for (const [command, expected] of [['ok', null], ['fail', 'ssh_exit_nonzero'], ['signal', 'ssh_exit_signal'], ['missing', 'ssh_exec_unknown'], ['large', null], ['invalid', null]]) {
    const connection = await dial(s.config, { knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' }, new AbortController().signal);
    const result = initial();
    try {
      if (expected) await assert.rejects(exec(connection, command, result), error => error.code === expected);
      else await exec(connection, command, result);
    } finally { connection.close(); }
    if (command === 'ok' || command === 'fail') { assert.equal(result.stdout, 'remote ok\n'); assert.equal(result.stderr, 'remote warning\n'); assert.equal(result.exit_code, command === 'ok' ? 0 : 7); }
    if (command === 'signal' || command === 'missing') assert.equal(result.exit_code, null);
    if (command === 'large') { assert.equal(result.output_truncated, true); assert(Buffer.byteLength(result.stdout + result.stderr) <= MAX_OUTPUT_BYTES); assert.equal(result.exit_code, 0); }
    if (command === 'invalid') assert.equal(result.stdout, '?x');
  }
  assert.equal(cleanOutput(Buffer.from('a�中')), 'a�中');
  for (let bytes = 1; bytes < 4; bytes++) assert.equal(cleanOutput(Buffer.from('😀').subarray(0, bytes)), '');
  assert.equal(cleanOutput(Buffer.from([0xe0, 0x80])), '?');
});
test('执行、会话等待取消及超时保留已有输出', async t => {
  for (const mode of ['cancel', 'timeout', 'session']) {
    const s = await startSSH(t, { session: execSession, hangSession: mode === 'session' });
    const controller = new AbortController(), op = operationSignal(controller.signal, 3);
    const c = await dial(s.config, { knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' }, op.signal, op.deadline);
    if (mode === 'cancel') setTimeout(() => controller.abort(), 250);
    const result = initial();
    try { await assert.rejects(exec(c, 'hang', result), error => error.code === (mode === 'cancel' ? 'ssh_canceled' : 'ssh_timeout')); }
    finally { c.close(); op.dispose(); }
    assert.equal(result.exit_code, null);
    if (mode !== 'session') assert.equal(result.stdout, 'partial');
  }
});
test('stdio 命令契约、中文校验和结构化失败', async t => {
  const s = await startSSH(t, { session: execSession });
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
  await p.init();
  for (const command of ['ok', 'fail', 'signal', 'missing', 'large']) {
    const res = await p.request('tools/call', { name: 'ssh_exec', arguments: { server_id: 'test', command } }).result;
    assert.equal(res.isError, ['fail', 'signal', 'missing'].includes(command)); assert.equal(typeof res.structuredContent.duration_ms, 'number');
  }
  for (const extra of [{ extra: 'secret' }, { timeout_seconds: 0 }, { timeout_seconds: 3601 }, { timeout_seconds: 1.5 }, { server_id: 'TEST' }, { command: '' }]) {
    const res = await p.request('tools/call', { name: 'ssh_exec', arguments: { server_id: 'test', command: 'ok', ...extra } }).result;
    assert.equal(res.isError, true); assert(!JSON.stringify(res).includes('secret'));
  }
  const unknown = await p.request('tools/call', { name: 'ssh_exec', arguments: { server_id: 'unknown', command: 'ok' } }).result;
  assert.equal(unknown.structuredContent.error.code, 'ssh_server_unknown'); assert.equal(unknown.structuredContent.exit_code, null);
  p.child.stdin.end(); assert.equal((await p.closed)[0], 0); assert.equal(p.diagnostics(), '');
});
test('MCP 取消、EOF 与终止信号清理活动 SSH 连接', { timeout: 15000 }, async t => {
  for (const mode of ['cancel', 'eof', 'signal']) {
    if (mode === 'signal' && process.platform === 'win32') continue;
    const s = await startSSH(t, { session: execSession });
    const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
    await p.init();
    const request = p.request('tools/call', { name: 'ssh_exec', arguments: { server_id: 'test', command: 'hang' } });
    request.result.catch(() => {});
    for (let i = 0; !s.authCount() && i < 100; i++) await delay(10);
    assert(s.authCount() > 0);
    if (mode === 'cancel') p.send({ method: 'notifications/cancelled', params: { requestId: request.id, reason: '测试取消' } });
    else if (mode === 'eof') p.child.stdin.end();
    else p.child.kill('SIGTERM');
    for (let i = 0; s.clients.size && i < 100; i++) await delay(10);
    assert.equal(s.clients.size, 0);
    if (mode === 'cancel') p.child.stdin.end();
    assert.equal((await p.closed)[0], 0); assert.equal(p.diagnostics(), '');
  }
});
