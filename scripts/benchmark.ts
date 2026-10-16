import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 以 initialize 响应为终点；命令及参数由调用方提供，可测直接入口或预热后的 npx。
export async function measure(command: string, args: string[], samples = 30) {
  const values: number[] = [];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_MCP_')));
  Object.assign(env, { SSH_MCP_SERVER_BENCH_HOST: '192.0.2.1', SSH_MCP_SERVER_BENCH_USERNAME: 'bench', SSH_MCP_SERVER_BENCH_PASSWORD: 'unused' });
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { child.kill(); reject(new Error('初始化超时')); }, 10000);
      let output = '', diagnostic = '', initialized = false;
      child.on('error', reject);
      child.stderr.on('data', chunk => { diagnostic += chunk; });
      child.stdout.on('data', chunk => {
        output += chunk;
        if (!initialized && output.includes('\n')) {
          try {
            const response = JSON.parse(output.slice(0, output.indexOf('\n')));
            if (response.id !== 1 || !response.result?.serverInfo) throw new Error('初始化失败');
            initialized = true;
            values.push(performance.now() - start);
            child.stdin.end();
          } catch (error) { child.kill(); reject(error); }
        }
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (code || !initialized || diagnostic) reject(new Error(`进程异常退出 ${code} ${diagnostic}`));
        else resolve();
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'benchmark', version: '1' } } }) + '\n');
    });
  }
  values.sort((a, b) => a - b);
  const middle = Math.floor(samples / 2);
  const median = samples % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
  return { samples, median_ms: +median.toFixed(2), p95_ms: +values[Math.ceil(samples * .95) - 1]!.toFixed(2), node: process.version, command, args };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('用法：benchmark.ts <命令> [参数...]');
  console.log(JSON.stringify(await measure(command, args), null, 2));
}
