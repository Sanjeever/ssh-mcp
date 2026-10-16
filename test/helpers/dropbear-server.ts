import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import ssh2 from 'ssh2';
import type { ServerConfig } from '../../src/config.js';

const run = promisify(execFile);
const IMAGE = 'alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0';

// Docker 内准备账户、密钥和 BusyBox Shell；不会读取或修改宿主 authorized_keys。
export async function startDropbear(t: { after: (fn: () => void | Promise<void>) => void }, sftp: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-dropbear-'));
  const name = 'ssh-mcp-dropbear-' + randomUUID();
  let container = false;
  t.after(async () => {
    try { if (container) await run('docker', ['rm', '--force', name], { timeout: 30000 }); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const parsed = ssh2.utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const keyPath = join(root, 'identity');
  await writeFile(keyPath, privateKey, { mode: 0o600 });
  await writeFile(join(root, 'authorized_keys'), `${parsed.type} ${parsed.getPublicSSH().toString('base64')}\n`, { mode: 0o600 });
  const setup = [
    `apk add --no-cache dropbear${sftp ? ' openssh-sftp-server' : ''}`,
    'mkdir -m 700 -p /root/.ssh',
    'cp /fixtures/authorized_keys /root/.ssh/authorized_keys',
    'chmod 600 /root/.ssh/authorized_keys',
    "printf 'root:fixture-password\\n' | chpasswd",
    'dropbearkey -t ed25519 -f /tmp/host_key',
    'exec dropbear -F -E -s -r /tmp/host_key -p 22',
  ].join('\n');
  await run('docker', ['run', '--detach', '--rm', '--name', name, '--publish', '127.0.0.1::22', '--volume', `${root}:/fixtures:ro`, IMAGE, '/bin/sh', '-ec', setup], { timeout: 120000 });
  container = true;
  const mapping = (await run('docker', ['port', name, '22/tcp'])).stdout.trim();
  const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping);
  if (!match) throw new Error(`Dropbear 临时端口映射无效：${mapping}`);
  const config: ServerConfig = { id: 'dropbear', description: '', host: '127.0.0.1', port: Number(match[1]), username: 'root', privateKeyPath: keyPath };
  for (let attempt = 0; attempt < 150; attempt++) {
    const ready = await new Promise<boolean>(resolve => {
      const probe = new ssh2.Client();
      const finish = (value: boolean) => { probe.destroy(); resolve(value); };
      probe.on('error', () => finish(false)); probe.once('handshake', () => finish(true));
      probe.connect({ host: config.host, port: config.port, username: config.username, readyTimeout: 1000, hostVerifier: () => true });
    });
    if (ready) return { root, config };
    await delay(100);
  }
  const logs = (await run('docker', ['logs', name])).stderr;
  throw new Error(`Dropbear 未就绪：${logs}`);
}
