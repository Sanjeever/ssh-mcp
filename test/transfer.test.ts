import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, symlinkSync, openSync, closeSync, ftruncateSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dial } from '../src/ssh/client.js';
import { transfer, copyLimited, MAX_TRANSFER_BYTES } from '../src/ssh/transfer.js';
import type { TransferResult } from '../src/ssh/transfer.js';
import { operationSignal } from '../src/errors.js';
import { startSSH } from './helpers/ssh-server.js';
import { sftpSession, type SFTPOptions } from './helpers/sftp-session.js';
import { startCLI, transferOutput, failureOutput } from './helpers/stdio.js';
import type { TestContext } from 'node:test';

async function fixture(t: TestContext, options: SFTPOptions = {}) {
  const s = await startSSH(t, { session: session => sftpSession(s.root, options)(session) });
  const run = async (direction: 'upload' | 'download', local: string, remote: string, overwrite = false, signal = new AbortController().signal, progress = { bytes_transferred: 0 }) => {
    const c = await dial(s.config, { servers: new Map(), knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' }, signal);
    try { await transfer(c, direction, local, remote, overwrite, progress); return progress.bytes_transferred; } finally { c.close(); }
  };
  return { ...s, run };
}
test('SFTP 往返、排他创建、显式覆盖和类型校验', async t => {
  const s = await fixture(t), local = join(s.root, 'source'), target = join(s.root, 'target');
  const data = Buffer.from('测试 payload\n'.repeat(10000)); writeFileSync(local, data);
  assert.equal(await s.run('upload', local, '/payload'), data.length);
  await assert.rejects(s.run('upload', local, '/payload'), { code: 'ssh_target_exists' });
  assert.equal(await s.run('upload', local, '/payload', true), data.length);
  assert.equal(await s.run('download', target, '/payload'), data.length); assert.deepEqual(readFileSync(target), data);
  await assert.rejects(s.run('download', target, '/payload'), { code: 'ssh_target_exists' });
  assert.equal(await s.run('download', target, '/payload', true), data.length);
  for (const [direction, path, remote] of [['upload', s.root, '/payload'], ['upload', local, '/'], ['download', target, '/'], ['download', s.root, '/payload']] as const) await assert.rejects(s.run(direction, path, remote, true), { code: 'ssh_transfer_invalid' });
  for (const [path, remote] of [['relative', '/payload'], [local, 'relative'], [local, '~/file'], [local, '/bad\0path']] as const) await assert.rejects(s.run('upload', path, remote), { code: 'ssh_path_invalid' });
  try { symlinkSync(local, join(s.root, 'symlink')); }
  catch (error) { if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') { t.diagnostic('当前 Windows 账号未获符号链接权限'); return; } throw error; }
  for (const direction of ['upload', 'download'] as const) {
    await assert.rejects(s.run(direction, join(s.root, 'symlink'), '/payload', true), { code: 'ssh_transfer_invalid' });
    await assert.rejects(s.run(direction, direction === 'upload' ? local : target, '/symlink', true), { code: 'ssh_transfer_invalid' });
  }
});
test('原子上传扩展、关闭、元数据和清理失败时保留旧目标', async t => {
  for (const options of [{}, { failClose: true }, { failSetstat: true }, { failUnlink: true }]) {
    const s = await fixture(t, options), source = join(s.root, 'source');
    writeFileSync(source, '新内容'); writeFileSync(join(s.root, 'payload'), '旧内容');
    const connection = await dial(s.config, { servers: new Map(), knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' }, new AbortController().signal);
    const result: TransferResult = { bytes_transferred: 0 };
    try { await assert.rejects(transfer(connection, 'upload', source, '/payload', true, result, undefined, { atomic: true }), error => error instanceof Error && 'code' in error && error.code === 'ssh_transfer_failed'); }
    finally { connection.close(); }
    assert.equal(result.publication_state, 'not_published'); assert.equal(result.cleanup_pending, !!options.failUnlink);
    assert.equal(readFileSync(join(s.root, 'payload'), 'utf8'), '旧内容');
    assert.equal(readdirSync(s.root).some(name => name.startsWith('.ssh-upload-')), !!options.failUnlink);
  }
});
test('并发禁止覆盖与发布前冲突保护', async t => {
  const s = await fixture(t), local = join(s.root, 'source'); writeFileSync(local, '并发内容');
  const upload = await Promise.allSettled([s.run('upload', local, '/payload'), s.run('upload', local, '/payload')]);
  assert.equal(upload.filter(r => r.status === 'fulfilled').length, 1); assert.equal(readFileSync(join(s.root, 'payload'), 'utf8'), '并发内容');
  const target = join(s.root, 'target');
  const download = await Promise.allSettled([s.run('download', target, '/payload'), s.run('download', target, '/payload')]);
  assert.equal(download.filter(r => r.status === 'fulfilled').length, 1); assert.equal(readFileSync(target, 'utf8'), '并发内容');
  assert(!readdirSync(s.root).some(name => name.startsWith('.ssh-download-')));
  const race = await fixture(t, { onClose: () => writeFileSync(join(race.root, 'target'), '竞争目标') });
  writeFileSync(join(race.root, 'payload'), '新内容');
  await assert.rejects(race.run('download', join(race.root, 'target'), '/payload'), { code: 'ssh_target_exists' });
  assert.equal(readFileSync(join(race.root, 'target'), 'utf8'), '竞争目标');
});
test('传输失败、关闭失败与取消清理临时文件并保留原目标', async t => {
  for (const options of [{ failReadAt: 4 * 65536 }, { failClose: true }, { hangRead: true }]) {
    const s = await fixture(t, options), target = join(s.root, 'target');
    writeFileSync(join(s.root, 'payload'), Buffer.alloc(800000)); writeFileSync(target, '原内容');
    const op = operationSignal(new AbortController().signal, options.hangRead ? 3 : 10), progress = { bytes_transferred: 0 };
    try { await assert.rejects(s.run('download', target, '/payload', true, op.signal, progress), { code: options.hangRead ? 'ssh_timeout' : 'ssh_transfer_failed' }); } finally { op.dispose(); }
    assert.equal(readFileSync(target, 'utf8'), '原内容'); assert(!readdirSync(s.root).some(name => name.startsWith('.ssh-download-')));
    if (options.failReadAt) assert(progress.bytes_transferred > 0);
  }
  const controller = new AbortController();
  const s = await fixture(t, { hangWrite: true, onWrite: () => controller.abort() }), local = join(s.root, 'source'); writeFileSync(local, 'payload');
  await assert.rejects(s.run('upload', local, '/payload', false, controller.signal), { code: 'ssh_canceled' });
  assert(readdirSync(s.root).includes('payload'));
});
test('并发短读和乱序响应保持内容，写入失败停止在途请求', async t => {
  const s = await fixture(t, { shortReadBytes: 8192, readDelayMs: offset => offset < 65536 ? 4 : 1 });
  const data = Buffer.from('乱序传输\n'.repeat(50000)); writeFileSync(join(s.root, 'payload'), data);
  const target = join(s.root, 'target');
  assert.equal(await s.run('download', target, '/payload'), data.length); assert.deepEqual(readFileSync(target), data);
  const failed = await fixture(t, { failWriteAt: 65536, delayMs: 30 }), source = join(failed.root, 'source'); writeFileSync(source, data);
  await assert.rejects(failed.run('upload', source, '/payload'), { code: 'ssh_transfer_failed' });
  for (let i = 0; failed.clients.size && i < 100; i++) await delay(10);
  assert.equal(failed.clients.size, 0);
});
test('MCP 传输进度遵循 token、递增并在结果前结束', async t => {
  const s = await fixture(t, { delayMs: 10 }), source = join(s.root, 'source'); writeFileSync(source, Buffer.alloc(800000));
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
  await p.init();
  const call = { name: 'ssh_upload', arguments: { server_id: 'test', local_path: source, remote_path: '/progress' }, _meta: { progressToken: 'transfer-1' } };
  assert.equal((await p.request('tools/call', call).result).isError, false);
  const updates = p.notifications().filter(n => n.method === 'notifications/progress');
  assert(updates.length >= 2);
  assert(updates.every(n => n.params?.progressToken === 'transfer-1'));
  assert.equal(updates.at(-1)?.params?.progress, 800000);
  for (let i = 1; i < updates.length; i++) assert(Number(updates[i]!.params?.progress) > Number(updates[i - 1]!.params?.progress));
  await delay(30); assert.equal(p.notifications().length, updates.length);
  assert.equal((await p.request('tools/call', { name: 'ssh_download', arguments: { server_id: 'test', local_path: join(s.root, 'download'), remote_path: '/progress' } }).result).isError, false);
  assert.equal(p.notifications().length, updates.length);
  p.child.stdin.end(); await p.closed;
});
test('大小预检及实际读取上限覆盖源增长', { timeout: 60000 }, async t => {
  const s = await fixture(t), source = join(s.root, 'source');
  const fd = openSync(source, 'w'); ftruncateSync(fd, MAX_TRANSFER_BYTES + 1); closeSync(fd);
  await assert.rejects(s.run('upload', source, '/payload'), { code: 'ssh_transfer_invalid' });
  await assert.rejects(s.run('download', join(s.root, 'target'), '/source'), { code: 'ssh_transfer_invalid' });
  const progress = { bytes_transferred: 0 }, contents = Buffer.from('123456'); let written = '';
  await assert.rejects(copyLimited(async (buffer, pos) => { const chunk = contents.subarray(pos, pos + buffer.length); chunk.copy(buffer); return chunk.length; }, async buffer => { written += buffer; }, progress, new AbortController().signal, 5), { code: 'ssh_transfer_limit' });
  assert.equal(progress.bytes_transferred, 5); assert.equal(written, '12345');
  // 初始 fstat 为小文件，首次 READ 时实际增长到超过生产上限。
  let grown = false;
  const growing = await fixture(t, { onRead() { if (!grown) { grown = true; const file = openSync(join(growing.root, 'source'), 'r+'); ftruncateSync(file, MAX_TRANSFER_BYTES + 1); closeSync(file); } } });
  writeFileSync(join(growing.root, 'source'), 'x'); writeFileSync(join(growing.root, 'target'), '原内容');
  const actual = { bytes_transferred: 0 };
  await assert.rejects(growing.run('download', join(growing.root, 'target'), '/source', true, new AbortController().signal, actual), { code: 'ssh_transfer_limit' });
  assert.equal(actual.bytes_transferred, MAX_TRANSFER_BYTES); assert.equal(readFileSync(join(growing.root, 'target'), 'utf8'), '原内容');
  let uploadGrown = false;
  const upload = await fixture(t, { onWrite() { if (!uploadGrown) { uploadGrown = true; const file = openSync(join(upload.root, 'source'), 'r+'); ftruncateSync(file, MAX_TRANSFER_BYTES + 1); closeSync(file); } } });
  writeFileSync(join(upload.root, 'source'), 'x');
  const uploaded = { bytes_transferred: 0 };
  await assert.rejects(upload.run('upload', join(upload.root, 'source'), '/payload', false, new AbortController().signal, uploaded), { code: 'ssh_transfer_limit' });
  assert.equal(uploaded.bytes_transferred, MAX_TRANSFER_BYTES);
});
test('真实 stdio 四工具发现与 SFTP 调用', async t => {
  const s = await fixture(t), source = join(s.root, 'source'), target = join(s.root, 'target'); writeFileSync(source, 'MCP 文件');
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
  await p.init(); assert.equal((await p.request('tools/list').result).tools.length, 4);
  for (const name of ['ssh_upload', 'ssh_download']) {
    const args = { server_id: 'test', local_path: name === 'ssh_upload' ? source : target, remote_path: '/payload' };
    const result = await p.request('tools/call', { name, arguments: args }).result;
    assert.equal(result.isError, false); assert.equal(transferOutput.parse(result.structuredContent).bytes_transferred, Buffer.byteLength('MCP 文件'));
    const duplicate = await p.request('tools/call', { name, arguments: args }).result;
    assert.equal(failureOutput.parse(duplicate.structuredContent).error.code, 'ssh_target_exists');
  }
  assert.equal(readFileSync(target, 'utf8'), 'MCP 文件');
  p.child.stdin.end(); assert.equal((await p.closed)[0], 0); assert.equal(p.diagnostics(), '');
});
test('SFTP 子系统等待取消与 stdio 下载取消和 EOF 清理', async t => {
  const controller = new AbortController();
  const waiting = await startSSH(t, { session: session => session.on('sftp', () => controller.abort()) });
  const op = operationSignal(controller.signal, 5);
  const c = await dial(waiting.config, { servers: new Map(), knownHosts: join(waiting.root, 'known_hosts'), hostKeyPolicy: 'accept_new' }, op.signal);
  try { await assert.rejects(transfer(c, 'download', join(waiting.root, 'target'), '/payload', false, { bytes_transferred: 0 }), { code: 'ssh_canceled' }); } finally { c.close(); op.dispose(); }
  for (const mode of ['cancel', 'eof']) {
    const s = await fixture(t, { hangRead: true }), target = join(s.root, 'target');
    writeFileSync(join(s.root, 'payload'), 'payload'); writeFileSync(target, '原内容');
    const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
    await p.init();
    const request = p.request('tools/call', { name: 'ssh_download', arguments: { server_id: 'test', local_path: target, remote_path: '/payload', overwrite: true } }); request.result.catch(() => {});
    for (let i = 0; !readdirSync(s.root).some(name => name.startsWith('.ssh-download-')) && i < 100; i++) await delay(10);
    assert(readdirSync(s.root).some(name => name.startsWith('.ssh-download-')));
    if (mode === 'cancel') p.send({ method: 'notifications/cancelled', params: { requestId: request.id } }); else p.child.stdin.end();
    for (let i = 0; readdirSync(s.root).some(name => name.startsWith('.ssh-download-')) && i < 100; i++) await delay(10);
    assert(!readdirSync(s.root).some(name => name.startsWith('.ssh-download-'))); assert.equal(readFileSync(target, 'utf8'), '原内容');
    if (mode === 'cancel') p.child.stdin.end(); assert.equal((await p.closed)[0], 0); assert.equal(p.diagnostics(), '');
  }
});
