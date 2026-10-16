import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startSSH } from './helpers/ssh-server.js';
import { startAgent } from './helpers/agent.js';
import { startCLI } from './helpers/stdio.js';
import { execSession } from './helpers/exec-session.js';
import { dial } from '../src/ssh/client.js';
import { operationSignal, SSHError } from '../src/errors.js';

test('Agent Unix socket / Windows named pipe 认证及单文件入口', async t => {
  const s = await startSSH(t, { session: execSession }), agent = await startAgent(t, s.root, s.privateKey);
  const server = { ...s.config, password: undefined, agentSocket: agent.endpoint };
  const config = { servers: new Map(), knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' as const };
  const connection = await dial(server, config, new AbortController().signal); connection.close();
  assert(agent.signatures() > 0);
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_SERVER_TEST_PASSWORD: undefined, SSH_MCP_SERVER_TEST_AGENT_SOCKET: agent.endpoint, SSH_MCP_KNOWN_HOSTS: config.knownHosts });
  await p.init();
  const list = await p.request('tools/call', { name: 'ssh_list', arguments: {} }).result;
  assert.match(JSON.stringify(list.structuredContent), /"auth_type":"agent"/); assert(!JSON.stringify(list).includes(agent.endpoint));
  assert.equal((await p.request('tools/call', { name: 'ssh_exec', arguments: { server_id: 'test', command: 'ok' } }).result).isError, false);
  p.child.stdin.end(); await p.closed;
  for (let i = 0; agent.sockets.size && i < 100; i++) await delay(5);
  assert.equal(agent.sockets.size, 0);
});
test('Agent 缺失、空密钥与请求挂起的取消和超时', async t => {
  for (const kind of ['missing', 'empty', 'cancel', 'timeout'] as const) {
    const s = await startSSH(t), agent = await startAgent(t, s.root, s.privateKey, { empty: kind === 'empty', hang: kind === 'cancel' || kind === 'timeout' });
    const controller = new AbortController(), op = operationSignal(controller.signal, kind === 'timeout' ? .1 : 5);
    const endpoint = kind === 'missing' ? agent.endpoint + '-missing' : agent.endpoint;
    const promise = dial({ ...s.config, password: undefined, agentSocket: endpoint }, { servers: new Map(), knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' }, op.signal, op.deadline);
    if (kind === 'cancel') {
      for (let i = 0; !agent.queries() && i < 100; i++) await delay(5);
      assert(agent.queries() > 0); controller.abort();
    }
    try { await assert.rejects(promise, error => error instanceof SSHError && error.code === (kind === 'cancel' ? 'ssh_canceled' : kind === 'timeout' ? 'ssh_timeout' : 'ssh_auth_failed')); }
    finally { op.dispose(); }
    for (let i = 0; agent.sockets.size && i < 100; i++) await delay(5);
    assert.equal(agent.sockets.size, 0);
  }
});
