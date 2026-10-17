import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { OutputStore, SAVED_STREAM_BYTES, MAX_SAVED_OUTPUTS, OUTPUT_TTL_MS } from '../src/output-store.js';
import { startSSH } from './helpers/ssh-server.js';
import { execSession } from './helpers/exec-session.js';
import { startCLI } from './helpers/stdio.js';
import { setTimeout as delay } from 'node:timers/promises';

test('保存输出有容量、有效期和会话边界，分页不切断 UTF-8', () => {
  let now = 0;
  const store = new OutputStore(() => now), id = store.create();
  const original = '中文😀'.repeat(100);
  store.append(id, 'stdout', Buffer.from(original));
  let offset = 0, text = '';
  while (offset < Buffer.byteLength(original)) {
    const page = store.read(id, 'stdout', offset, 257);
    assert(page.next_offset > offset); offset = page.next_offset; text += page.text;
    assert.equal(page.finished, false);
  }
  assert.equal(text, original);
  store.append(id, 'stderr', Buffer.alloc(SAVED_STREAM_BYTES + 12, 97));
  const limited = store.read(id, 'stderr', 0, 256);
  assert.equal(limited.available_bytes, SAVED_STREAM_BYTES); assert.equal(limited.total_bytes, SAVED_STREAM_BYTES + 12); assert.equal(limited.storage_truncated, true);
  for (let i = 1; i < MAX_SAVED_OUTPUTS; i++) store.create();
  assert.throws(() => store.create(), { code: 'ssh_output_limit' });
  assert.throws(() => store.create(), /ssh_output_forget/);
  assert.deepEqual(store.capacity(), { used: 8, limit: 8, available: 0, active: 8, releasable: 0 });
  store.finish(id); assert.equal(store.read(id, 'stdout', offset, 256).eof, true);
  assert.deepEqual(store.capacity(), { used: 8, limit: 8, available: 0, active: 7, releasable: 1 });
  assert.throws(() => store.read(id, 'stdout', offset + 1, 256), { code: 'ssh_input_invalid' });
  now += OUTPUT_TTL_MS;
  assert.equal(store.capacity().available, 1);
  assert.throws(() => store.read(id, 'stdout', 0, 256), { code: 'ssh_output_unknown' });
  store.create(); store.clear();
  assert.throws(() => store.read(id, 'stdout', 0, 256), { code: 'ssh_output_unknown' });
});

test('增量页等待尚未到齐的 UTF-8 字符，最终非法尾部可以消费', () => {
  const store = new OutputStore(), id = store.create();
  const character = Buffer.from('中');
  store.append(id, 'stdout', character.subarray(0, 2));
  const partial = store.read(id, 'stdout', 0, 256);
  assert.equal(partial.text, ''); assert.equal(partial.next_offset, 0);
  store.append(id, 'stdout', character.subarray(2));
  assert.equal(store.read(id, 'stdout', partial.next_offset, 256).text, '中');
  store.append(id, 'stdout', character.subarray(0, 2)); store.finish(id);
  assert.equal(store.read(id, 'stdout', 3, 256).next_offset, 5);
});

test('显式释放完成输出归还容量，活动输出不能释放', () => {
  const store = new OutputStore(), id = store.create();
  assert.throws(() => store.forget(id), { code: 'ssh_output_active' });
  for (let index = 1; index < MAX_SAVED_OUTPUTS; index++) store.create();
  store.finish(id); assert.equal(store.forget(id).forgotten, true);
  assert.equal(store.capacity().available, 1);
  assert.throws(() => store.read(id, 'stdout', 0, 256), { code: 'ssh_output_unknown' });
  store.create(); assert.throws(() => store.create(), { code: 'ssh_output_limit' });
});

