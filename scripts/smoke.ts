import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CallToolResultSchema, InitializeResultSchema, JSONRPCMessageSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { executionOutput, serversOutput, transferOutput, toolNames } from '../test/helpers/stdio.js';

// 使用实际 stdio 消息检查安装后的可执行文件，测试数据不指向公网服务器。
export async function smoke(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, calls: CallToolRequest['params'][] = []) {
  const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let buffer = '', stderr = '';
  const timer = setTimeout(() => { child.kill(); }, 10_000);
  const responses = new Map<number, unknown>();
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const send = (message: Record<string, unknown>) => child.stdin.write(JSON.stringify(message) + '\n');
  const completed = new Promise<string>((resolve, reject) => {
    child.on('error', reject);
    child.stdout.setEncoding('utf8').on('data', data => {
      buffer += data;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const message = JSONRPCMessageSchema.parse(JSON.parse(line));
          if ('error' in message) throw new Error(JSON.stringify(message.error));
          if (!('result' in message)) continue;
          assert(typeof message.id === 'number');
          responses.set(message.id, message.result);
          if (message.id === 1) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          } else if (message.id === 2) {
            send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ssh_list', arguments: {} } });
          } else if (message.id >= 3) {
            const next = calls[message.id - 3];
            if (next) send({ jsonrpc: '2.0', id: message.id + 1, method: 'tools/call', params: next });
            else child.stdin.end();
          }
        } catch (err) { child.kill(); reject(err); }
      }
    });
    child.on('close', (code, signal) => {
      try {
        assert.equal(code, 0, `进程异常退出 ${signal ?? ''} ${stderr}`);
        assert.equal(buffer, '');
        assert.equal(stderr, '');
        assert.deepEqual(ListToolsResultSchema.parse(responses.get(2)).tools.map(tool => tool.name).sort(), toolNames);
        const list = CallToolResultSchema.parse(responses.get(3));
        assert.equal(list.isError ?? false, false);
        assert(serversOutput.parse(list.structuredContent).servers.some(server => server.server_id === 'smoke'));
        for (const [index, call] of calls.entries()) {
          const response = CallToolResultSchema.parse(responses.get(index + 4)); assert.equal(response.isError, false);
          if (call.name === 'ssh_exec') { const output = executionOutput.parse(response.structuredContent); assert.equal(output.exit_code, 0); assert.equal(output.stdout, call.arguments?.command === 'stdin' ? call.arguments.stdin : 'remote ok\n'); }
          else assert(transferOutput.parse(response.structuredContent).bytes_transferred > 0);
        }
        resolve(InitializeResultSchema.parse(responses.get(1)).serverInfo.version);
      } catch (err) { reject(err); }
    });
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pack-test', version: '1' } } });
  try { return await completed; } finally { clearTimeout(timer); }
}
