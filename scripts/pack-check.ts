import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './process.js';
import { npm } from './npm.js';
import { smoke } from './smoke.js';
import type { SmokeStep } from './smoke.js';
import { pack } from './pack.js';
import { startSSH } from '../test/helpers/ssh-server.js';
import { execSession } from '../test/helpers/exec-session.js';
import { sftpSession } from '../test/helpers/sftp-session.js';
import { startAgent } from '../test/helpers/agent.js';

export async function checkPack(tarball?: string) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const temp = mkdtempSync(join(tmpdir(), 'ssh-mcp-pack-'));
  const cleanup: Array<() => void | Promise<void>> = [];
  try {
    const ssh = await startSSH({ after: fn => { cleanup.push(fn); } }, { session: session => { execSession(session); sftpSession(ssh.root)(session); } });
    const agent = await startAgent({ after: fn => { cleanup.push(fn); } }, ssh.root, ssh.privateKey);
    const gateway = await startSSH({ after: fn => { cleanup.push(fn); } }, { forward: true });
    const entry = tarball ? { path: resolve(tarball), info: undefined } : pack(root, join(temp, 'tarballs'));
    const cache = join(temp, 'cache');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_MCP_') && !key.toLowerCase().startsWith('npm_config_')));
    Object.assign(env, { SSH_MCP_SERVER_SMOKE_HOST: ssh.config.host, SSH_MCP_SERVER_SMOKE_PORT: String(ssh.config.port), SSH_MCP_SERVER_SMOKE_USERNAME: ssh.config.username, SSH_MCP_SERVER_SMOKE_PASSWORD: ssh.config.password, SSH_MCP_KNOWN_HOSTS: join(temp, 'known_hosts') });
    // 隔离用户 npm 缓存；Unix 限制 PATH，验证没有编译器也能安装。
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
      const meta = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
      assert.equal(meta.version, pkg.version); assert.equal(meta.optionalDependencies, undefined); assert.equal(meta.bin['ssh-mcp'], 'dist/cli.js');
      assert.equal(meta.dependencies, undefined);
      assert.deepEqual(readdirSync(join(installed, 'dist')).sort(), ['THIRD_PARTY_NOTICES.txt', 'cli.js']);
      const installedLock = JSON.parse(readFileSync(join(install, 'node_modules/.package-lock.json'), 'utf8'));
      assert.deepEqual(Object.keys(installedLock.packages), ['node_modules/@sanjeever/ssh-mcp']);
      const version = npm(['exec', '--offline', '--cache', cache, '--', 'ssh-mcp', '--version'], { cwd: install, env, stdio: ['ignore', 'pipe', 'pipe'] });
      assert(version.stdout);
      assert.equal(version.stdout.toString().trim(), pkg.version);
      const source = join(install, 'source'), target = join(install, 'target'); writeFileSync(source, '隔离安装 SFTP 往返');
      const remote = `/payload-${index}`;
      const calls: SmokeStep[] = [
        { request: { name: 'ssh_exec', arguments: { server_id: 'smoke', command: 'ok', save_output: true } } },
        { request: { name: 'ssh_exec', arguments: { server_id: 'smoke', command: 'stdin', stdin: '安装包标准输入\n' } } },
        { request: { name: 'ssh_upload', arguments: { server_id: 'smoke', local_path: source, remote_path: remote } } },
        { request: { name: 'ssh_download', arguments: { server_id: 'smoke', local_path: target, remote_path: remote } } },
        { request: { name: 'ssh_probe', arguments: { server_id: 'smoke' } } },
        { request: { name: 'ssh_read_file', arguments: { server_id: 'smoke', remote_path: remote } } },
        { request: results => ({ name: 'ssh_edit_file', arguments: { server_id: 'smoke', remote_path: remote, edits: [{ old_text: '隔离安装', new_text: '包内验证' }, { old_text: '往返', new_text: '修改' }], expected_revision: results[5]?.structuredContent?.revision } }), error_code: 'ssh_transfer_failed' },
        { request: results => ({ name: 'ssh_output', arguments: { output_id: results[0]?.structuredContent?.output_id, tail: true, wait_seconds: 1 } }) },
        { request: { name: 'ssh_exec_start', arguments: { server_id: 'smoke', command: 'hang' } } },
        { request: results => ({ name: 'ssh_task_status', arguments: { task_id: results[8]?.structuredContent?.task_id } }) },
        { request: results => ({ name: 'ssh_task_cancel', arguments: { task_id: results[8]?.structuredContent?.task_id } }) },
        { request: results => ({ name: 'ssh_output_forget', arguments: { output_id: results[0]?.structuredContent?.output_id } }) },
        { request: { name: 'ssh_task_list', arguments: {} } },
      ];
      assert.equal(await smoke(process.execPath, [join(installed, 'dist/cli.js')], env, install, calls), pkg.version);
      assert.equal(readFileSync(target, 'utf8'), readFileSync(source, 'utf8'));
      const agentEnv = { ...env, SSH_MCP_SERVER_SMOKE_PASSWORD: undefined, SSH_MCP_SERVER_SMOKE_AGENT_SOCKET: agent.endpoint, SSH_MCP_SERVER_SMOKE_JUMP_SERVER_ID: 'gateway', SSH_MCP_SERVER_GATEWAY_HOST: gateway.config.host, SSH_MCP_SERVER_GATEWAY_PORT: String(gateway.config.port), SSH_MCP_SERVER_GATEWAY_USERNAME: gateway.config.username, SSH_MCP_SERVER_GATEWAY_PASSWORD: gateway.config.password };
      assert.equal(await smoke(process.execPath, [join(installed, 'dist/cli.js')], agentEnv, install, [calls[0]!, calls[1]!]), pkg.version);
      console.log(`已验证 ${process.platform}-${process.arch} 隔离安装 ${index === 0 ? '正常安装' : flags.join(' ')}、CLI、全部工具、标准输入、Agent 与跳板机`);
    }
    return entry.info;
  } finally { for (const close of cleanup) await close(); rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkPack(process.argv[2]);
