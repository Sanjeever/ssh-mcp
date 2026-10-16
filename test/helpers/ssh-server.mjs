import ssh2 from 'ssh2';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { Server, utils } = ssh2;

export async function startSSH(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ssh-server-'));
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKey = keys.privateKey.export({ type: 'pkcs1', format: 'pem' });
  const encryptedKey = keys.privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: ' pass ' });
  const key = utils.parseKey(privateKey), publicKey = key.getPublicSSH();
  const clients = new Set();
  let authCount = 0;
  const server = new Server({ hostKeys: [privateKey] }, client => {
    clients.add(client); client.on('error', () => {}); client.once('close', () => clients.delete(client));
    client.on('authentication', ctx => {
      authCount++;
      if (options.hangAuth) return;
      if (ctx.username !== 'operator') return ctx.reject();
      if (ctx.method === 'password' && ctx.password === ' secret ') return ctx.accept();
      if (ctx.method === 'publickey' && ctx.key.data.equals(publicKey) && (!ctx.signature || key.verify(ctx.blob, ctx.signature, ctx.hashAlgo))) return ctx.accept();
      ctx.reject();
    });
    client.on('ready', () => client.on('session', (accept) => {
      if (options.hangSession) return;
      const session = accept();
      options.session?.(session, client);
    }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const c of clients) c.end(); server.close(); await once(server, 'close'); rmSync(root, { recursive: true, force: true }); });
  const config = { id: 'test', description: '', host: '127.0.0.1', port: server.address().port, username: 'operator', password: ' secret ' };
  return { root, config, publicKey, privateKey, encryptedKey, clients, authCount: () => authCount };
}
