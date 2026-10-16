import { readFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import type { EventEmitter } from 'node:events';
import ssh2 from 'ssh2';
import type { Client, ClientChannel } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type { Config, ServerConfig } from '../config.js';
import { SSHError, interrupted } from '../errors.js';
import { verifyHost } from './known-hosts.js';
import { ScopedAgent } from './agent.js';
const { Client: SSHClient, utils } = ssh2;

export class Connection {
  closed = false;
  constructor(readonly client: Client, readonly signal: AbortSignal, private upstream?: Connection) { client.once('close', () => { this.closed = true; this.upstream?.close(); }); }
  wait<T>(start: (done: (error: Error | undefined | null, value: T) => void) => void, source?: EventEmitter): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null, value?: T) => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener('abort', abort);
        this.client.off('close', closed);
        this.client.off('error', failed);
        source?.off('close', closed);
        source?.off('error', failed);
        error ? reject(error) : resolve(value!);
      };
      const abort = () => finish(interrupted(this.signal));
      const closed = () => finish(new SSHError('ssh_error', 'SSH 连接中断，远端状态可能不确定'));
      const failed = () => closed();
      if (this.signal.aborted) { abort(); return; }
      if (this.closed) { closed(); return; }
      this.signal.addEventListener('abort', abort, { once: true });
      this.client.once('close', closed);
      this.client.once('error', failed);
      source?.once('close', closed);
      source?.once('error', failed);
      try { start(finish); } catch (error) { finish(error as Error); }
    });
  }
  close() { if (this.closed) return; this.closed = true; this.client.destroy(); this.upstream?.close(); }
}

export async function dial(server: Readonly<ServerConfig>, config: Config, signal: AbortSignal, deadline = Infinity): Promise<Connection> {
  let jump: Connection | undefined, tunnel: ClientChannel | undefined, hop = server.jumpServerId ?? server.id;
  try {
    if (!server.jumpServerId) return await dialSingle(server, config, signal, deadline);
    const gateway = config.servers.get(server.jumpServerId);
    if (!gateway || gateway.jumpServerId || gateway.id === server.id) throw new SSHError('ssh_server_unknown', '跳板配置无效，仅支持已配置服务器的单跳引用');
    jump = await dialSingle(gateway, config, signal, deadline);
    const upstream = jump, hopDeadline = performance.now() + 15000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; upstream.close(); }, 15000);
    try {
      tunnel = await upstream.wait<ClientChannel>(done => upstream.client.forwardOut('127.0.0.1', 0, server.host, server.port, done));
    } catch (error) {
      if (signal.aborted) { const error = interrupted(signal); throw new SSHError(error.code, error.message, { phase: 'forward', operation_state: 'not_started' }); }
      if (timedOut) throw new SSHError(performance.now() >= deadline ? 'ssh_timeout' : 'ssh_handshake_timeout', '跳板转发连接超过连接上限', { phase: 'forward', operation_state: 'not_started' });
      throw new SSHError('ssh_forward_failed', '跳板服务器无法建立到目标的转发通道，请检查转发权限与目标地址', { phase: 'forward', operation_state: 'not_started' });
    } finally { clearTimeout(timer); }
    hop = server.id;
    const connection = await dialSingle(server, config, signal, deadline, tunnel, upstream, hopDeadline);
    upstream.client.once('close', () => connection.close());
    if (upstream.closed) { connection.close(); throw new SSHError('ssh_handshake_failed', '目标认证期间跳板连接已关闭'); }
    return connection;
  } catch (error) {
    tunnel?.destroy(); jump?.close();
    if (error instanceof SSHError) throw new SSHError(error.code, error.message, { phase: 'credentials', operation_state: 'not_started', ...error.details, hop_server_id: hop });
    throw error;
  }
}

