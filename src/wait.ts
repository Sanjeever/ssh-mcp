import { SSHError } from './errors.js';

// 等待只观察本地状态；超时或取消等待不会取消原操作。
export async function waitUntil(ready: () => boolean, changes: EventTarget, seconds: number, signal: AbortSignal) {
  const canceled = () => new SSHError('ssh_canceled', '等待已取消，原操作仍由任务及会话生命周期管理', { phase: 'wait', operation_state: 'not_started' });
  if (signal.aborted) throw canceled();
  if (!seconds || ready()) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: SSHError) => {
      clearTimeout(timer);
      changes.removeEventListener('change', changed);
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const changed = () => { if (ready()) finish(); };
    const abort = () => finish(canceled());
    const timer = setTimeout(() => finish(), seconds * 1000);
    changes.addEventListener('change', changed);
    signal.addEventListener('abort', abort, { once: true });
    changed();
  });
}
