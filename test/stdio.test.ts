import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { startCLI, serversOutput } from './helpers/stdio.js';

test('真实 stdio 初始化、列表、严格参数与 EOF', async t => {
  const p = startCLI(t, { SSH_MCP_SERVER_A_HOST: '::1', SSH_MCP_SERVER_A_USERNAME: 'user', SSH_MCP_SERVER_A_PASSWORD: 'other secret' });
  const info = await p.init();
  assert.equal(info.serverInfo.version, JSON.parse(readFileSync('package.json', 'utf8')).version);
  const tools = (await p.request('tools/list').result).tools;
  assert(tools.some(tool => tool.name === 'ssh_list' && tool.outputSchema));
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, ['ssh_list', 'ssh_output', 'ssh_read_file', 'ssh_probe', 'ssh_task_status', 'ssh_task_list'].includes(tool.name));
    assert.equal(tool.annotations?.destructiveHint, !['ssh_list', 'ssh_output', 'ssh_read_file', 'ssh_probe', 'ssh_task_status', 'ssh_task_list'].includes(tool.name));
  }
  const list = await p.request('tools/call', { name: 'ssh_list', arguments: {} }).result;
  assert.deepEqual(serversOutput.parse(list.structuredContent).servers.map(s => s.server_id), ['a', 'test']);
  assert(!JSON.stringify(list).includes('secret'));
  const invalid = await p.request('tools/call', { name: 'ssh_list', arguments: { secret: 'private' } }).result;
  assert.equal(invalid.isError, true); assert(!JSON.stringify(invalid).includes('private'));
  assert.deepEqual(invalid.structuredContent, { error: { code: 'ssh_input_invalid', message: '工具参数无效，请检查字段类型、取值范围和未知参数', phase: 'validation', operation_state: 'not_started', issues: [{ path: [], code: 'unrecognized_keys' }] } });
  const bounds = await p.request('tools/call', { name: 'ssh_exec', arguments: { server_id: 'test', command: 'ok', timeout_seconds: 0 } }).result;
  assert.match(JSON.stringify(bounds.structuredContent), /"path":\["timeout_seconds"\].*"minimum":1/);
  const tooLarge = await p.request('tools/call', { name: 'ssh_exec', arguments: { server_id: 'test', command: 'ok', stdin: '中'.repeat(350000) } }).result;
  assert.match(JSON.stringify(tooLarge.structuredContent), /"path":\["stdin"\].*"maximum":1048576/);
  for (const name of ['ssh_task_status', 'ssh_output']) {
    const args = { [name === 'ssh_task_status' ? 'task_id' : 'output_id']: '00000000-0000-4000-8000-000000000000', wait_seconds: 31 };
    const invalidWait = await p.request('tools/call', { name, arguments: args }).result;
    assert.match(JSON.stringify(invalidWait.structuredContent), /"path":\["wait_seconds"\].*"maximum":30/);
  }
  await assert.rejects(p.request('tools/call', { name: 'absent', arguments: {} }).result, /未知工具/);
  p.child.stdin.end(); assert.equal((await p.closed)[0], 0); assert.equal(p.diagnostics(), '');
});
test('版本与启动错误保持 stdout 隔离', () => {
  const version = spawnSync(process.execPath, ['dist/cli.js', '--version'], { encoding: 'utf8', env: {} });
  assert.equal(version.status, 0); assert.equal(version.stdout.trim(), JSON.parse(readFileSync('package.json', 'utf8')).version);
  const invalid = spawnSync(process.execPath, ['dist/cli.js'], { encoding: 'utf8', env: {} });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.match(invalid.stderr, /至少/);
});

test('真实 stdio 从环境文件启动，支持两种参数写法和环境覆盖', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-stdio-env-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'servers with spaces.env');
  writeFileSync(file, 'SSH_MCP_SERVER_TEST_HOST=192.0.2.2\nSSH_MCP_SERVER_TEST_USERNAME=file-user\nSSH_MCP_SERVER_TEST_PASSWORD=" file-secret # "\nSSH_MCP_SERVER_DEV_HOST=localhost\nSSH_MCP_SERVER_DEV_USERNAME=deploy\nSSH_MCP_SERVER_DEV_PASSWORD=dev-secret\n');
  for (const args of [['--env-file', file], [`--env-file=${file}`]]) {
    const p = startCLI(t, { SSH_MCP_SERVER_TEST_USERNAME: undefined, SSH_MCP_SERVER_TEST_PASSWORD: undefined }, args);
    await p.init();
    const list = await p.request('tools/call', { name: 'ssh_list', arguments: {} }).result;
    const servers = serversOutput.extend({ servers: serversOutput.shape.servers.element.extend({ host: z.string(), username: z.string() }).array() }).parse(list.structuredContent).servers;
    assert.deepEqual(servers.map(s => s.server_id), ['dev', 'test']);
    assert.equal(servers[1]?.host, '192.0.2.1');
    assert.equal(servers[1]?.username, 'file-user');
    assert(!JSON.stringify(list).includes('secret'));
    p.child.stdin.end(); assert.equal((await p.closed)[0], 0); assert.equal(p.diagnostics(), '');
  }
});

test('环境文件参数及读取错误只写 stderr', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-args-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'servers.env'); writeFileSync(file, '# 参数校验\n');
  for (const args of [['--env-file'], ['--env-file='], ['--env-file', file, '--env-file', file], ['--version', '--env-file', file], ['--unknown'], ['--env-file', join(dir, 'missing.env')]]) {
    const result = spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8', env: {} });
    // Node 部分版本会在脚本运行前读取 --env-file，缺失文件由运行时直接报错。
    assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
    assert.match(result.stderr, /用法|无法读取|not found/);
  }
});
