import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './build.mjs';
import { platforms } from './platforms.mjs';
import { npm } from './npm.mjs';
import { smoke } from './smoke.mjs';

export function pack(dir, destination) {
  mkdirSync(destination, { recursive: true });
  const result = npm(['pack', dir, '--json', '--ignore-scripts', '--pack-destination', destination], { stdio: ['ignore', 'pipe', 'pipe'] });
  const [info] = JSON.parse(result.stdout);
  for (const file of info.files) {
    assert.match(file.path, /^(package\.json|README\.md|LICENSE|bin\/ssh-mcp(?:\.cjs|\.exe)?)$/);
  }
  return { path: join(destination, info.filename), info };
}

export async function checkPack() {
  const host = platforms.find(p => p.os === process.platform && p.cpu === process.arch);
  if (!host) throw new Error('当前机器没有支持的原生目标');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const temp = mkdtempSync(join(tmpdir(), 'ssh-mcp-pack-'));
  try {
    const entry = pack(root, join(temp, 'tarballs'));
    const platform = pack(join(root, 'dist/npm', host.id), join(temp, 'tarballs'));
    assert(entry.info.files.some(file => file.path === 'bin/ssh-mcp.cjs'));
    assert(platform.info.files.some(file => file.path === `bin/${host.binary}`));
    assert(!entry.info.files.some(file => file.path.endsWith('.exe') || file.path === 'bin/ssh-mcp'));
    const install = join(temp, 'install'); mkdirSync(install);
    writeFileSync(join(install, 'package.json'), JSON.stringify({ name: 'ssh-mcp-isolated-test', version: '1.0.0', private: true }));
    // 同时将本机平台包作为显式本地依赖安装，不访问尚未发布的 registry 版本。
    npm(['install', '--offline', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', entry.path, platform.path], { cwd: install });
    const installed = join(install, 'node_modules/@sanjeever/ssh-mcp');
    assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'))).version, pkg.version);
    const version = npm(['exec', '--offline', '--', 'ssh-mcp', '--version'], { cwd: install, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(version.stdout.toString().trim(), pkg.version);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_MCP_')));
    Object.assign(env, { SSH_MCP_SERVER_SMOKE_HOST: '192.0.2.1', SSH_MCP_SERVER_SMOKE_USERNAME: 'test', SSH_MCP_SERVER_SMOKE_PASSWORD: '合成测试密码', SSH_MCP_KNOWN_HOSTS: join(temp, 'known_hosts') });
    assert.equal(await smoke(process.execPath, [join(installed, 'bin/ssh-mcp.cjs')], env), pkg.version);
    console.log(`已验证 ${host.id} 本地 tarball 隔离安装、可执行入口、MCP 初始化和 ssh_list`);
    return { entry: entry.info, platform: platform.info };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkPack();
