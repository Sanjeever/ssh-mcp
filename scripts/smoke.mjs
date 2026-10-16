import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// 使用实际 stdio 消息检查安装后的可执行文件，测试数据不指向公网服务器。
export async function smoke(command, args, env, cwd) {
  const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let buffer = '', stderr = '';
  const timer = setTimeout(() => { child.kill(); }, 10_000);
  const responses = new Map();
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.setEncoding('utf8').on('data', data => {
      buffer += data;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (!message.id) continue;
          if (message.error) throw new Error(JSON.stringify(message.error));
          responses.set(message.id, message.result);
          if (message.id === 1) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          } else if (message.id === 2) {
            send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ssh_list', arguments: {} } });
          } else if (message.id === 3) child.stdin.end();
        } catch (err) { child.kill(); reject(err); }
      }
    });
    child.on('close', (code, signal) => {
      try {
        assert.equal(code, 0, `进程异常退出 ${signal ?? ''} ${stderr}`);
        assert.equal(buffer, '');
        assert.equal(stderr, '');
        assert.equal(responses.get(2)?.tools.length, 4);
        assert.equal(responses.get(3)?.isError ?? false, false);
        assert.equal(responses.get(3)?.structuredContent?.servers[0]?.server_id, 'smoke');
        resolve(responses.get(1).serverInfo.version);
      } catch (err) { reject(err); }
    });
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pack-test', version: '1' } } });
  try { return await completed; } finally { clearTimeout(timer); }
}
