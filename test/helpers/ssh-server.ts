import ssh2 from 'ssh2';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import assert from 'node:assert/strict';
import type { Connection, ServerConfig as SSHServerConfig, Session } from 'ssh2';
import type { ServerConfig } from '../../src/config.js';
const { Server, utils } = ssh2;

// ssh2 服务端提供此方法，当前 @types/ssh2 只声明了客户端版本。
declare module 'ssh2' {
  interface Connection { setNoDelay(noDelay?: boolean): this }
}

interface SSHOptions {
  algorithms?: SSHServerConfig['algorithms'];
  hangAuth?: boolean;
  hangSession?: boolean;
  forward?: boolean | 'hang';
  onForward?: () => void;
  session?: (session: Session, client: Connection) => void;
}

export async function startSSH(t: { after: (fn: () => void | Promise<void>) => void }, options: SSHOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ssh-server-'));
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKey = keys.privateKey.export({ type: 'pkcs1', format: 'pem' });
  const encryptedKey = keys.privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: ' pass ' });
  const key = utils.parseKey(privateKey);
  assert(!(key instanceof Error));
  const publicKey = key.getPublicSSH();
  const clients = new Set<Connection>();
  let authCount = 0;
  const server = new Server({ hostKeys: [privateKey], algorithms: options.algorithms }, client => {
    client.setNoDelay(true);
    clients.add(client); client.on('error', () => {}); client.once('close', () => clients.delete(client));
    client.on('authentication', ctx => {
      authCount++;
      if (options.hangAuth) return;
      if (ctx.username !== 'operator') return ctx.reject();
      if (ctx.method === 'password' && ctx.password === ' secret ') return ctx.accept();
      if (ctx.method === 'publickey' && ctx.key.data.equals(publicKey) && (!ctx.signature || (ctx.blob && key.verify(ctx.blob, ctx.signature, ctx.hashAlgo)))) return ctx.accept();
      ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', accept => {
        if (options.hangSession) return;
        const session = accept(); options.session?.(session, client);
      });
      client.on('tcpip', (accept, reject, info) => {
        options.onForward?.();
        if (options.forward === 'hang') return;
        if (!options.forward || info.destIP !== '127.0.0.1') { reject(); return; }
        const socket = createConnection({ host: info.destIP, port: info.destPort });
        let accepted = false;
        const close = () => socket.destroy(); client.once('close', close);
        socket.once('close', () => client.off('close', close));
        socket.on('error', () => { if (!accepted) reject(); });
        socket.once('connect', () => {
          accepted = true;
          const channel = accept(); channel.on('error', close); channel.once('close', close);
          socket.pipe(channel).pipe(socket);
        });
      });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const c of clients) c.end(); server.close(); await once(server, 'close'); rmSync(root, { recursive: true, force: true }); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const config: ServerConfig = { id: 'test', description: '', host: '127.0.0.1', port: address.port, username: 'operator', password: ' secret ' };
  return { root, config, publicKey, privateKey, encryptedKey, clients, authCount: () => authCount };
}