test('尾部读取在保存区内按预算定位，保留 UTF-8 边界并报告保存截断', async () => {
  const store = new OutputStore(), id = store.create(), signal = new AbortController().signal;
  const waiting = store.readWait(id, 'stdout', 0, 256, 1, signal, true);
  store.append(id, 'stdout', Buffer.from('开始\n' + '中文😀'.repeat(100) + '\n末尾'));
  const page = await waiting;
  assert(Buffer.byteLength(page.text) <= 256); assert(page.offset > 0); assert.equal(page.next_offset, page.available_bytes);
  assert(page.text.endsWith('\n末尾')); assert(!page.text.includes('?')); assert.equal(page.eof, false);
  store.append(id, 'stdout', Buffer.from('\n新内容'));
  const next = store.read(id, 'stdout', page.next_offset, 256);
  assert.equal(next.text, '\n新内容');
  store.finish(id); assert.equal(store.read(id, 'stdout', 0, 256, true).eof, true);
  const short = store.create(); store.append(short, 'stdout', Buffer.from('短输出'));
  assert.equal(store.read(short, 'stdout', 0, 256, true).offset, 0);
  const limited = store.create();
  store.append(limited, 'stderr', Buffer.alloc(SAVED_STREAM_BYTES, 97));
  store.append(limited, 'stderr', Buffer.from('未保存的远端尾部'));
  const tail = await store.readWait(limited, 'stderr', 0, 256, 30, signal, true);
  assert.equal(tail.text, 'a'.repeat(256)); assert.equal(tail.offset, SAVED_STREAM_BYTES - 256);
  assert.equal(tail.storage_truncated, true); assert.equal(tail.finished, false);
  store.clear();
});

test('输出等待在完整字符、完成、时限及取消时结束，清理后不保留等待', async () => {
  const store = new OutputStore(), id = store.create(), signal = new AbortController().signal;
  let settled = false;
  const pending = store.readWait(id, 'stdout', 0, 256, 1, signal).then(page => { settled = true; return page; });
  const character = Buffer.from('中');
  store.append(id, 'stderr', Buffer.from('其他流'));
  store.append(id, 'stdout', character.subarray(0, 2));
  await delay(10); assert.equal(settled, false);
  store.append(id, 'stdout', character.subarray(2));
  assert.equal((await pending).text, '中');
  const bounded = await store.readWait(id, 'stdout', 3, 256, 0.02, signal);
  assert.equal(bounded.text, ''); assert.equal(bounded.finished, false);
  const controller = new AbortController();
  const canceled = store.readWait(id, 'stdout', 3, 256, 1, controller.signal);
  controller.abort(); await assert.rejects(canceled, { code: 'ssh_canceled' });
  assert.equal(store.read(id, 'stdout', 3, 256).finished, false);
  const finished = store.readWait(id, 'stdout', 3, 256, 1, signal);
  store.finish(id); assert.equal((await finished).eof, true);
  const active = store.create(), cleared = store.readWait(active, 'stdout', 0, 256, 1, signal);
  store.clear(); await assert.rejects(cleared, { code: 'ssh_output_unknown' });
});

test('真实 MCP 降低返回预算并分页取得被省略的输出，失败仍可读取', async t => {
  const s = await startSSH(t, { session: execSession });
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
  await p.init();
  for (const command of ['stdin', 'fail']) {
    const stdin = '开始\n' + '中文😀\n'.repeat(300) + '结束\n';
    const response = await p.request('tools/call', { name: 'ssh_exec', arguments: { server_id: 'test', command, stdin, stdout_max_bytes: 256, stderr_max_bytes: 256, save_output: true } }).result;
    const result = response.structuredContent!;
    assert.equal(response.isError, command === 'fail'); assert.equal(typeof result.output_id, 'string');
    assert(Buffer.byteLength(String(result.stdout)) <= 256);
    let offset = 0, text = '', eof = false;
    while (!eof) {
      const page = (await p.request('tools/call', { name: 'ssh_output', arguments: { output_id: result.output_id, offset, max_bytes: 257 } }).result).structuredContent!;
      text += page.text; offset = Number(page.next_offset); eof = page.eof === true;
      assert.equal(page.storage_truncated, false);
    }
    assert.equal(text, command === 'stdin' ? stdin : 'remote ok\n');
    const tail = (await p.request('tools/call', { name: 'ssh_output', arguments: { output_id: result.output_id, tail: true, max_bytes: 256 } }).result).structuredContent!;
    assert.equal(tail.eof, true); assert.equal(tail.next_offset, tail.available_bytes);
    assert.equal(String(command === 'stdin' ? stdin : 'remote ok\n').endsWith(String(tail.text)), true);
    if (command === 'stdin') assert(Number(tail.offset) > 0);
    const mixed = await p.request('tools/call', { name: 'ssh_output', arguments: { output_id: result.output_id, tail: true, offset: 0 } }).result;
    assert.equal((mixed.structuredContent?.error as { code: string }).code, 'ssh_input_invalid');
  }
  const invalid = await p.request('tools/call', { name: 'ssh_exec', arguments: { server_id: 'test', command: 'ok', stdout_max_bytes: 100000 } }).result;
  assert.equal(invalid.isError, true);
  p.child.stdin.end(); await p.closed;
});
