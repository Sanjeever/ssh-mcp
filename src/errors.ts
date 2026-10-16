export class SSHError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
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
