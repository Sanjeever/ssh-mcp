export interface OperationContext {
  phase: string;
  operation_state: 'not_started' | 'may_have_started' | 'completed';
}
export interface ErrorDetails extends Partial<OperationContext> { reason?: string; hop_server_id?: string }
export class SSHError extends Error {
  constructor(public readonly code: string, message: string, public readonly details: ErrorDetails = {}) { super(message); }
}
export function failureReason(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  if (code === 'EACCES' || code === 'EPERM' || code === 3) return 'permission_denied';
  if (code === 'ENOENT' || code === 2) return 'not_found';
  if (code === 'EEXIST') return 'target_exists';
  if (code === 'ENOSPC') return 'no_space';
  if (code === 'ENOTSUP' || code === 8) return 'unsupported';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_failed';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'network_unreachable';
  if (code === 'ETIMEDOUT') return 'connection_timeout';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'connection_reset';
  return undefined;
}
export function interrupted(signal: AbortSignal): SSHError {
  return signal.reason instanceof SSHError ? signal.reason : new SSHError('ssh_canceled', 'SSH 操作已取消；远端进程或文件状态可能不确定，上传可能遗留部分文件，请检查后再操作');
}
export function operationSignal(parent: AbortSignal, seconds = 180) {
  const controller = new AbortController();
  const abort = () => controller.abort(interrupted(parent));
  if (parent.aborted) abort();
  else parent.addEventListener('abort', abort, { once: true });
  const deadline = performance.now() + seconds * 1000;
  const timer = setTimeout(() => controller.abort(new SSHError('ssh_timeout', 'SSH 操作超时；远端进程或文件状态可能不确定，关闭连接不保证远端进程已停止，请检查后再操作')), seconds * 1000);
  return { signal: controller.signal, deadline, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
}
