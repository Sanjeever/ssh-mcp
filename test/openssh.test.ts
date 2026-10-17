import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, statSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { startOpenSSH, startOpenSSHAgent } from './helpers/openssh-server.js';
import { dial } from '../src/ssh/client.js';
import { transfer } from '../src/ssh/transfer.js';
import type { TransferResult } from '../src/ssh/transfer.js';
import { exec, createExecResult } from '../src/ssh/exec.js';
import { startCLI } from './helpers/stdio.js';
import { probe } from '../src/ssh/probe.js';

test('独立 OpenSSH：主机信任、stdin、退出状态和原子上传', { skip: process.env.SSH_MCP_TEST_OPENSSH !== '1' }, async t => {
  const s = await startOpenSSH(t);
  const config = { servers: new Map([[s.config.id, s.config]]), knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' as const };
  const connect = () => dial(s.config, config, new AbortController().signal);
  const probing = await connect();
  try { assert.deepEqual((await probe(probing)).sftp, { available: true, atomic_overwrite: true, atomic_no_overwrite: true }); }
  finally { probing.close(); }
  const endpoint = await startOpenSSHAgent(t, s.root, s.config.privateKeyPath!);
  const agentConnection = await dial({ ...s.config, privateKeyPath: undefined, agentSocket: endpoint }, config, new AbortController().signal).catch(error => { t.diagnostic(s.diagnostics()); throw error; });
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
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_SERVER_TEST_USERNAME: s.config.username, SSH_MCP_SERVER_TEST_PASSWORD: undefined, SSH_MCP_SERVER_TEST_PRIVATE_KEY_PATH: s.config.privateKeyPath, SSH_MCP_KNOWN_HOSTS: config.knownHosts });
  await p.init();
  const mcpUpload = await p.request('tools/call', { name: 'ssh_upload', arguments: { server_id: 'test', local_path: source, remote_path: join(s.root, 'mcp-atomic'), atomic: true } }).result;
  assert.equal(mcpUpload.isError, false); assert.equal(mcpUpload.structuredContent?.publication_state, 'published'); assert.equal(mcpUpload.structuredContent?.cleanup_pending, false);
  assert.equal(readFileSync(join(s.root, 'mcp-atomic'), 'utf8'), '新配置');
  const textPath = join(s.root, 'text-config'); writeFileSync(textPath, 'name=old\r\n备注=中文\r\n'); chmodSync(textPath, 0o640);
  const textRead = await p.request('tools/call', { name: 'ssh_read_file', arguments: { server_id: 'test', remote_path: textPath, line_count: 1 } }).result;
  assert.equal(textRead.isError, false); assert.equal(textRead.structuredContent?.content, 'name=old\r\n');
  const edited = await p.request('tools/call', { name: 'ssh_edit_file', arguments: { server_id: 'test', remote_path: textPath, old_text: 'name=old', new_text: 'name=new', expected_revision: textRead.structuredContent?.revision } }).result;
  assert.equal(edited.isError, false); assert.equal(edited.structuredContent?.publication_state, 'published'); assert.equal(edited.structuredContent?.replacements, 1);
  assert.equal(readFileSync(textPath, 'utf8'), 'name=new\r\n备注=中文\r\n'); assert.equal(statSync(textPath).mode & 0o777, 0o640);
  const metadata = statSync(textPath);
  const batch = await p.request('tools/call', { name: 'ssh_edit_file', arguments: { server_id: 'test', remote_path: textPath, edits: [{ old_text: '备注=中文', new_text: '备注=更新😀' }, { old_text: 'name=new', new_text: 'name=batch' }], expected_revision: edited.structuredContent?.revision } }).result;
  assert.equal(batch.isError, false); assert.equal(batch.structuredContent?.publication_state, 'published'); assert.equal(batch.structuredContent?.replacements, 2);
  assert.equal(batch.structuredContent?.previous_revision, edited.structuredContent?.revision);
  assert.notEqual(batch.structuredContent?.revision, batch.structuredContent?.previous_revision);
  assert.equal(readFileSync(textPath, 'utf8'), 'name=batch\r\n备注=更新😀\r\n');
  const afterBatch = statSync(textPath);
  assert.deepEqual([afterBatch.mode & 0o777, afterBatch.uid, afterBatch.gid], [0o640, metadata.uid, metadata.gid]);
  p.child.stdin.end(); await p.closed;
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
  const gatewayService = await startOpenSSH(t), gateway = { ...gatewayService.config, id: 'gateway' }, hopped = { ...s.config, jumpServerId: gateway.id };
  const hoppedConfig = { ...config, servers: new Map([[gateway.id, gateway], [hopped.id, hopped]]) };
  const viaJump = await dial(hopped, hoppedConfig, new AbortController().signal), hoppedOutput = createExecResult();
  try { await exec(viaJump, 'cat', hoppedOutput, undefined, { stdin: '独立 OpenSSH 跳板\n' }); } finally { viaJump.close(); }
  assert.equal(hoppedOutput.stdout, '独立 OpenSSH 跳板\n');
  const download = await dial(hopped, hoppedConfig, new AbortController().signal);
  try { await transfer(download, 'download', join(s.root, 'download'), fresh, false, { bytes_transferred: 0 }); } finally { download.close(); }
  assert.equal(readFileSync(join(s.root, 'download'), 'utf8'), '新配置');
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
