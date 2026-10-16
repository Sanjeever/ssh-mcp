import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { writeFileSync, readFileSync, statSync, lstatSync, symlinkSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { dial } from '../src/ssh/client.js';
import { verifyHost, checkTrust, hostToken } from '../src/ssh/known-hosts.js';
import { operationSignal } from '../src/errors.js';
import { startSSH } from './helpers/ssh-server.js';
import type { Config } from '../src/config.js';
import { SSHError } from '../src/errors.js';

const cfg = (s: { root: string }, policy: Config['hostKeyPolicy'] = 'accept_new'): Config => ({ servers: new Map(), knownHosts: join(s.root, '.ssh', 'known_hosts'), hostKeyPolicy: policy });
const line = (host: string, key: Buffer) => `${host} ssh-rsa ${key.toString('base64')}`;
const code = (expected: string) => (error: unknown) => error instanceof SSHError && error.code === expected;

test('密码、普通私钥、加密私钥与认证拒绝', async t => {
  const s = await startSSH(t);
  for (const kind of ['password', 'key', 'encrypted']) {
    const server = { ...s.config };
    if (kind !== 'password') {
      server.privateKeyPath = join(s.root, kind); delete server.password;
      writeFileSync(server.privateKeyPath, kind === 'key' ? s.privateKey : s.encryptedKey);
      if (kind === 'encrypted') server.passphrase = ' pass ';
    }
    const c = await dial(server, cfg(s), new AbortController().signal); c.close();
  }
  await assert.rejects(dial({ ...s.config, password: 'wrong' }, cfg(s, 'strict'), new AbortController().signal), code('ssh_auth_failed'));
  const keyPath = join(s.root, 'encrypted');
  await assert.rejects(dial({ ...s.config, privateKeyPath: keyPath, passphrase: 'wrong' }, cfg(s), new AbortController().signal), code('ssh_credentials_invalid'));
  const publicPath = join(s.root, 'public'); writeFileSync(publicPath, line('host', s.publicKey).slice(5));
  await assert.rejects(dial({ ...s.config, privateKeyPath: publicPath }, cfg(s), new AbortController().signal), code('ssh_credentials_invalid'));
  assert(s.authCount() >= 4);
});

test('主机规则、哈希、IPv6、端口、否定、撤销及 CA 拒绝', async t => {
  const s = await startSSH(t), other = await startSSH(t);
  const key = s.publicKey, salt = Buffer.alloc(20, 7);
  for (const [host, port] of [['example.com', 22], ['::1', 22], ['::1', 2222], ['example.com', 2222]] as const) {
    const token = hostToken(host, port);
    const hash = `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(token).digest('base64')}`;
    for (const pattern of [token, hash]) {
      assert.equal(checkTrust(line(pattern, key), host, port, key), 'known');
      assert.throws(() => checkTrust(line(pattern, key), host, port, other.publicKey), code('ssh_host_key_rejected'));
    }
  }
  assert.equal(checkTrust(line('one,*.example.com,!bad.example.com', key), 'ok.example.com', 22, key), 'known');
  assert.equal(checkTrust(line('one,*.example.com,!bad.example.com', key), 'bad.example.com', 22, key), 'unknown');
  assert.equal(checkTrust(line('s?rver', key), 'server', 22, key), 'known');
  assert.equal(checkTrust(line('server:2222', key), 'server', 2222, key), 'known');
  assert.equal(checkTrust(line('*.example.com', key), 'ok.example.com', 2222, key), 'unknown');
  assert.throws(() => checkTrust('@revoked ' + line('unrelated', key), 'example.com', 22, key), code('ssh_host_key_rejected'));
  assert.throws(() => checkTrust('@cert-authority ' + line('*', key), 'example.com', 22, key), code('ssh_host_key_rejected'));
  for (const content of ['损坏内容', '@unknown ' + line('*', key), line('|2|bad|bad', key), 'host ssh-rsa garbage', 'host ssh-ed25519 ' + key.toString('base64')]) assert.throws(() => checkTrust(content, 'host', 22, key), code('ssh_known_hosts_invalid'));
});

test('首次追加、并发冲突、换行、权限、符号链接与写入失败', async t => {
  const s = await startSSH(t), other = await startSSH(t), path = cfg(s).knownHosts;
  assert.throws(() => verifyHost(path, 'strict', 'host', 22, s.publicKey), code('ssh_known_hosts_invalid'));
  await Promise.all(Array.from({ length: 8 }, async () => verifyHost(path, 'accept_new', 'host', 22, s.publicKey)));
  assert.equal(readFileSync(path, 'utf8').split('\n').length, 2);
  assert.throws(() => verifyHost(path, 'accept_new', 'host', 22, other.publicKey), code('ssh_host_key_rejected'));
  assert.throws(() => verifyHost(path, 'strict', 'unknown', 22, s.publicKey), code('ssh_host_unknown'));
  if (process.platform !== 'win32') { assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(join(s.root, '.ssh')).mode & 0o777, 0o700); }
  writeFileSync(path, '# 保留注释'); chmodSync(path, 0o640);
  verifyHost(path, 'accept_new', 'host', 22, s.publicKey);
  assert(readFileSync(path, 'utf8').startsWith('# 保留注释\n'));
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o640);
  const link = join(s.root, 'link');
  try { symlinkSync(path, link); }
  catch (error) { if (process.platform !== 'win32' || !(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error; t.diagnostic('当前 Windows 账号未获符号链接权限'); return; }
  verifyHost(link, 'accept_new', 'new', 22, s.publicKey);
  assert(lstatSync(link).isSymbolicLink());
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    chmodSync(path, 0o400);
    assert.throws(() => verifyHost(link, 'accept_new', 'unknown', 22, s.publicKey), code('ssh_known_hosts_write'));
    chmodSync(path, 0o600);
  }
  const broken = join(s.root, 'broken'); symlinkSync(join(s.root, 'missing'), broken);
  assert.throws(() => verifyHost(broken, 'accept_new', 'host', 22, s.publicKey), code('ssh_known_hosts_invalid'));
  const directory = join(s.root, 'directory'); mkdirSync(directory);
  assert.throws(() => verifyHost(directory, 'accept_new', 'host', 22, s.publicKey), code('ssh_known_hosts_invalid'));
});

