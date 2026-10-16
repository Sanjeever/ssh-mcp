import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CallToolResultSchema, InitializeResultSchema, JSONRPCMessageSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { executionOutput, serversOutput, transferOutput, toolNames, failureOutput } from '../test/helpers/stdio.js';

export interface SmokeStep { request: CallToolRequest['params'] | ((results: CallToolResult[]) => CallToolRequest['params']); error_code?: string }

// 使用实际 stdio 消息检查安装后的可执行文件，测试数据不指向公网服务器。
export async function smoke(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, calls: SmokeStep[] = []) {
  const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let buffer = '', stderr = '';
  const timer = setTimeout(() => { child.kill(); }, 20_000);
  const responses = new Map<number, unknown>();
  const results: CallToolResult[] = [];
  const executed: Array<{ call: CallToolRequest['params']; step: SmokeStep }> = [];
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
            if (message.id >= 4) results.push(CallToolResultSchema.parse(message.result));
            const next = calls[message.id - 3];
            if (next) {
              const call = typeof next.request === 'function' ? next.request(results) : next.request;
              executed.push({ call, step: next });
              send({ jsonrpc: '2.0', id: message.id + 1, method: 'tools/call', params: call });
            }
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
        for (const [index, { call, step }] of executed.entries()) {
          const response = CallToolResultSchema.parse(responses.get(index + 4));
          if (step.error_code) { assert.equal(response.isError, true); assert.equal(failureOutput.parse(response.structuredContent).error.code, step.error_code); continue; }
          assert.equal(response.isError, false);
          if (call.name === 'ssh_exec') { const output = executionOutput.parse(response.structuredContent); assert.equal(output.exit_code, 0); assert.equal(output.stdout, call.arguments?.command === 'stdin' ? call.arguments.stdin : 'remote ok\n'); }
          else if (call.name === 'ssh_upload' || call.name === 'ssh_download') assert(transferOutput.parse(response.structuredContent).bytes_transferred > 0);
          else if (call.name === 'ssh_probe') assert.equal(response.structuredContent?.ssh, true);
          else if (call.name === 'ssh_read_file') assert.equal(response.structuredContent?.content, '隔离安装 SFTP 往返');
          else if (call.name === 'ssh_output') assert.equal(response.structuredContent?.text, 'remote ok\n');
          else if (call.name === 'ssh_output_forget') assert.equal(response.structuredContent?.forgotten, true);
          else { assert.equal(typeof response.structuredContent?.task_id, 'string'); if (call.name === 'ssh_task_cancel') assert.equal(response.structuredContent?.cancel_requested, true); }
        }
        resolve(InitializeResultSchema.parse(responses.get(1)).serverInfo.version);
      } catch (err) { reject(err); }
    });
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pack-test', version: '1' } } });
  try { return await completed; } finally { clearTimeout(timer); }
}
