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
test('非法配置拒绝启动且不泄露凭据', () => {
  for (const [name, value] of Object.entries({ SSH_MCP_SERVER_bad_HOST: 'secret', SSH_MCP_SERVER_DEV_TOKEN: 'secret', SSH_MCP_SERVER_PROD_DB_PORT: 'secret', SSH_MCP_SERVER_PROD_DB_PRIVATE_KEY_PATH: 'secret', SSH_MCP_SERVER_PROD_DB_PASSPHRASE: 'secret', SSH_MCP_SERVER_PROD_DB_USERNAME: '', SSH_MCP_SERVER_PROD_DB_HOST: 'localhost:22', SSH_MCP_HOST_KEY_POLICY: 'secret', SSH_MCP_KNOWN_HOSTS: '~secret', SSH_MCP_SERVER_PROD_DB_PASSWORD: '' })) {
    assert.throws(() => loadConfig({ ...base, [name]: value }), error => error instanceof Error && !error.message.includes('secret'));
  }
  for (const port of ['0', '65536', '1.5', ' 22', '']) assert.throws(() => loadConfig({ ...base, SSH_MCP_SERVER_PROD_DB_PORT: port }));
  assert.throws(() => loadConfig({}), /至少/);
});
