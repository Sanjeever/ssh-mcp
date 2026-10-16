import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { SSHError, operationSignal } from './errors.js';
import type { OperationContext } from './errors.js';
import { dial } from './ssh/client.js';
import { exec } from './ssh/exec.js';
import { transfer, validatePaths } from './ssh/transfer.js';

const selection = {
  server_id: z.string().regex(/^[a-z][a-z0-9_]*$/).describe('ssh_list 返回的精确 server_id，不自动选择目标'),
  timeout_seconds: z.number().int().min(1).max(3600).default(180).describe('调用总超时秒数，连接与认证另设 15 秒上限'),
};
const execInput = z.strictObject({ ...selection, command: z.string().min(1).describe('交给远端默认 Shell 解释，不经过本机 Shell') });
const errorSchema = z.object({ code: z.string(), message: z.string(), phase: z.string().optional(), reason: z.string().optional(), operation_state: z.enum(['not_started', 'may_have_started', 'completed']).optional(), hop_server_id: z.string().optional(), issues: z.array(z.object({ path: z.array(z.string()), code: z.string(), expected: z.string().optional(), minimum: z.number().optional(), maximum: z.number().optional() })).optional() });
const validationOutput = z.object({ error: errorSchema });
const transferInput = z.strictObject({ ...selection, local_path: z.string().min(1).describe('MCP 进程所在机器的绝对文件路径，父目录须存在'), remote_path: z.string().regex(/^\//).describe('远端 SFTP 绝对文件路径，不展开 ~ 或环境变量，父目录须存在'), overwrite: z.boolean().default(false) });
const transferOutput = z.object({ server_id: z.string(), local_path: z.string(), remote_path: z.string(), bytes_transferred: z.number().int(), duration_ms: z.number().int(), error: errorSchema.optional() });
const definitions = [
  { name: 'ssh_list', description: '列出配置中的 SSH 服务器与认证类型，按 server_id 排序，不联网探测，不返回凭据。远端操作前使用精确 server_id 选择目标。', input: z.strictObject({}), output: z.object({ servers: z.array(z.object({ server_id: z.string(), description: z.string(), host: z.string(), port: z.number().int(), username: z.string(), auth_type: z.enum(['password', 'private_key']) })) }) },
  { name: 'ssh_exec', description: '通过独立 SSH exec 执行远端命令，无 PTY、无持续 Shell、不自动输入 sudo 密码。stdout/stderr 合计保留 128 KiB，超出后排空。超时或取消后远端状态可能不确定，不自动重试。', input: execInput, output: z.object({ server_id: z.string(), stdout: z.string(), stderr: z.string(), exit_code: z.number().int().nullable(), duration_ms: z.number().int(), output_truncated: z.boolean(), error: errorSchema.optional() }) },
  { name: 'ssh_upload', description: '通过 SFTP 上传单个普通文件，最大 128 MiB，默认禁止覆盖，不创建父目录。local_path 使用本机绝对路径，remote_path 使用远端绝对路径，不展开 ~。上传失败可能遗留远端部分文件。', input: transferInput, output: transferOutput },
  { name: 'ssh_download', description: '通过 SFTP 下载单个普通文件，最大 128 MiB，默认禁止覆盖，不创建父目录。local_path 使用本机绝对路径，remote_path 使用远端绝对路径，不展开 ~。下载先写同目录临时文件，完整完成后发布，失败保留原目标。', input: transferInput, output: transferOutput },
];
const respond = (data: Record<string, unknown>, isError = false) => ({ isError, structuredContent: data, content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

export function createServer(config: Config, version: string, root: AbortSignal) {
  const server = new Server({ name: 'ssh-mcp', version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.map(d => ({ name: d.name, description: d.description, annotations: { readOnlyHint: d.name === 'ssh_list', destructiveHint: d.name !== 'ssh_list', idempotentHint: d.name === 'ssh_list', openWorldHint: d.name !== 'ssh_list' }, inputSchema: z.toJSONSchema(d.input, { io: 'input' }), outputSchema: { type: 'object' as const, anyOf: [z.toJSONSchema(d.output), z.toJSONSchema(validationOutput)] } })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const definition = definitions.find(d => d.name === request.params.name);
    if (!definition) throw new McpError(ErrorCode.InvalidParams, '未知工具，请使用 tools/list 返回的工具名称');
    const parsed = definition.input.safeParse(request.params.arguments ?? {});
    if (!parsed.success) return respond({ error: { code: 'ssh_input_invalid', message: '工具参数无效，请检查字段类型、取值范围和未知参数', phase: 'validation', operation_state: 'not_started', issues: parsed.error.issues.map(issue => ({ path: issue.path.map(String), code: issue.code, ...('expected' in issue ? { expected: issue.expected } : {}), ...('minimum' in issue && typeof issue.minimum === 'number' ? { minimum: issue.minimum } : {}), ...('maximum' in issue && typeof issue.maximum === 'number' ? { maximum: issue.maximum } : {}) })) } }, true);
    if (request.params.name === 'ssh_list') return respond({ servers: [...config.servers.values()].map(s => ({ server_id: s.id, description: s.description, host: s.host, port: s.port, username: s.username, auth_type: s.privateKeyPath ? 'private_key' : 'password' })) });
    const isTransfer = request.params.name !== 'ssh_exec';
    const input = isTransfer ? transferInput.parse(request.params.arguments) : execInput.parse(request.params.arguments);
    const start = performance.now(), op = operationSignal(AbortSignal.any([root, extra.signal]), input.timeout_seconds);
    const execution = { stdout: '', stderr: '', exit_code: null as number | null, output_truncated: false };
    const progress = { bytes_transferred: 0 };
    const context: OperationContext = { phase: 'validation', operation_state: 'not_started' };
    let error: Record<string, unknown> | undefined;
    try {
      if ('local_path' in input) validatePaths(input.local_path, input.remote_path);
      const target = config.servers.get(input.server_id);
      if (!target) throw new SSHError('ssh_server_unknown', '未知 server_id，请使用 ssh_list 返回的精确 ID');
      context.phase = 'connect';
      const connection = await dial(target, config, op.signal, op.deadline);
      try {
        if ('local_path' in input) await transfer(connection, request.params.name === 'ssh_upload' ? 'upload' : 'download', input.local_path, input.remote_path, input.overwrite, progress, context);
        else await exec(connection, input.command, execution, context);
      } finally { connection.close(); }
    } catch (failure) {
      error = failure instanceof SSHError ? { code: failure.code, message: failure.message, ...context, ...failure.details } : { code: 'ssh_error', message: 'SSH 操作失败，请检查操作阶段与状态后再操作', ...context };
    } finally { op.dispose(); }
    const result = { server_id: input.server_id, duration_ms: Math.floor(performance.now() - start), ...('local_path' in input ? { local_path: input.local_path, remote_path: input.remote_path, ...progress } : execution) };
    return respond({ ...result, ...(error ? { error } : {}) }, !!error);
  });
  return server;
}
