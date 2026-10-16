import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { dial } from '../src/ssh/client.js';
import { exec, MAX_OUTPUT_BYTES, createExecResult } from '../src/ssh/exec.js';
import { operationSignal } from '../src/errors.js';
import { startSSH } from './helpers/ssh-server.js';
import { execSession } from './helpers/exec-session.js';
import { startCLI, executionOutput, failureOutput } from './helpers/stdio.js';
import { SSHError } from '../src/errors.js';
import { OutputCapture, cleanOutput } from '../src/ssh/output.js';

const initial = createExecResult;
test('命令输出、数值退出码、信号、缺失退出码与持续排空', async t => {
  const s = await startSSH(t, { session: execSession });
  for (const [command, expected] of [['ok', null], ['fail', 'ssh_exit_nonzero'], ['signal', 'ssh_exit_signal'], ['missing', 'ssh_exec_unknown'], ['large', null], ['invalid', null]] as const) {
    const connection = await dial(s.config, { servers: new Map(), knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' }, new AbortController().signal);
    const result = initial();
    try {
      if (expected) await assert.rejects(exec(connection, command, result), error => error instanceof SSHError && error.code === expected);
      else await exec(connection, command, result);
    } finally { connection.close(); }
    if (command === 'ok' || command === 'fail') { assert.equal(result.stdout, 'remote ok\n'); assert.equal(result.stderr, 'remote warning\n'); assert.equal(result.exit_code, command === 'ok' ? 0 : 7); }
    if (command === 'signal' || command === 'missing') assert.equal(result.exit_code, null);
    if (command === 'signal') assert.equal(result.exit_signal, 'SIGTERM');
    if (command === 'large') { assert.equal(result.output_truncated, true); assert(Buffer.byteLength(result.stdout + result.stderr) <= MAX_OUTPUT_BYTES); assert.equal(result.exit_code, 0); }
    if (command === 'invalid') assert.equal(result.stdout, '?x');
  }
  assert.equal(cleanOutput(Buffer.from('a�中')), 'a�中');
  for (let bytes = 1; bytes < 4; bytes++) assert.equal(cleanOutput(Buffer.from('😀').subarray(0, bytes)), '');
  assert.equal(cleanOutput(Buffer.from([0xe0, 0x80])), '?');
});
test('输出保留两端和独立 stderr 配额，stdin 支持空输入与大文本 EOF', async t => {
  const s = await startSSH(t, { session: execSession });
  for (const mode of ['head', 'tail', 'head_tail'] as const) {
    const c = await dial(s.config, { servers: new Map(), knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' }, new AbortController().signal);
    const result = initial();
    try { await assert.rejects(exec(c, 'late_error', result, undefined, { output_mode: mode }), { code: 'ssh_exit_nonzero' }); }
    finally { c.close(); }
    assert.equal(result.stderr, '最后的错误原因\n'); assert.equal(result.stderr_truncated, false);
    assert.equal(result.stdout_truncated, true); assert(result.stdout_bytes > 96 * 1024);
    assert(Buffer.byteLength(result.stdout) <= 96 * 1024);
    assert.equal(result.stdout.startsWith('BEGIN\n'), mode !== 'tail');
    assert.equal(result.stdout.endsWith('\nEND\n'), mode !== 'head');
    assert(!result.stdout.includes('�'));
  }
  for (const stdin of ['', '中文输入\n'.repeat(10000)]) {
    const c = await dial(s.config, { servers: new Map(), knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' }, new AbortController().signal);
    const result = initial();
    try { await exec(c, 'stdin', result, undefined, { stdin }); } finally { c.close(); }
    assert.equal(result.exit_code, 0); assert.equal(result.stdout_bytes, Buffer.byteLength(stdin));
    if (!stdin) assert.equal(result.stdout, ''); else assert.equal(result.output_truncated, true);
  }
  // 逐字节到达跨越环形尾部边界，输出仍是完整 UTF-8。
  const capture = new OutputCapture(128, 'head_tail');
  for (const byte of Buffer.from('中文😀'.repeat(100))) capture.append(Buffer.from([byte]));
  assert(!capture.result().text.includes('�')); assert(capture.result().omitted > 0);
  const rendered = capture.result().text.replace('\n[...已省略输出...]\n', '');
  assert.equal(capture.bytes - Buffer.byteLength(rendered), capture.result().omitted);
});
test('执行、会话等待取消及超时保留已有输出', async t => {
  for (const mode of ['cancel', 'timeout', 'session']) {
    const s = await startSSH(t, { session: execSession, hangSession: mode === 'session' });
    const controller = new AbortController(), op = operationSignal(controller.signal, 3);
    const c = await dial(s.config, { servers: new Map(), knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' }, op.signal, op.deadline);
    if (mode === 'cancel') setTimeout(() => controller.abort(), 250);
    const result = initial();
    try { await assert.rejects(exec(c, 'hang', result), error => error instanceof SSHError && error.code === (mode === 'cancel' ? 'ssh_canceled' : 'ssh_timeout')); }
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
    assert.equal(res.isError, ['fail', 'signal', 'missing'].includes(command)); assert.equal(typeof executionOutput.parse(res.structuredContent).duration_ms, 'number');
  }
  for (const extra of [{ extra: 'secret' }, { timeout_seconds: 0 }, { timeout_seconds: 3601 }, { timeout_seconds: 1.5 }, { server_id: 'TEST' }, { command: '' }, { output_mode: 'other' }, { stdin: '中'.repeat(350000) }]) {
    const res = await p.request('tools/call', { name: 'ssh_exec', arguments: { server_id: 'test', command: 'ok', ...extra } }).result;
    assert.equal(res.isError, true); assert(!JSON.stringify(res).includes('secret'));
  }
  const unknown = await p.request('tools/call', { name: 'ssh_exec', arguments: { server_id: 'unknown', command: 'ok' } }).result;
  assert.equal(failureOutput.parse(unknown.structuredContent).error.code, 'ssh_server_unknown'); assert.equal(executionOutput.parse(unknown.structuredContent).exit_code, null);
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
