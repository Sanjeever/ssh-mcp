import { spawn } from 'node:child_process';
import { once } from 'node:events';

export function startCLI(t, extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_MCP_')));
  Object.assign(env, { SSH_MCP_SERVER_TEST_HOST: '192.0.2.1', SSH_MCP_SERVER_TEST_USERNAME: 'operator', SSH_MCP_SERVER_TEST_PASSWORD: ' secret ' }, extraEnv);
  const child = spawn(process.execPath, ['dist/cli.js'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let buffer = '', stderr = '', nextID = 0;
  const pending = new Map();
  const closed = once(child, 'close');
  child.once('close', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('MCP 会话关闭')); } pending.clear(); });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      const entry = pending.get(message.id);
      if (entry) { clearTimeout(entry.timer); pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
    }
  });
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  function request(method, params = {}) {
    const id = ++nextID;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP 请求超时')); }, 5000);
      pending.set(id, { resolve, reject, timer });
    });
    send({ id, method, params });
    return { id, result };
  }
  return { child, closed, request, send, diagnostics: () => stderr, async init() {
    const result = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }).result;
    send({ method: 'notifications/initialized' }); return result;
  } };
}
