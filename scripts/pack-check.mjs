import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './process.mjs';
import { npm } from './npm.mjs';
import { smoke } from './smoke.mjs';

export function pack(dir, destination) {
  mkdirSync(destination, { recursive: true });
  const result = npm(['pack', dir, '--json', '--ignore-scripts', '--pack-destination', destination], { stdio: ['ignore', 'pipe', 'pipe'] });
  const [info] = JSON.parse(result.stdout);
  for (const file of info.files) assert.match(file.path, /^(package\.json|README\.md|LICENSE|dist\/[a-z0-9/.-]+\.js)$/);
  assert(info.files.some(file => file.path === 'dist/cli.js'));
  assert(!info.files.some(file => /dist\/(npm|packages|release)\//.test(file.path)));
  return { path: join(destination, info.filename), info };
}

export async function checkPack(tarball) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const temp = mkdtempSync(join(tmpdir(), 'ssh-mcp-pack-'));
  try {
    const entry = tarball ? { path: resolve(tarball) } : pack(root, join(temp, 'tarballs'));
    const cache = join(temp, 'cache');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_MCP_') && !key.toLowerCase().startsWith('npm_config_')));
    Object.assign(env, { SSH_MCP_SERVER_SMOKE_HOST: '192.0.2.1', SSH_MCP_SERVER_SMOKE_USERNAME: 'test', SSH_MCP_SERVER_SMOKE_PASSWORD: '合成测试密码', SSH_MCP_KNOWN_HOSTS: join(temp, 'known_hosts') });
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
      assert.equal(await smoke(process.execPath, [join(installed, 'dist/cli.js')], env, install), pkg.version);
      console.log(`已验证 ${process.platform}-${process.arch} 隔离安装 ${index === 0 ? '正常安装' : flags.join(' ')}、CLI、初始化与四工具发现`);
    }
    return entry.info;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkPack(process.argv[2]);
