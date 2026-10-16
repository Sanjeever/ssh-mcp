import { SSHError, interrupted } from './errors.js';

export interface Concurrency { readonly global: number; readonly perServer: number; readonly queue: number }
export const DEFAULT_CONCURRENCY: Concurrency = Object.freeze({ global: 4, perServer: 2, queue: 32 });
interface Waiting { servers: string[]; signal: AbortSignal; abort: () => void; resolve: (release: () => void) => void; reject: (error: Error) => void }

// 跳板与目标共同占用各自服务器配额；全局按逻辑操作计数。
export class OperationScheduler {
  private active = 0;
  private perServer = new Map<string, number>();
  private waiting: Waiting[] = [];
  constructor(private limits: Concurrency = DEFAULT_CONCURRENCY) {}
  acquire(serverIds: string[], signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(interrupted(signal));
    const servers = [...new Set(serverIds)];
    if (this.available(servers)) return Promise.resolve(this.reserve(servers));
    if (this.waiting.length >= this.limits.queue) return Promise.reject(new SSHError('ssh_queue_full', '远端操作等待队列已满，请等待现有操作结束', { phase: 'queue', operation_state: 'not_started' }));
    return new Promise((resolve, reject) => {
      const entry: Waiting = { servers, signal, resolve, reject, abort: () => {
        const index = this.waiting.indexOf(entry);
        if (index !== -1) this.waiting.splice(index, 1);
        signal.removeEventListener('abort', entry.abort);
        reject(interrupted(signal));
      } };
      this.waiting.push(entry);
      signal.addEventListener('abort', entry.abort, { once: true });
    });
  }
  private available(servers: string[]) { return this.active < this.limits.global && servers.every(id => (this.perServer.get(id) ?? 0) < this.limits.perServer); }
  private reserve(servers: string[]) {
    this.active++;
    for (const id of servers) this.perServer.set(id, (this.perServer.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true; this.active--;
      for (const id of servers) {
        const remaining = this.perServer.get(id)! - 1;
        if (remaining) this.perServer.set(id, remaining); else this.perServer.delete(id);
      }
      // 按排队顺序启动可执行项，避免同一忙碌服务器阻塞其他服务器。
      for (let index = 0; index < this.waiting.length;) {
        const entry = this.waiting[index]!;
        if (!this.available(entry.servers)) { index++; continue; }
        this.waiting.splice(index, 1);
        entry.signal.removeEventListener('abort', entry.abort);
        entry.resolve(this.reserve(entry.servers));
      }
    };
  }
}
