#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const { join, dirname } = require('node:path');
const { readFileSync } = require('node:fs');

function platformPackage(platform, arch) {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`不支持的平台：${platform}/${arch}，支持 macOS、Linux、Windows 的 x64 和 arm64`);
  }
  return `@sanjeever/ssh-mcp-${platform}-${arch}`;
}

function resolveBinary(platform = process.platform, arch = process.arch, resolve = require.resolve) {
  const name = platformPackage(platform, arch);
  let manifest;
  try {
    manifest = resolve(`${name}/package.json`);
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
    throw new Error(`缺少平台包 ${name}，请启用 optionalDependencies 并重新安装 @sanjeever/ssh-mcp`);
  }
  const entry = require('../package.json');
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  if (pkg.version !== entry.version) {
    throw new Error(`平台包版本不一致：入口 ${entry.version}，平台 ${pkg.version}，请重新安装`);
  }
  return join(dirname(manifest), 'bin', platform === 'win32' ? 'ssh-mcp.exe' : 'ssh-mcp');
}

function launch() {
  let binary;
  try { binary = resolveBinary(); } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit', env: process.env, shell: false });
  const signals = ['SIGINT', 'SIGTERM'];
  const handlers = new Map(signals.map(signal => [signal, () => { child.kill(signal); }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const cleanup = () => { for (const [signal, handler] of handlers) process.removeListener(signal, handler); };
  child.once('error', err => {
    cleanup();
    console.error(`无法启动 SSH MCP 二进制：${err.code ?? '启动失败'}，请检查安装与可执行权限`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    cleanup();
    if (signal) {
      if (process.platform === 'win32') process.exitCode = signal === 'SIGINT' ? 130 : 143;
      else process.kill(process.pid, signal);
    } else process.exitCode = code ?? 1;
  });
}

module.exports = { platformPackage, resolveBinary };
if (require.main === module) launch();
