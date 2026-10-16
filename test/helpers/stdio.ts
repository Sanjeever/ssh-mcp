import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import { CallToolResultSchema, InitializeResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, InitializeResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const executionOutput = z.object({ server_id: z.string(), duration_ms: z.number(), stdout: z.string(), exit_code: z.number().nullable(), output_truncated: z.boolean() });
export const failureOutput = z.object({ error: z.object({ code: z.string() }) });
export const serversOutput = z.object({ servers: z.array(z.object({ server_id: z.string() })) });
export const transferOutput = z.object({ bytes_transferred: z.number() });

interface Request<T> { id: number; result: Promise<T> }
const responseSchemas = { initialize: InitializeResultSchema, 'tools/list': ListToolsResultSchema, 'tools/call': CallToolResultSchema };

export function startCLI(t: Pick<TestContext, 'after'>, extraEnv: NodeJS.ProcessEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_MCP_')));
  Object.assign(env, { SSH_MCP_SERVER_TEST_HOST: '192.0.2.1', SSH_MCP_SERVER_TEST_USERNAME: 'operator', SSH_MCP_SERVER_TEST_PASSWORD: ' secret ' }, extraEnv);
  const child = spawn(process.execPath, ['dist/cli.js'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let buffer = '', stderr = '', nextID = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const notifications: { method: string; params?: Record<string, unknown> }[] = [];
  const closed = once(child, 'close');
  child.once('close', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('MCP 会话关闭')); } pending.clear(); });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      if (message.method) notifications.push(message);
      const entry = pending.get(message.id);
      if (entry) { clearTimeout(entry.timer); pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
    }
  });
  const send = (message: { id?: number; method: string; params?: Record<string, unknown> }) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  function request(method: 'initialize', params?: Record<string, unknown>): Request<InitializeResult>;
  function request(method: 'tools/list', params?: Record<string, unknown>): Request<ListToolsResult>;
  function request(method: 'tools/call', params?: Record<string, unknown>): Request<CallToolResult>;
  function request(method: keyof typeof responseSchemas, params: Record<string, unknown> = {}) {
    const id = ++nextID;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP 请求超时')); }, 5000);
      pending.set(id, { resolve, reject, timer });
    });
    send({ id, method, params });
    return { id, result: result.then(value => responseSchemas[method].parse(value)) };
  }
  return { child, closed, request, send, notifications: () => notifications, diagnostics: () => stderr, async init() {
    const result = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }).result;
    send({ method: 'notifications/initialized' }); return result;
  } };
}
