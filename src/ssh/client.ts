import { readFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import type { EventEmitter } from 'node:events';
import ssh2 from 'ssh2';
import type { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type { Config, ServerConfig } from '../config.js';
import { SSHError, interrupted } from '../errors.js';
import { verifyHost } from './known-hosts.js';
const { Client: SSHClient, utils } = ssh2;

export class Connection {
  constructor(readonly client: Client, readonly signal: AbortSignal) {}
  wait<T>(start: (done: (error: Error | undefined | null, value: T) => void) => void, source?: EventEmitter): Promise<T> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error | null, value?: T) => {
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
      this.signal.addEventListener('abort', abort, { once: true });
      this.client.once('close', closed);
      this.client.once('error', failed);
      source?.once('close', closed);
      source?.once('error', failed);
      try { start(finish); } catch (error) { finish(error as Error); }
    });
  }
  close() { this.client.destroy(); }
}

export async function dial(server: Readonly<ServerConfig>, config: Config, signal: AbortSignal, deadline = Infinity): Promise<Connection> {
  if (signal.aborted) throw interrupted(signal);
  const credentials: ConnectConfig = { username: server.username };
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
  } else credentials.password = server.password;
  return new Promise((resolve, reject) => {
    const client = new SSHClient(), socket = new Socket();
    socket.setNoDelay(true);
    let ready = false, tcp = false, trustError: Error | undefined, phase = 'connect';
    const abort = () => {
      client.destroy(); socket.destroy();
      if (!ready) finish(interrupted(signal));
    };
    const timer = setTimeout(() => finish(performance.now() >= deadline ? new SSHError('ssh_timeout', 'SSH 操作超时；远端进程或文件状态可能不确定，请检查后再操作') : new SSHError('ssh_handshake_timeout', 'SSH 连接或认证握手超过 15 秒')), 15000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      if (error) {
        signal.removeEventListener('abort', abort);
        client.destroy(); socket.destroy();
        const failure = signal.aborted ? interrupted(signal) : error;
        reject(failure instanceof SSHError ? new SSHError(failure.code, failure.message, { phase, operation_state: 'not_started', ...failure.details }) : failure);
      } else {
        ready = true;
        resolve(new Connection(client, signal));
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    client.on('close', () => {
      signal.removeEventListener('abort', abort);
      if (!ready) finish(trustError ?? new SSHError('ssh_handshake_failed', 'SSH 握手中断，请检查服务器 SSH 配置'));
    });
    client.on('error', (error: Error & { level?: string }) => {
      if (!ready) finish(trustError ?? new SSHError(error.level === 'client-authentication' ? 'ssh_auth_failed' : 'ssh_handshake_failed', error.level === 'client-authentication' ? 'SSH 认证失败，请检查服务器账号和凭据' : 'SSH 握手失败，请检查服务器 SSH 配置'));
    });
    socket.on('error', () => { if (!ready) finish(new SSHError(tcp ? 'ssh_handshake_failed' : 'ssh_connect_failed', tcp ? 'SSH 握手连接中断' : 'SSH TCP 连接失败，请检查网络、地址和端口')); });
    client.once('ready', () => finish());
    client.on('handshake', () => { phase = 'authentication'; });
    socket.once('connect', () => {
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
    });
    if (signal.aborted) abort();
    else socket.connect(server.port, server.host);
  });
}
