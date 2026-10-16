import { isUtf8 } from 'node:buffer';
import { SSHError, interrupted } from '../errors.js';
import type { OperationContext } from '../errors.js';
import type { Connection } from './client.js';
import type { ClientChannel } from 'ssh2';

export const MAX_OUTPUT_BYTES = 128 * 1024;
export interface ExecResult { stdout: string; stderr: string; exit_code: number | null; output_truncated: boolean }

export function cleanOutput(data: Buffer): string {
  let result = '', invalid = false;
  for (let i = 0; i < data.length;) {
    const byte = data[i]!;
    if (byte < 0x80) {
      let end = i + 1;
      while (end < data.length && data[end]! < 0x80) end++;
      result += data.toString('utf8', i, end); i = end; invalid = false; continue;
    }
    const size = byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 0;
    if (size && i + size > data.length) {
      try { new TextDecoder('utf8', { fatal: true }).decode(data.subarray(i), { stream: true }); break; }
      catch { /* 内部非法字节仍需替换。 */ }
    }
    if (size && isUtf8(data.subarray(i, i + size))) {
      result += data.toString('utf8', i, i + size); i += size; invalid = false;
    } else {
      if (!invalid) result += '?';
      invalid = true; i++;
    }
  }
  return result;
}

export async function exec(connection: Connection, command: string, result: ExecResult, context: OperationContext = { phase: 'exec', operation_state: 'not_started' }) {
  let channel: ClientChannel | undefined;
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let remaining = MAX_OUTPUT_BYTES, signaled = false;
  const capture = (chunks: Buffer[], data: Buffer) => {
    const n = Math.min(data.length, remaining);
    if (n < data.length) result.output_truncated = true;
    if (n) chunks.push(Buffer.from(data.subarray(0, n)));
    remaining -= n;
  };
  try {
    await connection.wait<void>(done => {
      context.phase = 'exec'; context.operation_state = 'may_have_started';
      connection.client.exec(command, (error, stream) => {
        if (error) { context.operation_state = 'not_started'; done(new SSHError('ssh_exec_failed', 'SSH 会话创建失败')); return; }
        channel = stream;
        // 同一个网络包可能包含请求确认、输出及退出状态，必须在回调内同步监听。
        stream.on('data', (data: Buffer) => capture(stdout, data));
        stream.stderr.on('data', (data: Buffer) => capture(stderr, data));
        stream.on('exit', (code: number | null, signal?: string) => {
          if (typeof code === 'number') result.exit_code = code;
          if (signal) { signaled = true; result.exit_code = null; }
        });
        stream.once('close', () => done(null));
        stream.once('error', () => done(new SSHError('ssh_exec_unknown', 'SSH 执行中断或未返回退出码，远端状态可能不确定，请检查后再操作')));
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
    result.stdout = cleanOutput(Buffer.concat(stdout));
    result.stderr = cleanOutput(Buffer.concat(stderr));
    channel?.destroy();
  }
}