async function dialSingle(server: Readonly<ServerConfig>, config: Config, signal: AbortSignal, deadline: number, transport?: ClientChannel, upstream?: Connection, hopDeadline = performance.now() + 15000): Promise<Connection> {
  if (signal.aborted) throw interrupted(signal);
  const credentials: ConnectConfig = { username: server.username };
  const agent = server.agentSocket ? new ScopedAgent(server.agentSocket, signal) : undefined;
  if (server.privateKeyPath) {
    try {
      const data = await readFile(server.privateKeyPath, { signal });
      const key = utils.parseKey(data, server.passphrase || undefined);
      if (key instanceof Error || !key.isPrivateKey()) throw new Error('无有效私钥');
      credentials.privateKey = data;
      credentials.passphrase = server.passphrase;
    } catch {
      if (signal.aborted) throw interrupted(signal);
      throw new SSHError('ssh_credentials_invalid', 'SSH 私钥无效、无法读取或私钥口令错误');
    }
  } else if (agent) { credentials.agent = agent; credentials.agentForward = false; }
  else credentials.password = server.password;
  return new Promise((resolve, reject) => {
    const client = new SSHClient(), socket = transport ?? new Socket();
    if (socket instanceof Socket) socket.setNoDelay(true);
    let ready = false, settled = false, tcp = !!transport, trustError: Error | undefined, phase = 'connect';
    const abort = () => {
      agent?.dispose();
      client.destroy(); socket.destroy();
      if (!ready) finish(interrupted(signal));
    };
    const timer = setTimeout(() => finish(performance.now() >= deadline ? new SSHError('ssh_timeout', 'SSH 操作超时；远端进程或文件状态可能不确定，请检查后再操作') : new SSHError('ssh_handshake_timeout', 'SSH 连接或认证握手超过 15 秒')), Math.max(0, hopDeadline - performance.now()));
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      agent?.dispose();
      if (error) {
        signal.removeEventListener('abort', abort);
        client.destroy(); socket.destroy();
        const failure = signal.aborted ? interrupted(signal) : error;
        reject(failure instanceof SSHError ? new SSHError(failure.code, failure.message, { phase, operation_state: 'not_started', ...failure.details }) : failure);
      } else {
        ready = true;
        resolve(new Connection(client, signal, upstream));
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    client.on('close', () => {
      signal.removeEventListener('abort', abort);
      if (!ready) finish(trustError ?? new SSHError('ssh_handshake_failed', 'SSH 握手中断，请检查服务器 SSH 配置'));
    });
    client.on('error', (error: Error & { level?: string }) => {
      if (!ready) finish(trustError ?? agent?.failure ?? new SSHError(error.level === 'client-authentication' ? 'ssh_auth_failed' : 'ssh_handshake_failed', error.level === 'client-authentication' ? 'SSH 认证失败，请检查服务器账号和凭据' : 'SSH 握手失败，请检查服务器 SSH 配置'));
    });
    socket.on('error', () => { if (!ready) finish(new SSHError(tcp ? 'ssh_handshake_failed' : 'ssh_connect_failed', tcp ? 'SSH 握手连接中断' : 'SSH TCP 连接失败，请检查网络、地址和端口')); });
    client.once('ready', () => finish());
    client.on('handshake', () => { phase = 'authentication'; });
    const start = () => {
      tcp = true;
      phase = 'handshake';
      try {
        client.connect({ ...credentials, sock: socket, readyTimeout: 0, hostVerifier: (key: Buffer) => {
          phase = 'host_verification';
          if (signal.aborted) { trustError = interrupted(signal); return false; }
          try { verifyHost(config.knownHosts, config.hostKeyPolicy, server.host, server.port, key); return true; }
          catch (error) { trustError = error as Error; return false; }
        } });
      } catch { finish(new SSHError('ssh_handshake_failed', 'SSH 握手无法启动')); }
    };
    if (signal.aborted) abort();
    else if (transport) start();
    else { socket.once('connect', start); (socket as Socket).connect(server.port, server.host); }
  });
}
