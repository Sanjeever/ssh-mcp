import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolvePath } from '../src/config.js';

const base = { SSH_MCP_SERVER_PROD_DB_HOST: '::1', SSH_MCP_SERVER_PROD_DB_USERNAME: 'deploy', SSH_MCP_SERVER_PROD_DB_PASSWORD: ' secret = ' };
test('分组、默认值、主目录和凭据空白', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-config-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = join(dir, 'key'); writeFileSync(key, '测试文件');
  const config = loadConfig({ ...base, SSH_MCP_SERVER_DEV_HOST: 'localhost', SSH_MCP_SERVER_DEV_USERNAME: 'user', SSH_MCP_SERVER_DEV_PRIVATE_KEY_PATH: key, SSH_MCP_SERVER_DEV_PASSPHRASE: ' pass ', SSH_MCP_SERVER_DEV_PORT: '2222' });
  assert.deepEqual([...config.servers.keys()], ['dev', 'prod_db']);
  const prod = config.servers.get('prod_db'), dev = config.servers.get('dev');
  assert(prod && dev);
  assert.equal(prod.password, ' secret = ');
  assert.equal(prod.port, 22);
  assert.equal(dev.passphrase, ' pass ');
  assert.equal(dev.port, 2222);
  assert.equal(config.hostKeyPolicy, 'accept_new');
  assert.equal(resolvePath('~/file'), join(homedir(), 'file'));
  assert.equal(resolvePath('~'), homedir());
  if (process.platform === 'win32') assert.equal(resolvePath('~\\file'), join(homedir(), 'file'));
  assert.match(resolvePath('$LITERAL/file'), /\$LITERAL/);
});
test('单跳引用拒绝未知、自引用、循环和嵌套', () => {
  const env = { ...base, SSH_MCP_SERVER_JUMP_HOST: 'localhost', SSH_MCP_SERVER_JUMP_USERNAME: 'deploy', SSH_MCP_SERVER_JUMP_PASSWORD: 'secret', SSH_MCP_SERVER_PROD_DB_JUMP_SERVER_ID: 'jump' };
  assert.equal(loadConfig(env).servers.get('prod_db')?.jumpServerId, 'jump');
  for (const extra of [{ SSH_MCP_SERVER_PROD_DB_JUMP_SERVER_ID: 'unknown' }, { SSH_MCP_SERVER_PROD_DB_JUMP_SERVER_ID: 'prod_db' }, { SSH_MCP_SERVER_PROD_DB_JUMP_SERVER_ID: 'JUMP' }, { SSH_MCP_SERVER_JUMP_JUMP_SERVER_ID: 'prod_db' }, { SSH_MCP_SERVER_JUMP_JUMP_SERVER_ID: 'jump' }]) assert.throws(() => loadConfig({ ...env, ...extra }));
});
test('Agent 端点显式选择且与密码和私钥互斥', () => {
  const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : '/tmp/ssh-agent.sock';
  const env = { ...base, SSH_MCP_SERVER_PROD_DB_PASSWORD: undefined, SSH_MCP_SERVER_PROD_DB_AGENT_SOCKET: endpoint };
  assert.equal(loadConfig(env).servers.get('prod_db')?.agentSocket, endpoint);
  for (const extra of [{ SSH_MCP_SERVER_PROD_DB_PASSWORD: ' secret ' }, { SSH_MCP_SERVER_PROD_DB_PASSPHRASE: 'secret' }, { SSH_MCP_SERVER_PROD_DB_AGENT_SOCKET: 'pageant' }, { SSH_MCP_SERVER_PROD_DB_AGENT_SOCKET: '' }]) assert.throws(() => loadConfig({ ...env, ...extra }));
});
test('非法配置拒绝启动且不泄露凭据', () => {
  for (const [name, value] of Object.entries({ SSH_MCP_SERVER_bad_HOST: 'secret', SSH_MCP_SERVER_DEV_TOKEN: 'secret', SSH_MCP_SERVER_PROD_DB_PORT: 'secret', SSH_MCP_SERVER_PROD_DB_PRIVATE_KEY_PATH: 'secret', SSH_MCP_SERVER_PROD_DB_PASSPHRASE: 'secret', SSH_MCP_SERVER_PROD_DB_USERNAME: '', SSH_MCP_SERVER_PROD_DB_HOST: 'localhost:22', SSH_MCP_HOST_KEY_POLICY: 'secret', SSH_MCP_KNOWN_HOSTS: '~secret', SSH_MCP_SERVER_PROD_DB_PASSWORD: '' })) {
    assert.throws(() => loadConfig({ ...base, [name]: value }), error => error instanceof Error && !error.message.includes('secret'));
  }
  for (const port of ['0', '65536', '1.5', ' 22', '']) assert.throws(() => loadConfig({ ...base, SSH_MCP_SERVER_PROD_DB_PORT: port }));
  assert.throws(() => loadConfig({}), /至少/);
});

