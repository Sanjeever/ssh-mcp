import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { OperationScheduler } from '../src/scheduler.js';
import { startSSH } from './helpers/ssh-server.js';
import { execSession } from './helpers/exec-session.js';
import { startCLI } from './helpers/stdio.js';

test('全局与每服务器限额同时生效，跳板计入配额，忙碌主机不阻塞其他主机', async () => {
  const scheduler = new OperationScheduler({ global: 2, perServer: 1, queue: 4 }), signal = new AbortController().signal;
  const first = await scheduler.acquire(['a', 'gateway'], signal);
  let aStarted = false, gatewayStarted = false;
  const a = scheduler.acquire(['a'], signal).then(release => { aStarted = true; return release; });
  const gateway = scheduler.acquire(['b', 'gateway'], signal).then(release => { gatewayStarted = true; return release; });
  const independent = await scheduler.acquire(['c'], signal);
  assert.equal(aStarted, false); assert.equal(gatewayStarted, false);
  independent(); first();
  const aRelease = await a, gatewayRelease = await gateway;
  assert.equal(aStarted, true); assert.equal(gatewayStarted, true);
  aRelease(); aRelease(); gatewayRelease();
  const next = await scheduler.acquire(['a', 'gateway'], signal); next();
});

test('排队取消释放队列容量，不占连接；满队列明确拒绝', async () => {
  const scheduler = new OperationScheduler({ global: 1, perServer: 1, queue: 1 }), root = new AbortController();
  const active = await scheduler.acquire(['a'], root.signal);
  const queued = new AbortController(), waiting = scheduler.acquire(['b'], queued.signal);
  await assert.rejects(scheduler.acquire(['c'], root.signal), { code: 'ssh_queue_full' });
  queued.abort(); await assert.rejects(waiting, { code: 'ssh_canceled' });
  const replacement = scheduler.acquire(['c'], root.signal);
  active(); (await replacement)();
  root.abort(); await assert.rejects(scheduler.acquire(['a'], root.signal), { code: 'ssh_canceled' });
});

test('同步和异步共用限额，排队时间计入总超时，取消排队任务不连接远端', async t => {
  const s = await startSSH(t, { session: execSession });
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts'), SSH_MCP_MAX_CONCURRENT: '1', SSH_MCP_MAX_CONCURRENT_PER_SERVER: '1', SSH_MCP_MAX_QUEUE: '1' });
  await p.init();
  const first = await p.request('tools/call', { name: 'ssh_exec_start', arguments: { server_id: 'test', command: 'hang' } }).result;
  for (let attempt = 0; !s.authCount() && attempt < 100; attempt++) await delay(10);
  assert(s.authCount() > 0);
  const authBefore = s.authCount();
  const queued = p.request('tools/call', { name: 'ssh_exec', arguments: { server_id: 'test', command: 'ok', timeout_seconds: 1 } }).result;
  await delay(30);
  const full = await p.request('tools/call', { name: 'ssh_probe', arguments: { server_id: 'test' } }).result;
  assert.equal((full.structuredContent?.error as { code: string }).code, 'ssh_queue_full');
  const timeout = await queued;
  assert.equal((timeout.structuredContent?.error as { code: string }).code, 'ssh_timeout');
  assert.equal((timeout.structuredContent?.error as { phase: string }).phase, 'queue');
  assert.equal((timeout.structuredContent?.error as { operation_state: string }).operation_state, 'not_started');
  assert.equal(s.authCount(), authBefore);
  const second = await p.request('tools/call', { name: 'ssh_exec_start', arguments: { server_id: 'test', command: 'ok' } }).result;
  assert.equal(second.structuredContent?.status, 'queued');
  await p.request('tools/call', { name: 'ssh_task_cancel', arguments: { task_id: second.structuredContent?.task_id } }).result;
  await delay(20); assert.equal(s.authCount(), authBefore);
  await p.request('tools/call', { name: 'ssh_task_cancel', arguments: { task_id: first.structuredContent?.task_id } }).result;
  const after = await p.request('tools/call', { name: 'ssh_exec', arguments: { server_id: 'test', command: 'ok' } }).result;
  assert.equal(after.isError, false);
  p.child.stdin.end(); await p.closed;
});
