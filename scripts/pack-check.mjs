import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './process.mjs';
import { npm } from './npm.mjs';
import { smoke } from './smoke.mjs';
import { pack } from './pack.mjs';
import { startSSH } from '../test/helpers/ssh-server.mjs';
import { execSession } from '../test/helpers/exec-session.mjs';
import { sftpSession } from '../test/helpers/sftp-session.mjs';

export async function checkPack(tarball) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const temp = mkdtempSync(join(tmpdir(), 'ssh-mcp-pack-'));
  const cleanup = [];
  try {
    const ssh = await startSSH({ after: fn => cleanup.push(fn) }, { session: session => { execSession(session); sftpSession(ssh.root)(session); } });
    const entry = tarball ? { path: resolve(tarball) } : pack(root, join(temp, 'tarballs'));
    const cache = join(temp, 'cache');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_MCP_') && !key.toLowerCase().startsWith('npm_config_')));
    Object.assign(env, { SSH_MCP_SERVER_SMOKE_HOST: ssh.config.host, SSH_MCP_SERVER_SMOKE_PORT: String(ssh.config.port), SSH_MCP_SERVER_SMOKE_USERNAME: ssh.config.username, SSH_MCP_SERVER_SMOKE_PASSWORD: ssh.config.password, SSH_MCP_KNOWN_HOSTS: join(temp, 'known_hosts') });
    // 首次正常安装准备独立 registry 缓存；Unix 限制 PATH，验证没有编译器也能安装。
    const installEnv = { ...env };
    if (process.platform !== 'win32') {
      const tools = join(temp, 'tools'); mkdirSync(tools);
      symlinkSync(process.execPath, join(tools, 'node')); symlinkSync('/bin/sh', join(tools, 'sh')); installEnv.PATH = tools;
    }
    for (const [index, flags] of [[], ['--offline', '--ignore-scripts'], ['--offline', '--omit=optional']].entries()) {
      const install = join(temp, `install-${index}`); mkdirSync(install);
      writeFileSync(join(install, 'package.json'), JSON.stringify({ name: 'ssh-mcp-isolated-test', version: '1.0.0', private: true }));
      const result = npm(['install', '--cache', cache, '--no-audit', '--no-fund', ...flags, entry.path], { cwd: install, env: installEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.equal(result.status, 0);
      const installed = join(install, 'node_modules/@sanjeever/ssh-mcp');
      const meta = JSON.parse(readFileSync(join(installed, 'package.json')));
      assert.equal(meta.version, pkg.version); assert.equal(meta.optionalDependencies, undefined); assert.equal(meta.bin['ssh-mcp'], 'dist/cli.js');
      const version = npm(['exec', '--offline', '--cache', cache, '--', 'ssh-mcp', '--version'], { cwd: install, env, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.equal(version.stdout.toString().trim(), pkg.version);
      const source = join(install, 'source'), target = join(install, 'target'); writeFileSync(source, '隔离安装 SFTP 往返');
      const remote = `/payload-${index}`;
      const calls = [
        { name: 'ssh_exec', arguments: { server_id: 'smoke', command: 'ok' } },
        { name: 'ssh_upload', arguments: { server_id: 'smoke', local_path: source, remote_path: remote } },
        { name: 'ssh_download', arguments: { server_id: 'smoke', local_path: target, remote_path: remote } },
      ];
      assert.equal(await smoke(process.execPath, [join(installed, 'dist/cli.js')], env, install, calls), pkg.version);
      assert.equal(readFileSync(target, 'utf8'), readFileSync(source, 'utf8'));
      console.log(`已验证 ${process.platform}-${process.arch} 隔离安装 ${index === 0 ? '正常安装' : flags.join(' ')}、CLI、初始化与四工具实际调用`);
    }
    return entry.info;
  } finally { for (const close of cleanup) await close(); rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkPack(process.argv[2]);
