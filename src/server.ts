import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { SSHError, operationSignal, operationError, interrupted } from './errors.js';
import type { OperationContext } from './errors.js';
import { dial } from './ssh/client.js';
import { exec, createExecResult, MAX_STDIN_BYTES } from './ssh/exec.js';
import { transfer, validatePaths } from './ssh/transfer.js';
import type { TransferResult } from './ssh/transfer.js';
import { OutputStore } from './output-store.js';
import { probe } from './ssh/probe.js';
import { readText, textLines, editText, validateRemotePath, MAX_TEXT_BYTES } from './ssh/text.js';
import { TaskStore } from './tasks.js';
import { OperationScheduler } from './scheduler.js';

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
const execOutput = z.object({ server_id: z.string(), stdout: z.string(), stderr: z.string(), exit_code: z.number().int().nullable(), exit_signal: z.string().nullable(), duration_ms: z.number().int(), output_truncated: z.boolean(), stdout_truncated: z.boolean(), stderr_truncated: z.boolean(), stdout_bytes: z.number().int(), stderr_bytes: z.number().int(), stdout_omitted_bytes: z.number().int(), stderr_omitted_bytes: z.number().int(), output_id: z.string().optional(), error: errorSchema.optional() });
const startInput = execInput.omit({ save_output: true });
const taskInput = z.strictObject({ task_id: z.string().uuid() });
const waitSeconds = z.number().int().min(0).max(30).default(0).describe('最多等待秒数，0 立即返回；取消等待不会取消原操作');
const statusInput = taskInput.extend({ wait_seconds: waitSeconds });
const taskOutput = z.object({ task_id: z.string(), server_id: z.string(), output_id: z.string(), status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']), phase: z.string(), operation_state: z.enum(['not_started', 'may_have_started', 'completed']), started_at: z.string(), cancel_requested: z.boolean(), expires_at: z.string().optional(), result: execOutput.optional() });
const outputInput = z.strictObject({ output_id: z.string().uuid(), stream: z.enum(['stdout', 'stderr']).default('stdout'), offset: z.number().int().min(0).optional().describe('从原始字节偏移读取，默认 0；与 tail=true 互斥'), tail: z.boolean().default(false).describe('读取已保存内容末尾最多 max_bytes 字节，与 offset 互斥；保存截断时不代表远端输出末尾'), max_bytes: z.number().int().min(256).max(96 * 1024).default(16 * 1024), wait_seconds: waitSeconds }).refine(value => !value.tail || value.offset === undefined, 'tail=true 不能同时指定 offset');
const forgetInput = z.strictObject({ output_id: z.string().uuid() });
const probeInput = z.strictObject(selection);
const textInput = z.strictObject({ ...selection, remote_path: z.string().regex(/^\//), start_line: z.number().int().min(1).default(1), line_count: z.number().int().min(1).max(1000).default(200) });
const textValue = z.string().refine(value => !value.includes('\0'), '文本不能包含 NUL').superRefine((value, context) => { if (Buffer.byteLength(value) > MAX_TEXT_BYTES) context.addIssue({ code: 'too_big', origin: 'string', maximum: MAX_TEXT_BYTES, inclusive: true, message: '文本编码后不能超过 1 MiB' }); });
const oldText = textValue.refine(value => value.length > 0, 'old_text 不能为空');
const editPair = z.strictObject({ old_text: oldText, new_text: textValue }).refine(value => value.old_text !== value.new_text, '新旧文本不能相同');
const editInput = z.strictObject({
  ...selection,
  remote_path: z.string().regex(/^\//),
  old_text: oldText.optional(),
  new_text: textValue.optional(),
  edits: z.array(editPair).min(1).max(100).superRefine((edits, context) => {
    if (edits.reduce((bytes, edit) => bytes + Buffer.byteLength(edit.old_text) + Buffer.byteLength(edit.new_text), 0) > 2 * MAX_TEXT_BYTES) context.addIssue({ code: 'too_big', origin: 'string', maximum: 2 * MAX_TEXT_BYTES, inclusive: true, message: '批量新旧文本编码后合计不能超过 2 MiB' });
  }).optional().describe('1–100 项，全部匹配同一原始版本且范围不重叠；新旧文本合计最多 2 MiB，与顶层 old_text/new_text 二选一'),
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/).describe('ssh_read_file 返回的 revision；发布前再次核对，不能代替远端写入者之间的锁'),
}).refine(value => value.edits !== undefined ? value.old_text === undefined && value.new_text === undefined : value.old_text !== undefined && value.new_text !== undefined && value.old_text !== value.new_text, '须提供一组不同的 old_text/new_text 或 edits，不能混用');
const textBase = { server_id: z.string(), remote_path: z.string(), duration_ms: z.number().int() };
const transferInput = z.strictObject({ ...selection, local_path: z.string().min(1).describe('MCP 进程所在机器的绝对文件路径，父目录须存在'), remote_path: z.string().regex(/^\//).describe('远端 SFTP 绝对文件路径，不展开 ~ 或环境变量，父目录须存在'), overwrite: z.boolean().default(false) });
const uploadInput = z.strictObject({ ...transferInput.shape, atomic: z.boolean().default(false).describe('写同目录临时文件后原子发布，须服务器支持对应 OpenSSH 扩展；不支持时失败') });
const transferOutput = z.object({ server_id: z.string(), local_path: z.string(), remote_path: z.string(), bytes_transferred: z.number().int(), duration_ms: z.number().int(), publication_state: z.enum(['not_published', 'unknown', 'published']).optional(), temporary_path: z.string().optional(), cleanup_pending: z.boolean().optional(), error: errorSchema.optional() });
const definitions = [
  { name: 'ssh_list', description: '列出配置中的 SSH 服务器、认证类型与可选跳板 ID，按 server_id 排序，不联网探测，不返回凭据。远端操作前使用精确 server_id 选择目标。', input: z.strictObject({}), output: z.object({ servers: z.array(z.object({ server_id: z.string(), description: z.string(), host: z.string(), port: z.number().int(), username: z.string(), auth_type: z.enum(['password', 'private_key', 'agent']), jump_server_id: z.string().optional() })) }) },
  { name: 'ssh_probe', description: '显式连接所选服务器，验证主机信任、认证及 SFTP 能力，返回主机密钥指纹和原子发布扩展支持。不开 Shell、不写远端文件；accept_new 仍可能追加本机 known_hosts。', input: probeInput, output: z.object({ server_id: z.string(), duration_ms: z.number().int(), ssh: z.boolean(), host_key_fingerprint: z.string().optional(), sftp: z.object({ available: z.boolean(), atomic_overwrite: z.boolean().optional(), atomic_no_overwrite: z.boolean().optional(), reason: z.string().optional() }).optional(), error: errorSchema.optional() }) },
  { name: 'ssh_exec', description: '通过独立 SSH exec 执行远端命令，可提供最多 1 MiB UTF-8 stdin，无 PTY、无持续 Shell、不自动输入 sudo 密码。stdout 最多 96 KiB、stderr 最多 32 KiB，可降低预算，默认保留两端，超限继续排空。save_output=true 可分页读取保存的输出。超时或取消后远端状态可能不确定，不自动重试。', input: execInput, output: execOutput },
  { name: 'ssh_exec_start', description: '在当前 MCP 会话内异步启动一次独立命令，立即返回 task_id 和 output_id。使用 ssh_task_status 查询、ssh_output 读取增量输出、ssh_task_cancel 请求取消。总超时从启动计时；会话关闭时清理，不跨进程恢复，不使用持续 Shell。', input: startInput, output: taskOutput },
  { name: 'ssh_task_status', description: '查询当前 MCP 会话的任务状态，结束后含命令结果。wait_seconds 可等待任务结束，最长 30 秒，默认立即返回。任务与输出完成后保留 10 分钟；取消等待不取消任务，不连接远端。', input: statusInput, output: taskOutput },
  { name: 'ssh_task_list', description: '列出当前 MCP 会话尚未过期的任务摘要，含句柄、服务器、状态及可用的过期时间，并报告同步与异步共享的输出容量。不返回命令和输出正文，不连接远端；用 ssh_output_forget 释放已结束输出。', input: z.strictObject({}), output: z.object({ tasks: z.array(taskOutput.omit({ result: true })), output_capacity: z.object({ used: z.number().int(), limit: z.number().int(), available: z.number().int(), active: z.number().int(), releasable: z.number().int() }) }) },
  { name: 'ssh_task_cancel', description: '请求取消当前 MCP 会话中的任务并关闭其连接，重复取消不重复执行命令。cancel_requested 不代表远端进程确认停止；继续查询取得本地最终状态。', input: taskInput, output: taskOutput },
  { name: 'ssh_output', description: '读取当前 MCP 会话保存的命令输出，按 offset 分页并用 next_offset 继续，或用 tail=true 读取已保存内容末尾。保存截断时末尾不代表完整远端输出。wait_seconds 可等待新输出或结束，最长 30 秒，默认立即返回。不连接远端、不重复执行命令。', input: outputInput, output: z.object({ output_id: z.string(), stream: z.enum(['stdout', 'stderr']), offset: z.number().int(), next_offset: z.number().int(), text: z.string(), available_bytes: z.number().int(), total_bytes: z.number().int(), storage_truncated: z.boolean(), finished: z.boolean(), eof: z.boolean() }) },
  { name: 'ssh_output_forget', description: '释放已结束操作的保存输出及关联任务记录，立即归还会话容量。活动操作须先取消或等待完成；释放后不能再读取结果。不连接远端、不删除远端文件。', input: forgetInput, output: z.object({ output_id: z.string(), forgotten: z.boolean() }) },
  { name: 'ssh_upload', description: '通过 SFTP 上传单个普通文件，最大 128 MiB，默认禁止覆盖，不创建父目录。路径须为绝对路径，不展开 ~。atomic=true 使用同目录临时文件发布，保留普通权限及 uid/gid，不保留 ACL、扩展属性或硬链接关系；默认直接上传，失败可能遗留部分文件。', input: uploadInput, output: transferOutput },
  { name: 'ssh_download', description: '通过 SFTP 下载单个普通文件，最大 128 MiB，默认禁止覆盖，不创建父目录。local_path 使用本机绝对路径，remote_path 使用远端绝对路径，不展开 ~。下载先写同目录临时文件，完整完成后发布，失败保留原目标。', input: transferInput, output: transferOutput },
  { name: 'ssh_read_file', description: '通过 SFTP 按行读取最多 1 MiB 的 UTF-8 普通文本文件，不执行 Shell。默认前 200 行，每页最多 96 KiB，使用 next_line 继续；返回 revision 供编辑前提检查。拒绝符号链接、无效 UTF-8 和 NUL。', input: textInput, output: z.union([z.object({ ...textBase, content: z.string(), start_line: z.number().int(), end_line: z.number().int(), next_line: z.number().int().nullable(), total_lines: z.number().int(), revision: z.string(), file_bytes: z.number().int() }), z.object({ ...textBase, error: errorSchema })]) },
  { name: 'ssh_edit_file', description: '按 expected_revision 编辑远端 UTF-8 文件。提供 old_text/new_text 或 edits 数组；各项在原始版本中须唯一匹配且互不重叠，全部校验后一次原子发布，保留普通权限及 uid/gid。文件最多 1 MiB，须 POSIX rename 扩展。发布前复查版本，不承诺原子比较交换。', input: editInput, output: z.object({ ...textBase, bytes_transferred: z.number().int(), publication_state: z.enum(['not_published', 'unknown', 'published']), temporary_path: z.string().optional(), cleanup_pending: z.boolean().optional(), previous_revision: z.string().optional(), revision: z.string().optional(), replacements: z.number().int().optional(), error: errorSchema.optional() }) },
];
const respond = (data: Record<string, unknown>, isError = false) => ({ isError, structuredContent: data, content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

export function createServer(config: Config, version: string, root: AbortSignal) {
  const outputs = new OutputStore();
  const scheduler = new OperationScheduler(config.concurrency);
  const tasks = new TaskStore(config, outputs, root, scheduler);
  root.addEventListener('abort', () => outputs.clear(), { once: true });
  const server = new Server({ name: 'ssh-mcp', version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.map(d => ({ name: d.name, description: d.description, annotations: { readOnlyHint: ['ssh_list', 'ssh_output', 'ssh_read_file', 'ssh_probe', 'ssh_task_status', 'ssh_task_list'].includes(d.name), destructiveHint: !['ssh_list', 'ssh_output', 'ssh_read_file', 'ssh_probe', 'ssh_task_status', 'ssh_task_list'].includes(d.name), idempotentHint: ['ssh_list', 'ssh_output', 'ssh_output_forget', 'ssh_read_file', 'ssh_probe', 'ssh_task_status', 'ssh_task_list', 'ssh_task_cancel'].includes(d.name), openWorldHint: !['ssh_list', 'ssh_output', 'ssh_output_forget', 'ssh_task_status', 'ssh_task_list'].includes(d.name) }, inputSchema: z.toJSONSchema(d.input, { io: 'input' }), outputSchema: { type: 'object' as const, anyOf: [z.toJSONSchema(d.output), z.toJSONSchema(validationOutput)] } })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const definition = definitions.find(d => d.name === request.params.name);
    if (!definition) throw new McpError(ErrorCode.InvalidParams, '未知工具，请使用 tools/list 返回的工具名称');
    const parsed = definition.input.safeParse(request.params.arguments ?? {});
    if (!parsed.success) return respond({ error: { code: 'ssh_input_invalid', message: '工具参数无效，请检查字段类型、取值范围和未知参数', phase: 'validation', operation_state: 'not_started', issues: parsed.error.issues.map(issue => ({ path: issue.path.map(String), code: issue.code, ...('expected' in issue ? { expected: issue.expected } : {}), ...('minimum' in issue && typeof issue.minimum === 'number' ? { minimum: issue.minimum } : {}), ...('maximum' in issue && typeof issue.maximum === 'number' ? { maximum: issue.maximum } : {}) })) } }, true);
    if (request.params.name === 'ssh_list') return respond({ servers: [...config.servers.values()].map(s => ({ server_id: s.id, description: s.description, host: s.host, port: s.port, username: s.username, auth_type: s.agentSocket ? 'agent' : s.privateKeyPath ? 'private_key' : 'password', ...(s.jumpServerId ? { jump_server_id: s.jumpServerId } : {}) })) });
    if (request.params.name === 'ssh_output') {
      const input = outputInput.parse(request.params.arguments);
      try { return respond(await outputs.readWait(input.output_id, input.stream, input.offset ?? 0, input.max_bytes, input.wait_seconds, AbortSignal.any([root, extra.signal]), input.tail)); }
      catch (error) { if (error instanceof SSHError) return respond({ error: { code: error.code, message: error.message, ...error.details } }, true); throw error; }
    }
    if (request.params.name === 'ssh_output_forget') {
      const input = forgetInput.parse(request.params.arguments);
      try { const result = outputs.forget(input.output_id); tasks.forgetOutput(input.output_id); return respond(result); }
      catch (error) { if (error instanceof SSHError) return respond({ error: { code: error.code, message: error.message, ...error.details } }, true); throw error; }
    }
    if (['ssh_exec_start', 'ssh_task_status', 'ssh_task_list', 'ssh_task_cancel'].includes(request.params.name)) {
      try {
        if (extra.signal.aborted) throw interrupted(extra.signal);
        if (request.params.name === 'ssh_exec_start') return respond(tasks.start(startInput.parse(request.params.arguments)));
        if (request.params.name === 'ssh_task_list') return respond(tasks.list());
        if (request.params.name === 'ssh_task_status') {
          const input = statusInput.parse(request.params.arguments);
          return respond(await tasks.wait(input.task_id, input.wait_seconds, AbortSignal.any([root, extra.signal])));
        }
        const input = taskInput.parse(request.params.arguments);
        return respond(tasks.cancel(input.task_id));
      } catch (error) { if (error instanceof SSHError) return respond({ error: { code: error.code, message: error.message, ...error.details } }, true); throw error; }
    }
    const input = request.params.name === 'ssh_probe' ? { kind: 'probe' as const, ...probeInput.parse(request.params.arguments) } : request.params.name === 'ssh_upload' ? { kind: 'upload' as const, ...uploadInput.parse(request.params.arguments) } : request.params.name === 'ssh_download' ? { kind: 'download' as const, ...transferInput.parse(request.params.arguments) } : request.params.name === 'ssh_read_file' ? { kind: 'read' as const, ...textInput.parse(request.params.arguments) } : request.params.name === 'ssh_edit_file' ? { kind: 'edit' as const, ...editInput.parse(request.params.arguments) } : { kind: 'exec' as const, ...execInput.parse(request.params.arguments) };
    const start = performance.now(), op = operationSignal(AbortSignal.any([root, extra.signal]), input.timeout_seconds);
    const execution = createExecResult();
    const progress: TransferResult = { bytes_transferred: 0 };
    let capabilities: Record<string, unknown> = { ssh: false };
    let textResult: Record<string, unknown> = {};
    if (input.kind === 'edit') progress.publication_state = 'not_published';
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
    let release: (() => void) | undefined;
    try {
      if ('local_path' in input) validatePaths(input.local_path, input.remote_path);
      else if ('remote_path' in input) validateRemotePath(input.remote_path);
      const target = config.servers.get(input.server_id);
      if (!target) throw new SSHError('ssh_server_unknown', '未知 server_id，请使用 ssh_list 返回的精确 ID');
      if ('save_output' in input && input.save_output) outputId = outputs.create();
      context.phase = 'queue';
      release = await scheduler.acquire(target.jumpServerId ? [target.id, target.jumpServerId] : [target.id], op.signal);
      context.phase = 'connect';
      const connection = await dial(target, config, op.signal, op.deadline);
      try {
        if ('local_path' in input) {
          await transfer(connection, request.params.name === 'ssh_upload' ? 'upload' : 'download', input.local_path, input.remote_path, input.overwrite, progress, context, { atomic: 'atomic' in input && input.atomic === true, onProgress: bytes => notifyProgress(bytes) });
          await notifyProgress(progress.bytes_transferred, true);
        }
        else if ('command' in input) await exec(connection, input.command, execution, context, { ...input, onOutput: outputId ? (stream, data) => outputs.append(outputId!, stream, data) : undefined });
        else if (input.kind === 'read') { context.phase = 'read'; textResult = textLines(await readText(connection, input.remote_path), input.start_line, input.line_count); context.operation_state = 'completed'; }
        else if (input.kind === 'edit') textResult = await editText(connection, input.remote_path, input.edits ?? [{ old_text: input.old_text!, new_text: input.new_text! }], input.expected_revision, progress, context);
        else { context.phase = 'probe'; capabilities = { ssh: true, host_key_fingerprint: connection.hostKeyFingerprint }; capabilities = await probe(connection); context.operation_state = 'completed'; }
      } finally { connection.close(); }
    } catch (failure) {
      error = operationError(failure, context);
    } finally { release?.(); op.dispose(); if (outputId) outputs.finish(outputId); }
    const result = { server_id: input.server_id, duration_ms: Math.floor(performance.now() - start), ...('local_path' in input ? { local_path: input.local_path, remote_path: input.remote_path, ...progress } : 'command' in input ? execution : 'remote_path' in input ? { remote_path: input.remote_path, ...(input.kind === 'edit' ? progress : {}), ...textResult } : capabilities) };
    return respond({ ...result, ...(outputId ? { output_id: outputId } : {}), ...(error ? { error } : {}) }, !!error);
  });
  return server;
}
