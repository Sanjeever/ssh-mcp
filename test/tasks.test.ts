import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startSSH } from './helpers/ssh-server.js';
import { execSession } from './helpers/exec-session.js';
import { startCLI } from './helpers/stdio.js';
import { TaskStore } from '../src/tasks.js';
import { OutputStore, OUTPUT_TTL_MS } from '../src/output-store.js';

test('异步命令及时返回，运行中读取输出，结果保留退出失败与取消语义', async t => {
  const s = await startSSH(t, { session: execSession });
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
  await p.init();
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await p.request('tools/call', { name, arguments: args }).result;
    assert.equal(response.isError, false, JSON.stringify(response)); return response.structuredContent!;
  };
  const finish = async (task_id: unknown) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const snapshot = await call('ssh_task_status', { task_id });
      if (snapshot.result) return snapshot;
      await delay(20);
    }
    assert.fail('任务未结束');
  };
  const task = await call('ssh_exec_start', { server_id: 'test', command: 'hang' });
  assert.equal(typeof task.task_id, 'string'); assert.equal(task.result, undefined);
  let text = '';
  for (let attempt = 0; attempt < 100 && !text; attempt++) {
    const page = await call('ssh_output', { output_id: task.output_id });
    assert.equal(page.finished, false); text = String(page.text); if (!text) await delay(20);
  }
  assert.equal(text, 'partial');
  const canceled = await call('ssh_task_cancel', { task_id: task.task_id }); assert.equal(canceled.cancel_requested, true);
  const final = await finish(task.task_id);
  assert.equal(final.status, 'canceled'); assert.equal((final.result as { error: { code: string } }).error.code, 'ssh_canceled');
  assert.equal((final.result as { stdout: string }).stdout, 'partial');
  assert.equal((await call('ssh_task_cancel', { task_id: task.task_id })).status, 'canceled');
  for (const command of ['ok', 'fail', 'missing']) {
    const started = await call('ssh_exec_start', { server_id: 'test', command, stdout_max_bytes: 256 });
    const completed = await finish(started.task_id);
    assert.equal(completed.status, command === 'ok' ? 'completed' : 'failed');
    if (command === 'fail') assert.equal((completed.result as { exit_code: number }).exit_code, 7);
    if (command === 'missing') assert.equal((completed.result as { exit_code: number | null }).exit_code, null);
  }
  p.child.stdin.end(); await p.closed;
});

test('异步任务总超时、过期与会话边界', async t => {
  const s = await startSSH(t, { session: execSession });
  let now = Date.now();
  const root = new AbortController(), outputs = new OutputStore(() => now);
  const config = { servers: new Map([[s.config.id, s.config]]), knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' as const };
  const tasks = new TaskStore(config, outputs, root.signal, () => now);
  const task = tasks.start({ server_id: 'test', command: 'hang', timeout_seconds: 1 });
  for (let attempt = 0; !tasks.get(task.task_id).result && attempt < 100; attempt++) await delay(20);
  const final = tasks.get(task.task_id);
  assert.equal(final.status, 'failed'); assert.equal(final.result?.error?.code, 'ssh_timeout');
  const other = new TaskStore(config, outputs, new AbortController().signal);
  assert.throws(() => other.get(task.task_id), { code: 'ssh_task_unknown' });
  now += OUTPUT_TTL_MS;
  assert.throws(() => tasks.get(task.task_id), { code: 'ssh_task_unknown' });
  assert.throws(() => outputs.read(task.output_id, 'stdout', 0, 256), { code: 'ssh_output_unknown' });
  root.abort(); assert.throws(() => tasks.start({ server_id: 'test', command: 'ok', timeout_seconds: 1 }), { code: 'ssh_canceled' });
});

test('MCP EOF 关闭已返回句柄的异步命令连接', async t => {
  const s = await startSSH(t, { session: execSession });
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
  await p.init();
  await p.request('tools/call', { name: 'ssh_exec_start', arguments: { server_id: 'test', command: 'hang' } }).result;
  for (let attempt = 0; !s.clients.size && attempt < 100; attempt++) await delay(10);
  assert(s.clients.size > 0);
  p.child.stdin.end(); assert.equal((await p.closed)[0], 0);
  for (let attempt = 0; s.clients.size && attempt < 100; attempt++) await delay(10);
  assert.equal(s.clients.size, 0);
});
