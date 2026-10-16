import { SSHError, interrupted } from '../errors.js';
import type { OperationContext } from '../errors.js';
import type { Connection } from './client.js';
import type { ClientChannel } from 'ssh2';
import { OutputCapture } from './output.js';
import type { OutputMode } from './output.js';

export const MAX_OUTPUT_BYTES = 128 * 1024;
export const MAX_STDIN_BYTES = 1024 * 1024;
export function createExecResult() {
  return { stdout: '', stderr: '', exit_code: null as number | null, exit_signal: null as string | null, output_truncated: false, stdout_truncated: false, stderr_truncated: false, stdout_bytes: 0, stderr_bytes: 0, stdout_omitted_bytes: 0, stderr_omitted_bytes: 0 };
}
export type ExecResult = ReturnType<typeof createExecResult>;
export interface ExecOptions { stdin?: string; output_mode?: OutputMode }

export async function exec(connection: Connection, command: string, result: ExecResult, context: OperationContext = { phase: 'exec', operation_state: 'not_started' }, options: ExecOptions = {}) {
  let channel: ClientChannel | undefined;
  const stdout = new OutputCapture(96 * 1024, options.output_mode ?? 'head_tail');
  const stderr = new OutputCapture(32 * 1024, options.output_mode ?? 'head_tail');
  const input = Buffer.from(options.stdin ?? '');
  if (input.length > MAX_STDIN_BYTES) throw new SSHError('ssh_input_invalid', 'stdin 编码后不能超过 1 MiB');
  let signaled = false;
  try {
    await connection.wait<void>(done => {
      context.phase = 'exec'; context.operation_state = 'may_have_started';
      connection.client.exec(command, (error, stream) => {
        if (error) { done(new SSHError('ssh_exec_failed', 'SSH 会话创建失败')); return; }
        channel = stream;
        // 同一个网络包可能包含请求确认、输出及退出状态，必须在回调内同步监听。
        stream.on('data', (data: Buffer) => stdout.append(data));
        stream.stderr.on('data', (data: Buffer) => stderr.append(data));
        stream.on('exit', (code: number | null, signal?: string) => {
          if (typeof code === 'number') result.exit_code = code;
          if (signal) { signaled = true; result.exit_code = null; result.exit_signal = signal; }
        });
        stream.once('close', () => done(null));
        stream.once('error', () => done(new SSHError('ssh_exec_unknown', 'SSH 执行中断或未返回退出码，远端状态可能不确定，请检查后再操作')));
        const sendInput = async () => {
          for (let offset = 0; offset < input.length; offset += 32 * 1024) {
            await connection.wait<void>(written => { stream.write(input.subarray(offset, offset + 32 * 1024), written); }, stream);
          }
          if (!stream.destroyed) stream.end();
        };
        void sendInput().catch(() => done(connection.signal.aborted ? interrupted(connection.signal) : new SSHError('ssh_exec_unknown', '远端提前关闭输入或 stdin 发送失败，请检查远端状态', { reason: 'stdin_interrupted' })));
      });
    });
    if (connection.signal.aborted) throw interrupted(connection.signal);
    if (result.exit_code !== null || signaled) context.operation_state = 'completed';
    if (signaled) throw new SSHError('ssh_exit_signal', '远端命令因信号结束，无法确认数值退出码，请检查远端状态');
    if (result.exit_code === null) throw new SSHError('ssh_exec_unknown', 'SSH 执行中断或未返回退出码，远端状态可能不确定，请检查后再操作');
    if (result.exit_code !== 0) throw new SSHError('ssh_exit_nonzero', `远端命令退出码为 ${result.exit_code}`);
  } catch (error) {
    if (connection.signal.aborted) { result.exit_code = null; throw interrupted(connection.signal); }
    if (error instanceof SSHError && error.code !== 'ssh_error') throw error;
    throw new SSHError('ssh_exec_unknown', 'SSH 执行中断或未返回退出码，远端状态可能不确定，请检查后再操作');
  } finally {
    const out = stdout.result(), err = stderr.result();
    Object.assign(result, { stdout: out.text, stderr: err.text, stdout_bytes: stdout.bytes, stderr_bytes: stderr.bytes, stdout_omitted_bytes: out.omitted, stderr_omitted_bytes: err.omitted, stdout_truncated: out.truncated, stderr_truncated: err.truncated, output_truncated: out.truncated || err.truncated });
    channel?.destroy();
  }
}
