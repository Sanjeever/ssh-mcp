import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { startSSH } from './helpers/ssh-server.js';
import { startAgent } from './helpers/agent.js';
import { startCLI } from './helpers/stdio.js';
import { execSession } from './helpers/exec-session.js';
import { sftpSession } from './helpers/sftp-session.js';
import { dial } from '../src/ssh/client.js';
import { exec, createExecResult } from '../src/ssh/exec.js';
import { transfer } from '../src/ssh/transfer.js';
import { operationSignal, SSHError } from '../src/errors.js';
import { hostToken } from '../src/ssh/known-hosts.js';
import type { Config } from '../src/config.js';

test('单跳分别验证密钥，密码跳板和 Agent 目标支持执行及 SFTP', async t => {
  const target = await startSSH(t, { session: session => { execSession(session); sftpSession(target.root)(session); } });
  const jump = await startSSH(t, { forward: true }), agent = await startAgent(t, target.root, target.privateKey);
  const gateway = { ...jump.config, id: 'jump' }, server = { ...target.config, id: 'target', password: undefined, agentSocket: agent.endpoint, jumpServerId: 'jump' };
  const config: Config = { servers: new Map([[gateway.id, gateway], [server.id, server]]), knownHosts: join(jump.root, 'known_hosts'), hostKeyPolicy: 'accept_new' };
  const connection = await dial(server, config, new AbortController().signal), result = createExecResult();
  try { await exec(connection, 'ok', result); } finally { connection.close(); }
  assert.equal(result.exit_code, 0); assert(agent.signatures() > 0);
  const known = readFileSync(config.knownHosts, 'utf8');
  for (const entry of [gateway, server]) assert(known.includes(hostToken(entry.host, entry.port)));
  const source = join(target.root, 'source'); writeFileSync(source, '跳板上传');
  const sftp = await dial(server, config, new AbortController().signal);
  try { await transfer(sftp, 'upload', source, '/payload', false, { bytes_transferred: 0 }); } finally { sftp.close(); }
  assert.equal(readFileSync(join(target.root, 'payload'), 'utf8'), '跳板上传');
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: server.host, SSH_MCP_SERVER_TEST_PORT: String(server.port), SSH_MCP_SERVER_TEST_JUMP_SERVER_ID: 'jump', SSH_MCP_SERVER_JUMP_HOST: gateway.host, SSH_MCP_SERVER_JUMP_PORT: String(gateway.port), SSH_MCP_SERVER_JUMP_USERNAME: gateway.username, SSH_MCP_SERVER_JUMP_PASSWORD: gateway.password, SSH_MCP_KNOWN_HOSTS: config.knownHosts });
  await p.init();
  assert.match(JSON.stringify((await p.request('tools/call', { name: 'ssh_list', arguments: {} }).result).structuredContent), /"jump_server_id":"jump"/);
  assert.equal((await p.request('tools/call', { name: 'ssh_exec', arguments: { server_id: 'test', command: 'ok' } }).result).isError, false);
  p.child.stdin.end(); await p.closed;
  for (let i = 0; (jump.clients.size || target.clients.size) && i < 100; i++) await delay(5);
  assert.equal(jump.clients.size + target.clients.size, 0);
});
test('转发和目标认证分别受每跳 15 秒上限约束', { timeout: 23000 }, async t => {
  await Promise.all(['forward', 'authentication'].map(async phase => {
    const target = await startSSH(t, { hangAuth: phase === 'authentication' });
    const jump = await startSSH(t, { forward: phase === 'forward' ? 'hang' : true });
    const gateway = { ...jump.config, id: 'jump' }, server = { ...target.config, id: 'target', jumpServerId: 'jump' };
    const config: Config = { servers: new Map([[gateway.id, gateway], [server.id, server]]), knownHosts: join(jump.root, 'known_hosts'), hostKeyPolicy: 'accept_new' };
    const op = operationSignal(new AbortController().signal, 20);
    try { await assert.rejects(dial(server, config, op.signal, op.deadline), error => error instanceof SSHError && error.code === 'ssh_handshake_timeout' && error.details.phase === phase); }
    finally { op.dispose(); }
    for (let i = 0; (jump.clients.size || target.clients.size) && i < 100; i++) await delay(5);
    assert.equal(jump.clients.size + target.clients.size, 0);
  }));
});
test('跳板和目标分别拒绝认证及主机密钥，转发拒绝指出跳板', async t => {
  for (const failure of ['jump_auth', 'target_auth', 'jump_trust', 'target_trust', 'forward']) {
    const target = await startSSH(t), jump = await startSSH(t, { forward: failure !== 'forward' });
    const gateway = { ...jump.config, id: 'jump', password: failure === 'jump_auth' ? 'wrong' : jump.config.password };
    const server = { ...target.config, id: 'target', jumpServerId: 'jump', password: failure === 'target_auth' ? 'wrong' : target.config.password };
    const config: Config = { servers: new Map([[gateway.id, gateway], [server.id, server]]), knownHosts: join(jump.root, 'known_hosts'), hostKeyPolicy: 'accept_new' };
    if (failure.endsWith('trust')) {
      const lines = [[gateway, failure === 'jump_trust' ? target.publicKey : jump.publicKey], [server, failure === 'target_trust' ? jump.publicKey : target.publicKey]] as const;
      writeFileSync(config.knownHosts, lines.map(([entry, key]) => `${hostToken(entry.host, entry.port)} ssh-rsa ${key.toString('base64')}`).join('\n') + '\n');
    }
    await assert.rejects(dial(server, config, new AbortController().signal), error => error instanceof SSHError && error.code === (failure.endsWith('trust') ? 'ssh_host_key_rejected' : failure === 'forward' ? 'ssh_forward_failed' : 'ssh_auth_failed') && error.details.hop_server_id === (failure.startsWith('target') ? 'target' : 'jump'));
    if (failure === 'jump_trust') assert.equal(jump.authCount(), 0);
    if (failure === 'target_trust') assert.equal(target.authCount(), 0);
    for (let i = 0; (jump.clients.size || target.clients.size) && i < 100; i++) await delay(5);
    assert.equal(jump.clients.size + target.clients.size, 0);
  }
});
test('转发等待与目标认证的取消和总超时清理整条连接链', async t => {
  for (const phase of ['forward', 'authentication']) for (const mode of ['cancel', 'timeout']) {
    const target = await startSSH(t, { hangAuth: phase === 'authentication' });
    let forwarded = false;
    const jump = await startSSH(t, { forward: phase === 'forward' ? 'hang' : true, onForward: () => { forwarded = true; } });
    const gateway = { ...jump.config, id: 'jump' }, server = { ...target.config, id: 'target', jumpServerId: 'jump' };
    const config: Config = { servers: new Map([[gateway.id, gateway], [server.id, server]]), knownHosts: join(jump.root, 'known_hosts'), hostKeyPolicy: 'accept_new' };
    const controller = new AbortController(), op = operationSignal(controller.signal, mode === 'timeout' ? .2 : 5);
    const pending = dial(server, config, op.signal, op.deadline);
    if (mode === 'cancel') {
      for (let i = 0; !(phase === 'forward' ? forwarded : target.authCount()) && i < 100; i++) await delay(5);
      assert(phase === 'forward' ? forwarded : target.authCount()); controller.abort();
    }
    try { await assert.rejects(pending, { code: mode === 'cancel' ? 'ssh_canceled' : 'ssh_timeout' }); } finally { op.dispose(); }
    for (let i = 0; (jump.clients.size || target.clients.size) && i < 100; i++) await delay(5);
    assert.equal(jump.clients.size + target.clients.size, 0);
  }
});
