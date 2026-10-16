import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { startCLI, serversOutput } from './helpers/stdio.js';

test('真实 stdio 初始化、列表、严格参数与 EOF', async t => {
  const p = startCLI(t, { SSH_MCP_SERVER_A_HOST: '::1', SSH_MCP_SERVER_A_USERNAME: 'user', SSH_MCP_SERVER_A_PASSWORD: 'other secret' });
  const info = await p.init();
  assert.equal(info.serverInfo.version, JSON.parse(readFileSync('package.json', 'utf8')).version);
  const tools = (await p.request('tools/list').result).tools;
  assert(tools.some(tool => tool.name === 'ssh_list' && tool.outputSchema));
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, ['ssh_list', 'ssh_output', 'ssh_read_file', 'ssh_probe', 'ssh_task_status'].includes(tool.name));
    assert.equal(tool.annotations?.destructiveHint, !['ssh_list', 'ssh_output', 'ssh_read_file', 'ssh_probe', 'ssh_task_status'].includes(tool.name));
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
  await assert.rejects(p.request('tools/call', { name: 'absent', arguments: {} }).result, /未知工具/);
  p.child.stdin.end(); assert.equal((await p.closed)[0], 0); assert.equal(p.diagnostics(), '');
});
test('版本与启动错误保持 stdout 隔离', () => {
  const version = spawnSync(process.execPath, ['dist/cli.js', '--version'], { encoding: 'utf8', env: {} });
  assert.equal(version.status, 0); assert.equal(version.stdout.trim(), JSON.parse(readFileSync('package.json', 'utf8')).version);
  const invalid = spawnSync(process.execPath, ['dist/cli.js'], { encoding: 'utf8', env: {} });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.match(invalid.stderr, /至少/);
});
