import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, statSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { startOpenSSH, startOpenSSHAgent } from './helpers/openssh-server.js';
import { dial } from '../src/ssh/client.js';
import { transfer } from '../src/ssh/transfer.js';
import type { TransferResult } from '../src/ssh/transfer.js';
import { exec, createExecResult } from '../src/ssh/exec.js';

test('独立 OpenSSH：主机信任、stdin、退出状态和原子上传', { skip: process.env.SSH_MCP_TEST_OPENSSH !== '1' }, async t => {
  const s = await startOpenSSH(t);
  const config = { servers: new Map([[s.config.id, s.config]]), knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' as const };
  const connect = () => dial(s.config, config, new AbortController().signal);
  const endpoint = await startOpenSSHAgent(t, s.root, s.config.privateKeyPath!);
  const agentConnection = await dial({ ...s.config, privateKeyPath: undefined, agentSocket: endpoint }, config, new AbortController().signal);
  agentConnection.close();
  const c = await connect(), output = createExecResult();
  try { await exec(c, 'cat', output, undefined, { stdin: '独立服务端\n' }); } finally { c.close(); }
  assert.equal(output.stdout, '独立服务端\n'); assert.equal(output.exit_code, 0);
  writeFileSync(join(s.root, 'unknown'), '');
  await assert.rejects(dial(s.config, { ...config, knownHosts: join(s.root, 'unknown'), hostKeyPolicy: 'strict' }, new AbortController().signal), { code: 'ssh_host_unknown' });
  await assert.rejects(dial({ ...s.config, privateKeyPath: join(s.root, 'host') }, config, new AbortController().signal), { code: 'ssh_auth_failed' });
  for (const command of ['exit 7', 'kill -TERM $$']) {
    const connection = await connect(), result = createExecResult();
    try { await assert.rejects(exec(connection, command, result), { code: command === 'exit 7' ? 'ssh_exit_nonzero' : 'ssh_exit_signal' }); }
    finally { connection.close(); }
    assert.equal(command === 'exit 7' ? result.exit_code : result.exit_signal, command === 'exit 7' ? 7 : 'SIGTERM');
  }
  const source = join(s.root, 'source'), target = join(s.root, 'target'); writeFileSync(source, '新配置'); writeFileSync(target, '旧配置'); chmodSync(target, 0o640);
  const upload = async (overwrite: boolean) => {
    const connection = await connect(), result: TransferResult = { bytes_transferred: 0 };
    try { await transfer(connection, 'upload', source, target, overwrite, result, undefined, { atomic: true }); return result; }
    finally { connection.close(); }
  };
  const result = await upload(true);
  assert.equal(result.publication_state, 'published'); assert.equal(result.cleanup_pending, false);
  assert.equal(readFileSync(target, 'utf8'), '新配置'); assert.equal(statSync(target).mode & 0o777, 0o640);
  await assert.rejects(upload(false), { code: 'ssh_target_exists' });
  const fresh = join(s.root, 'fresh');
  const outcomes = await Promise.allSettled([1, 2].map(async () => {
    const connection = await connect();
    try { await transfer(connection, 'upload', source, fresh, false, { bytes_transferred: 0 }, undefined, { atomic: true }); }
    finally { connection.close(); }
  }));
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(readFileSync(fresh, 'utf8'), '新配置'); assert.equal(statSync(fresh).mode & 0o777, 0o600);
  assert(!readdirSync(s.root).some(name => name.startsWith('.ssh-upload-')));
  const cleanupConnection = await connect(), cleanup: TransferResult = { bytes_transferred: 0 };
  const cleanupSftp = cleanupConnection.client.sftp.bind(cleanupConnection.client);
  cleanupConnection.client.sftp = callback => cleanupSftp((error, files) => {
    if (error) return callback(error, files);
    files.unlink = (_path, done) => done(Object.assign(new Error('模拟权限失败'), { code: 3 }));
    callback(undefined, files);
  });
  try { await assert.rejects(transfer(cleanupConnection, 'upload', source, join(s.root, 'cleanup'), false, cleanup, undefined, { atomic: true }), error => error instanceof Error && 'details' in error && (error.details as { operation_state?: string }).operation_state === 'completed'); }
  finally { cleanupConnection.close(); }
  assert.equal(cleanup.publication_state, 'published'); assert.equal(cleanup.cleanup_pending, true);
  assert.equal(readFileSync(join(s.root, 'cleanup'), 'utf8'), '新配置');
  // 在真实发布请求之后切断连接，客户端必须保留结果不确定状态。
  const interrupted = await connect(), uncertain: TransferResult = { bytes_transferred: 0 };
  const originalSftp = interrupted.client.sftp.bind(interrupted.client);
  interrupted.client.sftp = callback => originalSftp((error, files) => {
    if (error) return callback(error, files);
    const rename = files.ext_openssh_rename.bind(files);
    files.ext_openssh_rename = (from, to, done) => { rename(from, to, done); interrupted.close(); };
    callback(undefined, files);
  });
  try { await assert.rejects(transfer(interrupted, 'upload', source, target, true, uncertain, undefined, { atomic: true })); }
  finally { interrupted.close(); }
  assert.equal(uncertain.publication_state, 'unknown'); assert.equal(uncertain.cleanup_pending, true); assert(uncertain.temporary_path);
});
