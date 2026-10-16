import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { SSHError, operationSignal } from './errors.js';
import type { OperationContext } from './errors.js';
import { dial } from './ssh/client.js';
import { exec, createExecResult, MAX_STDIN_BYTES } from './ssh/exec.js';
import { transfer, validatePaths } from './ssh/transfer.js';
import type { TransferResult } from './ssh/transfer.js';
import { OutputStore } from './output-store.js';
import { probe } from './ssh/probe.js';

const selection = {
  server_id: z.string().regex(/^[a-z][a-z0-9_]*$/).describe('ssh_list 返回的精确 server_id，不自动选择目标'),
  timeout_seconds: z.number().int().min(1).max(3600).default(180).describe('调用总超时秒数，每跳连接与认证另设 15 秒上限'),
};
const execInput = z.strictObject({
  ...selection,
  command: z.string().min(1).describe('交给远端默认 Shell 解释，不经过本机 Shell'),
  stdin: z.string().superRefine((value, context) => { if (Buffer.byteLength(value) > MAX_STDIN_BYTES) context.addIssue({ code: 'too_big', origin: 'string', maximum: MAX_STDIN_BYTES, inclusive: true, message: 'stdin 编码后不能超过 1 MiB' }); }).optional().describe('可选 UTF-8 标准输入，最多 1 MiB；发送后关闭输入端'),
  output_mode: z.enum(['head', 'tail', 'head_tail']).default('head_tail').describe('输出超限时保留头部、尾部或两端'),
  stdout_max_bytes: z.number().int().min(256).max(96 * 1024).default(96 * 1024).describe('本次结果的 stdout 字节预算'),
  stderr_max_bytes: z.number().int().min(256).max(32 * 1024).default(32 * 1024).describe('本次结果的 stderr 字节预算'),
  save_output: z.boolean().default(false).describe('显式保存会话内输出以供 ssh_output 分页读取；每流最多 4 MiB，完成后保留 10 分钟，会话最多 8 份'),
});
const errorSchema = z.object({ code: z.string(), message: z.string(), phase: z.string().optional(), reason: z.string().optional(), operation_state: z.enum(['not_started', 'may_have_started', 'completed']).optional(), hop_server_id: z.string().optional(), issues: z.array(z.object({ path: z.array(z.string()), code: z.string(), expected: z.string().optional(), minimum: z.number().optional(), maximum: z.number().optional() })).optional() });
const validationOutput = z.object({ error: errorSchema });
const outputInput = z.strictObject({ output_id: z.string().uuid(), stream: z.enum(['stdout', 'stderr']).default('stdout'), offset: z.number().int().min(0).default(0), max_bytes: z.number().int().min(256).max(96 * 1024).default(16 * 1024) });
const probeInput = z.strictObject(selection);
const transferInput = z.strictObject({ ...selection, local_path: z.string().min(1).describe('MCP 进程所在机器的绝对文件路径，父目录须存在'), remote_path: z.string().regex(/^\//).describe('远端 SFTP 绝对文件路径，不展开 ~ 或环境变量，父目录须存在'), overwrite: z.boolean().default(false) });
const uploadInput = z.strictObject({ ...transferInput.shape, atomic: z.boolean().default(false).describe('写同目录临时文件后原子发布，须服务器支持对应 OpenSSH 扩展；不支持时失败') });
const transferOutput = z.object({ server_id: z.string(), local_path: z.string(), remote_path: z.string(), bytes_transferred: z.number().int(), duration_ms: z.number().int(), publication_state: z.enum(['not_published', 'unknown', 'published']).optional(), temporary_path: z.string().optional(), cleanup_pending: z.boolean().optional(), error: errorSchema.optional() });
const definitions = [
  { name: 'ssh_list', description: '列出配置中的 SSH 服务器、认证类型与可选跳板 ID，按 server_id 排序，不联网探测，不返回凭据。远端操作前使用精确 server_id 选择目标。', input: z.strictObject({}), output: z.object({ servers: z.array(z.object({ server_id: z.string(), description: z.string(), host: z.string(), port: z.number().int(), username: z.string(), auth_type: z.enum(['password', 'private_key', 'agent']), jump_server_id: z.string().optional() })) }) },
  { name: 'ssh_probe', description: '显式连接所选服务器，验证主机信任、认证及 SFTP 能力，返回主机密钥指纹和原子发布扩展支持。不开 Shell、不写远端文件；accept_new 仍可能追加本机 known_hosts。', input: probeInput, output: z.object({ server_id: z.string(), duration_ms: z.number().int(), ssh: z.boolean(), host_key_fingerprint: z.string().optional(), sftp: z.object({ available: z.boolean(), atomic_overwrite: z.boolean().optional(), atomic_no_overwrite: z.boolean().optional(), reason: z.string().optional() }).optional(), error: errorSchema.optional() }) },
  { name: 'ssh_exec', description: '通过独立 SSH exec 执行远端命令，可提供最多 1 MiB UTF-8 stdin，无 PTY、无持续 Shell、不自动输入 sudo 密码。stdout 最多 96 KiB、stderr 最多 32 KiB，可降低预算，默认保留两端，超限继续排空。save_output=true 可分页读取保存的输出。超时或取消后远端状态可能不确定，不自动重试。', input: execInput, output: z.object({ server_id: z.string(), stdout: z.string(), stderr: z.string(), exit_code: z.number().int().nullable(), exit_signal: z.string().nullable(), duration_ms: z.number().int(), output_truncated: z.boolean(), stdout_truncated: z.boolean(), stderr_truncated: z.boolean(), stdout_bytes: z.number().int(), stderr_bytes: z.number().int(), stdout_omitted_bytes: z.number().int(), stderr_omitted_bytes: z.number().int(), output_id: z.string().optional(), error: errorSchema.optional() }) },
  { name: 'ssh_output', description: '按字节偏移读取当前 MCP 会话显式保存的命令输出，不连接远端、不重复执行命令。使用 next_offset 继续读取，保存上限与实际接收量分别报告。', input: outputInput, output: z.object({ output_id: z.string(), stream: z.enum(['stdout', 'stderr']), offset: z.number().int(), next_offset: z.number().int(), text: z.string(), available_bytes: z.number().int(), total_bytes: z.number().int(), storage_truncated: z.boolean(), finished: z.boolean(), eof: z.boolean() }) },
  { name: 'ssh_upload', description: '通过 SFTP 上传单个普通文件，最大 128 MiB，默认禁止覆盖，不创建父目录。路径须为绝对路径，不展开 ~。atomic=true 使用同目录临时文件发布，保留普通权限及 uid/gid，不保留 ACL、扩展属性或硬链接关系；默认直接上传，失败可能遗留部分文件。', input: uploadInput, output: transferOutput },
  { name: 'ssh_download', description: '通过 SFTP 下载单个普通文件，最大 128 MiB，默认禁止覆盖，不创建父目录。local_path 使用本机绝对路径，remote_path 使用远端绝对路径，不展开 ~。下载先写同目录临时文件，完整完成后发布，失败保留原目标。', input: transferInput, output: transferOutput },
];
const respond = (data: Record<string, unknown>, isError = false) => ({ isError, structuredContent: data, content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

export function createServer(config: Config, version: string, root: AbortSignal) {
  const outputs = new OutputStore();
  root.addEventListener('abort', () => outputs.clear(), { once: true });
  const server = new Server({ name: 'ssh-mcp', version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.map(d => ({ name: d.name, description: d.description, annotations: { readOnlyHint: ['ssh_list', 'ssh_output'].includes(d.name), destructiveHint: !['ssh_list', 'ssh_output'].includes(d.name), idempotentHint: ['ssh_list', 'ssh_output'].includes(d.name), openWorldHint: !['ssh_list', 'ssh_output'].includes(d.name) }, inputSchema: z.toJSONSchema(d.input, { io: 'input' }), outputSchema: { type: 'object' as const, anyOf: [z.toJSONSchema(d.output), z.toJSONSchema(validationOutput)] } })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const definition = definitions.find(d => d.name === request.params.name);
    if (!definition) throw new McpError(ErrorCode.InvalidParams, '未知工具，请使用 tools/list 返回的工具名称');
    const parsed = definition.input.safeParse(request.params.arguments ?? {});
    if (!parsed.success) return respond({ error: { code: 'ssh_input_invalid', message: '工具参数无效，请检查字段类型、取值范围和未知参数', phase: 'validation', operation_state: 'not_started', issues: parsed.error.issues.map(issue => ({ path: issue.path.map(String), code: issue.code, ...('expected' in issue ? { expected: issue.expected } : {}), ...('minimum' in issue && typeof issue.minimum === 'number' ? { minimum: issue.minimum } : {}), ...('maximum' in issue && typeof issue.maximum === 'number' ? { maximum: issue.maximum } : {}) })) } }, true);
    if (request.params.name === 'ssh_list') return respond({ servers: [...config.servers.values()].map(s => ({ server_id: s.id, description: s.description, host: s.host, port: s.port, username: s.username, auth_type: s.agentSocket ? 'agent' : s.privateKeyPath ? 'private_key' : 'password', ...(s.jumpServerId ? { jump_server_id: s.jumpServerId } : {}) })) });
    if (request.params.name === 'ssh_output') {
      const input = outputInput.parse(request.params.arguments);
      try { return respond(outputs.read(input.output_id, input.stream, input.offset, input.max_bytes)); }
      catch (error) { if (error instanceof SSHError) return respond({ error: { code: error.code, message: error.message, ...error.details } }, true); throw error; }
    }
    const input = request.params.name === 'ssh_probe' ? { kind: 'probe' as const, ...probeInput.parse(request.params.arguments) } : request.params.name === 'ssh_upload' ? { kind: 'upload' as const, ...uploadInput.parse(request.params.arguments) } : request.params.name === 'ssh_download' ? { kind: 'download' as const, ...transferInput.parse(request.params.arguments) } : { kind: 'exec' as const, ...execInput.parse(request.params.arguments) };
    const start = performance.now(), op = operationSignal(AbortSignal.any([root, extra.signal]), input.timeout_seconds);
    const execution = createExecResult();
    const progress: TransferResult = { bytes_transferred: 0 };
    let capabilities: Record<string, unknown> = { ssh: false };
    const token = request.params._meta?.progressToken;
    let lastProgress = -Infinity, lastBytes = 0;
    const notifyProgress = async (bytes: number, final = false) => {
      if (token === undefined || op.signal.aborted || bytes <= lastBytes || !final && performance.now() - lastProgress < 250) return;
      lastProgress = performance.now(); lastBytes = bytes;
      await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: bytes, message: '文件传输' } });
    };
    const context: OperationContext = { phase: 'validation', operation_state: 'not_started' };
    let error: Record<string, unknown> | undefined;
    let outputId: string | undefined;
    try {
      if ('local_path' in input) validatePaths(input.local_path, input.remote_path);
      const target = config.servers.get(input.server_id);
      if (!target) throw new SSHError('ssh_server_unknown', '未知 server_id，请使用 ssh_list 返回的精确 ID');
      if ('save_output' in input && input.save_output) outputId = outputs.create();
      context.phase = 'connect';
      const connection = await dial(target, config, op.signal, op.deadline);
      try {
        if ('local_path' in input) {
          await transfer(connection, request.params.name === 'ssh_upload' ? 'upload' : 'download', input.local_path, input.remote_path, input.overwrite, progress, context, { atomic: 'atomic' in input && input.atomic === true, onProgress: bytes => notifyProgress(bytes) });
          await notifyProgress(progress.bytes_transferred, true);
        }
        else if ('command' in input) await exec(connection, input.command, execution, context, { ...input, onOutput: outputId ? (stream, data) => outputs.append(outputId!, stream, data) : undefined });
        else { context.phase = 'probe'; capabilities = { ssh: true, host_key_fingerprint: connection.hostKeyFingerprint }; capabilities = await probe(connection); context.operation_state = 'completed'; }
      } finally { connection.close(); }
    } catch (failure) {
      error = failure instanceof SSHError ? { code: failure.code, message: failure.message, ...context, ...failure.details } : { code: 'ssh_error', message: 'SSH 操作失败，请检查操作阶段与状态后再操作', ...context };
    } finally { op.dispose(); if (outputId) outputs.finish(outputId); }
    const result = { server_id: input.server_id, duration_ms: Math.floor(performance.now() - start), ...('local_path' in input ? { local_path: input.local_path, remote_path: input.remote_path, ...progress } : 'command' in input ? execution : capabilities) };
    return respond({ ...result, ...(outputId ? { output_id: outputId } : {}), ...(error ? { error } : {}) }, !!error);
  });
  return server;
}
