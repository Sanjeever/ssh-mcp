import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import ssh2 from 'ssh2';
import type { ServerConfig } from '../../src/config.js';

export async function startOpenSSH(t: { after: (fn: () => void | Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'ssh-openssh-'));
  let stop = async () => {};
  t.after(async () => { try { await stop(); } finally { rmSync(root, { recursive: true, force: true }); } });
  const keyPath = join(root, 'identity'), hostKeyPath = join(root, 'host');
  for (const path of [keyPath, hostKeyPath]) {
    const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`临时密钥生成失败：${result.stderr}`);
  }
  writeFileSync(join(root, 'authorized_keys'), readFileSync(keyPath + '.pub')); chmodSync(join(root, 'authorized_keys'), 0o600);
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('临时端口分配失败');
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const username = userInfo().username;
  const configPath = join(root, 'sshd_config');
  // Linux runner 的密码可能被锁定，使用 PAM 账户检查支持公钥认证，不修改宿主账户。
  const pam = process.platform === 'linux' ? 'UsePAM yes' : 'UsePAM no';
  writeFileSync(configPath, [`Port ${address.port}`, 'ListenAddress 127.0.0.1', `HostKey "${hostKeyPath}"`, `PidFile "${join(root, 'sshd.pid')}"`, `AuthorizedKeysFile "${join(root, 'authorized_keys')}"`, `AllowUsers ${username}`, 'StrictModes no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', pam, 'PermitRootLogin yes', 'AllowTcpForwarding yes', 'Subsystem sftp internal-sftp', 'LogLevel VERBOSE'].join('\n') + '\n');
  const useSudo = process.env.SSH_MCP_TEST_SSHD_SUDO === '1';
  const child = spawn(useSudo ? 'sudo' : '/usr/sbin/sshd', useSudo ? ['-n', '/usr/sbin/sshd', '-D', '-e', '-f', configPath] : ['-D', '-e', '-f', configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', (data: Buffer) => { diagnostics += data.toString(); });
  const closed = once(child, 'close');
  stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      if (useSudo) spawnSync('sudo', ['-n', 'kill', '-TERM', readFileSync(join(root, 'sshd.pid'), 'utf8').trim()]);
      else child.kill('SIGTERM');
    }
    await closed;
  };
  const config: ServerConfig = { id: 'openssh', description: '', host: '127.0.0.1', port: address.port, username, privateKeyPath: keyPath };
  // 用真实 SSH 握手确认就绪；探测不认证、不写 known_hosts。
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`临时 sshd 启动失败：${diagnostics}`);
    const ready = await new Promise<boolean>(resolve => {
      const probe = new ssh2.Client();
      const finish = (value: boolean) => { probe.destroy(); resolve(value); };
      probe.on('error', () => finish(false)); probe.once('handshake', () => finish(true));
      probe.connect({ host: config.host, port: config.port, username, readyTimeout: 1000, hostVerifier: () => true });
    });
    if (ready) return { root, config, diagnostics: () => diagnostics };
    await delay(20);
  }
  throw new Error(`临时 sshd 未就绪：${diagnostics}`);
}

export async function startOpenSSHAgent(t: { after: (fn: () => void | Promise<void>) => void }, root: string, keyPath: string) {
  const endpoint = join(root, 'system-agent.sock');
  const child = spawn('ssh-agent', ['-D', '-a', endpoint], { stdio: 'ignore' });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed; });
  for (let attempt = 0; !existsSync(endpoint) && attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('临时 ssh-agent 启动失败');
    await delay(10);
  }
  if (!existsSync(endpoint)) throw new Error('临时 ssh-agent 未就绪');
  const added = spawnSync('ssh-add', [keyPath], { env: { ...process.env, SSH_AUTH_SOCK: endpoint }, encoding: 'utf8' });
  if (added.status !== 0) throw new Error(`临时 Agent 加载密钥失败：${added.stderr}`);
  return endpoint;
}
