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
  const list = await p.request('tools/call', { name: 'ssh_list', arguments: {} }).result;
  assert.deepEqual(serversOutput.parse(list.structuredContent).servers.map(s => s.server_id), ['a', 'test']);
  assert(!JSON.stringify(list).includes('secret'));
  const invalid = await p.request('tools/call', { name: 'ssh_list', arguments: { secret: 'private' } }).result;
  assert.equal(invalid.isError, true); assert(!JSON.stringify(invalid).includes('private'));
  p.child.stdin.end(); assert.equal((await p.closed)[0], 0); assert.equal(p.diagnostics(), '');
});
test('版本与启动错误保持 stdout 隔离', () => {
  const version = spawnSync(process.execPath, ['dist/cli.js', '--version'], { encoding: 'utf8', env: {} });
  assert.equal(version.status, 0); assert.equal(version.stdout.trim(), JSON.parse(readFileSync('package.json', 'utf8')).version);
  const invalid = spawnSync(process.execPath, ['dist/cli.js'], { encoding: 'utf8', env: {} });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.match(invalid.stderr, /至少/);
});
