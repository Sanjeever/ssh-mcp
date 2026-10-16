import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, symlinkSync, openSync, closeSync, ftruncateSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dial } from '../.build/test/ssh/client.js';
import { transfer, copyLimited, MAX_TRANSFER_BYTES } from '../.build/test/ssh/transfer.js';
import { operationSignal } from '../.build/test/errors.js';
import { startSSH } from './helpers/ssh-server.mjs';
import { sftpSession } from './helpers/sftp-session.mjs';
import { startCLI } from './helpers/stdio.mjs';

async function fixture(t, options = {}) {
  const s = await startSSH(t, { session: session => sftpSession(s.root, options)(session) });
  const run = async (direction, local, remote, overwrite = false, signal = new AbortController().signal, progress = { bytes_transferred: 0 }) => {
    const c = await dial(s.config, { knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' }, signal);
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
  for (const [direction, path, remote] of [['upload', s.root, '/payload'], ['upload', local, '/'], ['download', target, '/'], ['download', s.root, '/payload']]) await assert.rejects(s.run(direction, path, remote, true), { code: 'ssh_transfer_invalid' });
  for (const [path, remote] of [['relative', '/payload'], [local, 'relative'], [local, '~/file'], [local, '/bad\0path']]) await assert.rejects(s.run('upload', path, remote), { code: 'ssh_path_invalid' });
  try { symlinkSync(local, join(s.root, 'symlink')); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.diagnostic('当前 Windows 账号未获符号链接权限'); return; } throw error; }
  for (const direction of ['upload', 'download']) {
    await assert.rejects(s.run(direction, join(s.root, 'symlink'), '/payload', true), { code: 'ssh_transfer_invalid' });
    await assert.rejects(s.run(direction, direction === 'upload' ? local : target, '/symlink', true), { code: 'ssh_transfer_invalid' });
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
  for (const options of [{ failReadAt: 65536 }, { failClose: true }, { hangRead: true }]) {
    const s = await fixture(t, options), target = join(s.root, 'target');
    writeFileSync(join(s.root, 'payload'), Buffer.alloc(200000)); writeFileSync(target, '原内容');
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
    assert.equal(result.isError, false); assert.equal(result.structuredContent.bytes_transferred, Buffer.byteLength('MCP 文件'));
    const duplicate = await p.request('tools/call', { name, arguments: args }).result;
    assert.equal(duplicate.structuredContent.error.code, 'ssh_target_exists');
  }
  assert.equal(readFileSync(target, 'utf8'), 'MCP 文件');
  p.child.stdin.end(); assert.equal((await p.closed)[0], 0); assert.equal(p.diagnostics(), '');
});
test('SFTP 子系统等待取消与 stdio 下载取消和 EOF 清理', async t => {
  const controller = new AbortController();
  const waiting = await startSSH(t, { session: session => session.on('sftp', () => controller.abort()) });
  const op = operationSignal(controller.signal, 5);
  const c = await dial(waiting.config, { knownHosts: join(waiting.root, 'known_hosts'), hostKeyPolicy: 'accept_new' }, op.signal);
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