test('环境文件支持多服务器、引号和注释，进程环境优先且不被修改', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-env-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'servers.env');
  writeFileSync(file, `# 共享配置\nSSH_MCP_SERVER_DEV_HOST=localhost\nSSH_MCP_SERVER_DEV_USERNAME=deploy\nSSH_MCP_SERVER_DEV_PASSWORD=' secret # = $LITERAL '\nSSH_MCP_SERVER_DEV_DESCRIPTION=开发环境 # 注释\nSSH_MCP_SERVER_PROD_HOST=192.0.2.10\nSSH_MCP_SERVER_PROD_USERNAME=operator\nSSH_MCP_SERVER_PROD_PASSWORD=prod-secret\nSSH_MCP_HOST_KEY_POLICY=strict\nSSH_MCP_MAX_CONCURRENT=8\nNODE_OPTIONS=--invalid-option\n`);
  const env = { SSH_MCP_SERVER_DEV_HOST: '::1', SSH_MCP_SERVER_DEV_PASSWORD: undefined };
  const before = JSON.stringify(process.env);
  const config = loadConfig(env, file);
  assert.deepEqual([...config.servers.keys()], ['dev', 'prod']);
  assert.equal(config.servers.get('dev')?.host, '::1');
  assert.equal(config.servers.get('dev')?.password, ' secret # = $LITERAL ');
  assert.equal(config.servers.get('dev')?.description, '开发环境');
  assert.equal(config.hostKeyPolicy, 'strict');
  assert.equal(config.concurrency?.global, 8);
  assert.deepEqual(env, { SSH_MCP_SERVER_DEV_HOST: '::1', SSH_MCP_SERVER_DEV_PASSWORD: undefined });
  assert.equal(JSON.stringify(process.env) === before, true, '加载文件不得修改进程环境');
  assert.throws(() => loadConfig({ SSH_MCP_SERVER_DEV_PASSWORD: '' }, file), /不能为空/);
});

test('环境文件读取失败和非法配置阻止启动且不泄露凭据', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-env-errors-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => loadConfig(base, join(dir, 'secret-missing.env')), error => error instanceof Error && /无法读取/.test(error.message) && !error.message.includes('secret'));
  assert.throws(() => loadConfig(base, dir), /无法读取/);
  const file = join(dir, 'servers.env');
  writeFileSync(file, 'SSH_MCP_SERVER_DEV_HOST=localhost\nSSH_MCP_SERVER_DEV_USERNAME=deploy\nSSH_MCP_SERVER_DEV_PASSWORD=secret\nSSH_MCP_SERVER_DEV_PORT=secret\n');
  assert.throws(() => loadConfig({}, file), error => error instanceof Error && /PORT/.test(error.message) && !error.message.includes('secret'));
  writeFileSync(file, '# 空配置\n');
  assert.throws(() => loadConfig({}, file), /至少/);
});

test('调用并发和排队容量有界，非法限额拒绝启动', () => {
  assert.deepEqual(loadConfig(base).concurrency, { global: 4, perServer: 2, queue: 32 });
  assert.deepEqual(loadConfig({ ...base, SSH_MCP_MAX_CONCURRENT: '8', SSH_MCP_MAX_CONCURRENT_PER_SERVER: '3', SSH_MCP_MAX_QUEUE: '0' }).concurrency, { global: 8, perServer: 3, queue: 0 });
  for (const [name, values] of Object.entries({ SSH_MCP_MAX_CONCURRENT: ['0', '33', '1.5', 'secret'], SSH_MCP_MAX_CONCURRENT_PER_SERVER: ['0', '33', '-1'], SSH_MCP_MAX_QUEUE: ['-1', '257', ''] })) {
    for (const value of values) assert.throws(() => loadConfig({ ...base, [name]: value }), error => error instanceof Error && !error.message.includes('secret'));
  }
});