test('握手取消、总超时与 15 秒上限分别分类且关闭 socket', { timeout: 23000 }, async t => {
  const sockets = new Set<Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.on('data', () => {}); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const s = await startSSH(t);
  const address = server.address(); assert(address && typeof address !== 'string');
  const target = { ...s.config, port: address.port };
  for (const [seconds, expected] of [[.05, 'ssh_timeout'], [1, 'ssh_timeout'], [20, 'ssh_handshake_timeout']] as const) {
    const op = operationSignal(new AbortController().signal, seconds);
    try { await assert.rejects(dial(target, cfg(s), op.signal, op.deadline), code(expected)); } finally { op.dispose(); }
  }
  const controller = new AbortController(); setTimeout(() => controller.abort(), 30);
  await assert.rejects(dial(target, cfg(s), controller.signal), code('ssh_canceled'));
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(sockets.size, 0);
});
test('TCP 拒绝与认证等待取消保留错误分类', async t => {
  const s = await startSSH(t, { hangAuth: true });
  const controller = new AbortController(), promise = dial(s.config, cfg(s), controller.signal);
  for (let i = 0; !s.authCount() && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert(s.authCount() > 0); controller.abort(); await assert.rejects(promise, code('ssh_canceled'));
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const port = address.port; server.close(); await once(server, 'close');
  await assert.rejects(dial({ ...s.config, port }, cfg(s), new AbortController().signal), code('ssh_connect_failed'));
});
