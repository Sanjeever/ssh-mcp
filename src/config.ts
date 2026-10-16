import { statSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ServerConfig {
  id: string;
  description: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  agentSocket?: string;
}
export interface Config {
  servers: ReadonlyMap<string, Readonly<ServerConfig>>;
  hostKeyPolicy: 'accept_new' | 'strict';
  knownHosts: string;
}

export function resolvePath(value: string): string {
  if (!value || value.includes('\0')) throw new Error('路径不能为空或包含空字节');
  if (value === '~') return homedir();
  if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) return join(homedir(), value.slice(2));
  if (value.startsWith('~')) throw new Error('不支持命名用户主目录写法');
  return resolve(value);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const fields = ['PRIVATE_KEY_PATH', 'AGENT_SOCKET', 'DESCRIPTION', 'PASSPHRASE', 'USERNAME', 'PASSWORD', 'HOST', 'PORT'];
  const groups = new Map<string, Record<string, string>>();
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('SSH_MCP_SERVER_') || value === undefined) continue;
    const rest = name.slice('SSH_MCP_SERVER_'.length);
    const field = fields.find(field => rest.endsWith(`_${field}`));
    if (!field) throw new Error('服务器环境变量包含未知字段（名称未显示以保护凭据）');
    const id = rest.slice(0, -field.length - 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(id)) throw new Error('服务器 ID 必须以大写字母开头，且仅含大写字母、数字和下划线');
    if (!groups.has(id)) groups.set(id, {});
    groups.get(id)![field] = value;
  }
  const policy = env.SSH_MCP_HOST_KEY_POLICY ?? 'accept_new';
  if (policy !== 'accept_new' && policy !== 'strict') throw new Error('SSH_MCP_HOST_KEY_POLICY 必须为 accept_new 或 strict');
  const knownHosts = resolvePath(env.SSH_MCP_KNOWN_HOSTS ?? '~/.ssh/known_hosts');
  if (!groups.size) throw new Error('至少需要配置一台 SSH 服务器');
  const servers = new Map<string, Readonly<ServerConfig>>();
  for (const id of [...groups.keys()].sort()) {
    const g = groups.get(id)!;
    const server: ServerConfig = { id: id.toLowerCase(), host: g.HOST?.trim() ?? '', username: g.USERNAME?.trim() ?? '', port: 22, description: g.DESCRIPTION ?? '' };
    if (!server.host || !server.username) throw new Error(`服务器 ${server.id} 缺少 HOST 或 USERNAME`);
    if (/[ /\\\t\r\n\0]/.test(server.host) || (server.host.includes(':') && !isIP(server.host))) throw new Error(`服务器 ${server.id} 的 HOST 必须是主机名或 IP，端口须单独配置`);
    if (g.PORT !== undefined) {
      server.port = Number(g.PORT);
      if (!/^[+-]?\d+$/.test(g.PORT) || !Number.isInteger(server.port) || server.port < 1 || server.port > 65535) throw new Error(`服务器 ${server.id} 的 PORT 必须为 1–65535 的整数`);
    }
    const password = g.PASSWORD !== undefined, key = g.PRIVATE_KEY_PATH !== undefined, agent = g.AGENT_SOCKET !== undefined;
    if (Number(password) + Number(key) + Number(agent) !== 1 || (password && !g.PASSWORD) || (key && !g.PRIVATE_KEY_PATH?.trim()) || (agent && !g.AGENT_SOCKET)) throw new Error(`服务器 ${server.id} 必须配置 PASSWORD、PRIVATE_KEY_PATH 或 AGENT_SOCKET，三者互斥且不能为空`);
    if (g.PASSPHRASE !== undefined && !key) throw new Error(`服务器 ${server.id} 的 PASSPHRASE 仅适用于私钥认证`);
    server.password = g.PASSWORD;
    server.passphrase = g.PASSPHRASE;
    if (agent) {
      const endpoint = g.AGENT_SOCKET!;
      if (endpoint.includes('\0') || (process.platform === 'win32' ? !endpoint.startsWith('\\\\.\\pipe\\') : !endpoint.startsWith('/') && !endpoint.startsWith('~/'))) throw new Error(`服务器 ${server.id} 的 AGENT_SOCKET 须为 Unix socket 路径或 Windows OpenSSH named pipe，不支持 Pageant/Cygwin`);
      server.agentSocket = process.platform === 'win32' ? endpoint : resolvePath(endpoint);
    }
    if (key) {
      server.privateKeyPath = resolvePath(g.PRIVATE_KEY_PATH!);
      try { if (!statSync(server.privateKeyPath).isFile()) throw new Error(); }
      catch { throw new Error(`服务器 ${server.id} 的私钥文件不存在、不可访问或不是普通文件`); }
    }
    servers.set(server.id, Object.freeze(server));
  }
  return Object.freeze({ servers, hostKeyPolicy: policy, knownHosts });
}
