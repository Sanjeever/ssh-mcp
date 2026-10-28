#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--version') { process.stdout.write(version + '\n'); return; }
  const usage = '用法：ssh-mcp [--env-file <路径>] 或 ssh-mcp --version';
  let envFile: string | undefined;
  try {
    const { values } = parseArgs({ args, options: { 'env-file': { type: 'string', multiple: true } } });
    const files = values['env-file'];
    if (files && (files.length !== 1 || !files[0])) throw new Error(usage);
    envFile = files?.[0];
  } catch { throw new Error(usage); }
  const config = loadConfig(process.env, envFile);
  const [{ createServer }, { StdioServerTransport }] = await Promise.all([import('./server.js'), import('@modelcontextprotocol/sdk/server/stdio.js')]);
  const root = new AbortController();
  const server = createServer(config, version, root.signal);
  let closing: Promise<void> | undefined;
  const close = () => {
    root.abort();
    closing ??= server.close();
    closing.catch(() => { process.stderr.write('MCP stdio 会话关闭失败\n'); process.exitCode = 1; });
  };
  process.stdin.once('end', close);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  server.onclose = () => root.abort();
  server.onerror = () => { process.stderr.write('MCP stdio 协议错误\n'); };
  await server.connect(new StdioServerTransport());
}
main().catch(error => { process.stderr.write((error instanceof Error ? error.message : 'MCP 启动失败') + '\n'); process.exitCode = 1; });
