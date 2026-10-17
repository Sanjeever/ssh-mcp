import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startSSH } from './helpers/ssh-server.js';
import { execSession } from './helpers/exec-session.js';
import { startCLI } from './helpers/stdio.js';
import { TaskStore } from '../src/tasks.js';
import { OutputStore, OUTPUT_TTL_MS } from '../src/output-store.js';
import { OperationScheduler } from '../src/scheduler.js';

test('异步命令及时返回，运行中读取输出，结果保留退出失败与取消语义', async t => {
  const s = await startSSH(t, { session: execSession });
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
  await p.init();
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await p.request('tools/call', { name, arguments: args }).result;
    assert.equal(response.isError, false, JSON.stringify(response)); return response.structuredContent!;
  };
  const finish = (task_id: unknown) => call('ssh_task_status', { task_id, wait_seconds: 5 });
  const task = await call('ssh_exec_start', { server_id: 'test', command: 'hang' });
  assert.equal(typeof task.task_id, 'string'); assert.equal(task.result, undefined);
  const page = await call('ssh_output', { output_id: task.output_id, wait_seconds: 5 });
  assert.equal(page.finished, false); assert.equal(page.text, 'partial');
  const listed = await call('ssh_task_list', {});
  assert.deepEqual(listed.tasks, [await call('ssh_task_status', { task_id: task.task_id })]);
  assert(!JSON.stringify(listed).includes('partial')); assert(!JSON.stringify(listed).includes('hang'));
  const activeForget = await p.request('tools/call', { name: 'ssh_output_forget', arguments: { output_id: task.output_id } }).result;
  assert.equal((activeForget.structuredContent?.error as { code: string }).code, 'ssh_output_active');
  const canceled = await call('ssh_task_cancel', { task_id: task.task_id }); assert.equal(canceled.cancel_requested, true);
  const final = await finish(task.task_id);
  assert.equal(final.status, 'canceled'); assert.equal((final.result as { error: { code: string } }).error.code, 'ssh_canceled');
  assert.equal((final.result as { stdout: string }).stdout, 'partial');
  assert.equal(typeof final.expires_at, 'string');
  const summaries = (await call('ssh_task_list', {})).tasks as Array<Record<string, unknown>>;
  assert.equal(summaries[0]?.result, undefined); assert.equal(summaries[0]?.status, 'canceled');
  assert.equal((await call('ssh_task_cancel', { task_id: task.task_id })).status, 'canceled');
  assert.equal((await call('ssh_output_forget', { output_id: task.output_id })).forgotten, true);
  assert.deepEqual((await call('ssh_task_list', {})).tasks, []);
  const sync = await call('ssh_exec', { server_id: 'test', command: 'ok', save_output: true });
  const shared = await call('ssh_task_list', {});
  assert.deepEqual(shared.tasks, []);
  assert.deepEqual(shared.output_capacity, { used: 1, limit: 8, available: 7, active: 0, releasable: 1 });
  await call('ssh_output_forget', { output_id: sync.output_id });
  const forgotten = await p.request('tools/call', { name: 'ssh_task_status', arguments: { task_id: task.task_id } }).result;
  assert.equal((forgotten.structuredContent?.error as { code: string }).code, 'ssh_task_unknown');
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
  const tasks = new TaskStore(config, outputs, root.signal, new OperationScheduler(), () => now);
  const task = tasks.start({ server_id: 'test', command: 'hang', timeout_seconds: 1 });
  for (let attempt = 0; !tasks.get(task.task_id).result && attempt < 100; attempt++) await delay(20);
  const final = tasks.get(task.task_id);
  assert.equal(final.status, 'failed'); assert.equal(final.result?.error?.code, 'ssh_timeout');
  const other = new TaskStore(config, outputs, new AbortController().signal);
  assert.deepEqual(other.list().tasks, []);
  assert.throws(() => other.get(task.task_id), { code: 'ssh_task_unknown' });
  now += OUTPUT_TTL_MS;
  assert.deepEqual(tasks.list().tasks, []);
  assert.throws(() => tasks.get(task.task_id), { code: 'ssh_task_unknown' });
  assert.throws(() => outputs.read(task.output_id, 'stdout', 0, 256), { code: 'ssh_output_unknown' });
  root.abort(); assert.throws(() => tasks.start({ server_id: 'test', command: 'ok', timeout_seconds: 1 }), { code: 'ssh_canceled' });
});

