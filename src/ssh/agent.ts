import { Socket } from 'node:net';
import ssh2 from 'ssh2';
import type { GetStreamCallback, IdentityCallback, ParsedKey } from 'ssh2';
import { SSHError, interrupted } from '../errors.js';

// 协议编解码复用 ssh2，仅接管 socket 生命周期，保证超时后不遗留 Agent 连接。
export class ScopedAgent extends ssh2.OpenSSHAgent {
  private sockets = new Set<Socket>();
  private disposed = false;
  failure?: SSHError;
  constructor(private endpoint: string, private signal: AbortSignal) {
    super(endpoint);
    signal.addEventListener('abort', this.dispose, { once: true });
  }
  override getStream(callback: GetStreamCallback) {
    if (this.signal.aborted || this.disposed) { callback(interrupted(this.signal)); return; }
    const socket = new Socket(); this.sockets.add(socket);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) {
        this.failure = new SSHError('ssh_auth_failed', '无法连接 SSH Agent，请检查 socket 或 named pipe', { phase: 'authentication', reason: 'agent_unavailable' });
        socket.destroy(); callback(this.failure);
      } else callback(undefined, socket);
    };
    socket.once('connect', () => finish());
    socket.on('error', error => finish(error));
    socket.once('close', () => { this.sockets.delete(socket); finish(new Error('Agent 已关闭')); });
    socket.connect(this.endpoint);
  }
  override getIdentities(callback: IdentityCallback<ParsedKey>) {
    super.getIdentities((error, keys) => {
      if (!error && !keys?.length) this.failure = new SSHError('ssh_auth_failed', 'SSH Agent 中没有可用密钥', { phase: 'authentication', reason: 'agent_empty' });
      callback(error ?? this.failure, keys);
    });
  }
  dispose = () => {
    this.disposed = true;
    this.signal.removeEventListener('abort', this.dispose);
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  };
}
