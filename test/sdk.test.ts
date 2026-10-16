import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startSSH } from './helpers/ssh-server.js';
import { execSession } from './helpers/exec-session.js';
import { sftpSession } from './helpers/sftp-session.js';
import { executionOutput, failureOutput } from './helpers/stdio.js';

test('官方 SDK 客户端校验四工具的成功与失败输出 Schema', async t => {
  const s = await startSSH(t, { session: session => { execSession(session); sftpSession(s.root)(session); } });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !entry[0].startsWith('SSH_MCP_') && entry[1] !== undefined));
  Object.assign(env, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_SERVER_TEST_USERNAME: s.config.username, SSH_MCP_SERVER_TEST_PASSWORD: s.config.password, SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js'], env, stderr: 'pipe' });
  const client = new Client({ name: 'sdk-contract', version: '1' }); t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools(); assert.equal(tools.tools.length, 4);
  for (const tool of tools.tools) { assert(tool.outputSchema); assert.equal(tool.inputSchema.additionalProperties, false); }
  const list = await client.callTool({ name: 'ssh_list', arguments: {} }); assert.equal(list.isError, false); assert.equal(s.authCount(), 0);
  for (const command of ['ok', 'fail', 'missing', 'signal']) {
    const result = await client.callTool({ name: 'ssh_exec', arguments: { server_id: 'test', command } });
    assert.equal(result.isError, command !== 'ok'); assert.equal(executionOutput.parse(result.structuredContent).server_id, 'test');
  }
  const source = join(s.root, 'source'); writeFileSync(source, 'SDK 文件');
  for (const name of ['ssh_upload', 'ssh_download']) {
    const args = { server_id: 'test', local_path: name === 'ssh_upload' ? source : join(s.root, 'target'), remote_path: '/payload' };
    const result = await client.callTool({ name, arguments: args }); assert.equal(result.isError, false);
    const duplicate = await client.callTool({ name, arguments: args }); assert.equal(failureOutput.parse(duplicate.structuredContent).error.code, 'ssh_target_exists');
  }
  await client.close();
});
test('单文件入口支持普通及加密私钥与 ChaCha20 内嵌 WASM', async t => {
  for (const mode of ['key', 'encrypted', 'chacha']) {
    const s = await startSSH(t, { session: execSession, algorithms: mode === 'chacha' ? { cipher: ['chacha20-poly1305@openssh.com'] } : undefined });
    const keyPath = join(s.root, 'private_key');
    writeFileSync(keyPath, mode === 'encrypted' ? s.encryptedKey : s.privateKey, { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !entry[0].startsWith('SSH_MCP_') && entry[1] !== undefined));
    Object.assign(env, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_SERVER_TEST_USERNAME: s.config.username, SSH_MCP_SERVER_TEST_PRIVATE_KEY_PATH: keyPath, SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
    if (mode === 'encrypted') env.SSH_MCP_SERVER_TEST_PASSPHRASE = ' pass ';
    const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js'], env, stderr: 'pipe' });
    const client = new Client({ name: 'bundle-auth', version: '1' }); t.after(() => client.close());
    await client.connect(transport);
    const result = await client.callTool({ name: 'ssh_exec', arguments: { server_id: 'test', command: mode === 'chacha' ? 'large' : 'ok' } });
    const output = executionOutput.parse(result.structuredContent);
    assert.equal(result.isError, false); assert.equal(output.exit_code, 0);
    if (mode === 'chacha') assert.equal(output.output_truncated, true);
    else assert.equal(output.stdout, 'remote ok\n');
    await client.close();
  }
});
