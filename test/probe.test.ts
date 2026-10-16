import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { failureReason } from '../src/errors.js';
import { startSSH } from './helpers/ssh-server.js';
import { sftpSession } from './helpers/sftp-session.js';
import { startCLI } from './helpers/stdio.js';

test('诊断映射底层网络原因，不回显错误内容', () => {
  for (const [code, reason] of Object.entries({ ENOTFOUND: 'dns_failed', EAI_AGAIN: 'dns_failed', ECONNREFUSED: 'connection_refused', ENETUNREACH: 'network_unreachable', EHOSTUNREACH: 'network_unreachable', ETIMEDOUT: 'connection_timeout', ECONNRESET: 'connection_reset' })) assert.equal(failureReason({ code, message: 'secret' }), reason);
});

test('显式探测认证、指纹与 SFTP 扩展，不执行命令、不创建远端文件', async t => {
  let executions = 0, opens = 0;
  const s = await startSSH(t, { session: session => { session.on('exec', (_accept, reject) => { executions++; reject(); }); sftpSession(s.root, { onOpen: () => opens++ })(session); } });
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
  await p.init();
  await p.request('tools/call', { name: 'ssh_list', arguments: {} }).result; assert.equal(s.authCount(), 0);
  const result = await p.request('tools/call', { name: 'ssh_probe', arguments: { server_id: 'test' } }).result;
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.host_key_fingerprint, 'SHA256:' + createHash('sha256').update(s.publicKey).digest('base64').replace(/=+$/, ''));
  assert.deepEqual(result.structuredContent?.sftp, { available: true, atomic_overwrite: false, atomic_no_overwrite: false });
  assert.equal(executions, 0); assert.equal(opens, 0);
  p.child.stdin.end(); await p.closed;
});

test('SFTP 缺失作为探测能力返回，连接拒绝保留网络原因', async t => {
  const s = await startSSH(t, { session: session => session.on('sftp', (_accept, reject) => reject()) });
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
  await p.init();
  const result = await p.request('tools/call', { name: 'ssh_probe', arguments: { server_id: 'test' } }).result;
  assert.equal(result.isError, false); assert.equal(result.structuredContent?.ssh, true);
  assert.deepEqual(result.structuredContent?.sftp, { available: false, reason: 'subsystem_unavailable' });
  p.child.stdin.end(); await p.closed;
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address(); assert(address && typeof address !== 'string');
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const refused = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: '127.0.0.1', SSH_MCP_SERVER_TEST_PORT: String(address.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
  await refused.init();
  const failed = await refused.request('tools/call', { name: 'ssh_probe', arguments: { server_id: 'test' } }).result;
  assert.equal(failed.isError, true); assert.equal((failed.structuredContent?.error as { reason: string }).reason, 'connection_refused');
  refused.child.stdin.end(); await refused.closed;
});
