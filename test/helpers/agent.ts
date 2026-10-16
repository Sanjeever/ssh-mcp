import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import ssh2 from 'ssh2';
import assert from 'node:assert/strict';

export async function startAgent(t: { after: (fn: () => void | Promise<void>) => void }, root: string, privateKey: string | Buffer, options: { empty?: boolean; hang?: boolean } = {}) {
  const key = ssh2.utils.parseKey(privateKey); assert(!(key instanceof Error));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\ssh-mcp-${randomUUID()}` : join(root, 'agent.sock');
  const sockets = new Set<Socket>(); let queries = 0, signatures = 0;
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    const protocol = new ssh2.AgentProtocol(false); protocol.on('error', () => socket.destroy());
    protocol.on('identities', request => { queries++; if (!options.hang) protocol.getIdentitiesReply(request, options.empty ? [] : [key]); });
    protocol.on('sign', (request, _publicKey, data, signing) => {
      signatures++;
      const signature = key.sign(data, signing.hash);
      if (signature instanceof Error) protocol.failureReply(request); else protocol.signReply(request, signature);
    });
    socket.pipe(protocol).pipe(socket);
  });
  server.listen(endpoint); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return { endpoint, sockets, queries: () => queries, signatures: () => signatures };
}