test('等待任务到期或取消观察不会取消任务，会话结束会中断等待', async t => {
  const s = await startSSH(t, { session: execSession });
  const root = new AbortController(), outputs = new OutputStore();
  const config = { servers: new Map([[s.config.id, s.config]]), knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' as const };
  const tasks = new TaskStore(config, outputs, root.signal);
  const task = tasks.start({ server_id: 'test', command: 'hang', timeout_seconds: 5 });
  const bounded = await tasks.wait(task.task_id, 0.02, root.signal);
  assert.equal(bounded.result, undefined); assert.equal(bounded.cancel_requested, false);
  const controller = new AbortController();
  const canceled = tasks.wait(task.task_id, 1, controller.signal);
  controller.abort(); await assert.rejects(canceled, { code: 'ssh_canceled' });
  assert.equal(tasks.get(task.task_id).cancel_requested, false);
  const waiting = tasks.wait(task.task_id, 1, root.signal);
  root.abort(); await assert.rejects(waiting, { code: 'ssh_canceled' });
});

test('MCP EOF 关闭已返回句柄的异步命令连接', async t => {
  const s = await startSSH(t, { session: execSession });
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
  await p.init();
  const task = (await p.request('tools/call', { name: 'ssh_exec_start', arguments: { server_id: 'test', command: 'hang' } }).result).structuredContent!;
  for (let attempt = 0; !s.clients.size && attempt < 100; attempt++) await delay(10);
  assert(s.clients.size > 0);
  const waiting = [
    p.request('tools/call', { name: 'ssh_task_status', arguments: { task_id: task.task_id, wait_seconds: 30 } }),
    p.request('tools/call', { name: 'ssh_output', arguments: { output_id: task.output_id, stream: 'stderr', wait_seconds: 30 } }),
  ];
  for (const request of waiting) request.result.catch(() => {});
  p.child.stdin.end(); assert.equal((await p.closed)[0], 0);
  for (let attempt = 0; s.clients.size && attempt < 100; attempt++) await delay(10);
  assert.equal(s.clients.size, 0);
  assert.equal(p.diagnostics(), '');
});

test('stdio 取消任务及输出观察请求不取消原任务', { timeout: 10000 }, async t => {
  const s = await startSSH(t, { session: execSession });
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
  await p.init();
  const task = (await p.request('tools/call', { name: 'ssh_exec_start', arguments: { server_id: 'test', command: 'hang' } }).result).structuredContent!;
  const page = await p.request('tools/call', { name: 'ssh_output', arguments: { output_id: task.output_id, wait_seconds: 3 } }).result;
  assert.equal(page.structuredContent?.text, 'partial');
  const waiting = [
    p.request('tools/call', { name: 'ssh_task_status', arguments: { task_id: task.task_id, wait_seconds: 30 } }),
    p.request('tools/call', { name: 'ssh_output', arguments: { output_id: task.output_id, offset: 7, wait_seconds: 30 } }),
  ];
  for (const request of waiting) request.result.catch(() => {});
  await p.request('tools/call', { name: 'ssh_task_list', arguments: {} }).result;
  for (const request of waiting) p.send({ method: 'notifications/cancelled', params: { requestId: request.id, reason: '取消观察' } });
  const snapshot = await p.request('tools/call', { name: 'ssh_task_status', arguments: { task_id: task.task_id } }).result;
  assert.equal(snapshot.structuredContent?.status, 'running'); assert.equal(snapshot.structuredContent?.cancel_requested, false);
  assert(s.clients.size > 0);
  await p.request('tools/call', { name: 'ssh_task_cancel', arguments: { task_id: task.task_id } }).result;
  const final = await p.request('tools/call', { name: 'ssh_task_status', arguments: { task_id: task.task_id, wait_seconds: 3 } }).result;
  assert.equal(final.structuredContent?.status, 'canceled');
  p.child.stdin.end(); assert.equal((await p.closed)[0], 0); assert.equal(p.diagnostics(), '');
});

test('任务容量满时提示查询与释放，释放已结束任务后可立即启动', async t => {
  const s = await startSSH(t, { session: execSession });
  const root = new AbortController(), outputs = new OutputStore(); t.after(() => root.abort());
  const config = { servers: new Map([[s.config.id, s.config]]), knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' as const };
  const tasks = new TaskStore(config, outputs, root.signal);
  const started = Array.from({ length: 8 }, () => tasks.start({ server_id: 'test', command: 'ok', timeout_seconds: 5 }));
  await Promise.all(started.map(task => tasks.wait(task.task_id, 5, root.signal)));
  assert.deepEqual(tasks.list().output_capacity, { used: 8, limit: 8, available: 0, active: 0, releasable: 8 });
  assert.throws(() => tasks.start({ server_id: 'test', command: 'ok', timeout_seconds: 5 }), error => error instanceof Error && /ssh_task_list.*ssh_output_forget/.test(error.message) && 'code' in error && error.code === 'ssh_task_limit');
  const removed = started[0]!;
  outputs.forget(removed.output_id); tasks.forgetOutput(removed.output_id);
  assert.equal(tasks.list().output_capacity.available, 1);
  const next = tasks.start({ server_id: 'test', command: 'ok', timeout_seconds: 5 });
  assert.equal((await tasks.wait(next.task_id, 5, root.signal)).status, 'completed');
});
