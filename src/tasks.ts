import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { SSHError, operationSignal, operationError } from './errors.js';
import type { OperationContext } from './errors.js';
import { OutputStore, OUTPUT_TTL_MS, MAX_SAVED_OUTPUTS } from './output-store.js';
import { dial } from './ssh/client.js';
import { exec, createExecResult } from './ssh/exec.js';
import type { ExecOptions } from './ssh/exec.js';

type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
interface Task {
  id: string;
  serverId: string;
  outputId: string;
  status: TaskStatus;
  context: OperationContext;
  controller: AbortController;
  startedAt: string;
  cancelRequested: boolean;
  expires?: number;
  result?: ReturnType<typeof createExecResult> & { server_id: string; output_id: string; duration_ms: number; error?: ReturnType<typeof operationError> };
}
export interface TaskInput extends ExecOptions { server_id: string; command: string; timeout_seconds: number }

// 任务归属当前 stdio 会话；原始启动请求结束后，通过专用工具观察和取消。
export class TaskStore {
  private entries = new Map<string, Task>();
  constructor(private config: Config, private outputs: OutputStore, private root: AbortSignal, private now = () => Date.now()) {
    root.addEventListener('abort', () => this.entries.clear(), { once: true });
  }
  start(input: TaskInput) {
    this.prune();
    if (this.root.aborted) throw new SSHError('ssh_canceled', 'MCP 会话已关闭', { operation_state: 'not_started' });
    if (!this.config.servers.has(input.server_id)) throw new SSHError('ssh_server_unknown', '未知 server_id，请使用 ssh_list 返回的精确 ID', { operation_state: 'not_started' });
    if (this.entries.size >= MAX_SAVED_OUTPUTS) throw new SSHError('ssh_task_limit', '会话已保留 8 个任务，请等待已结束任务过期', { operation_state: 'not_started' });
    const outputId = this.outputs.create();
    const task: Task = { id: randomUUID(), serverId: input.server_id, outputId, status: 'queued', context: { phase: 'connect', operation_state: 'not_started' }, controller: new AbortController(), startedAt: new Date(this.now()).toISOString(), cancelRequested: false };
    this.entries.set(task.id, task);
    void this.run(task, input);
    return this.snapshot(task);
  }
  get(id: string) { return this.snapshot(this.find(id)); }
  cancel(id: string) {
    const task = this.find(id);
    if (!task.result) { task.cancelRequested = true; task.controller.abort(); }
    return this.snapshot(task);
  }
  private find(id: string) {
    this.prune();
    const task = this.entries.get(id);
    if (!task) throw new SSHError('ssh_task_unknown', '任务 ID 不存在、已过期或属于其他 MCP 会话', { operation_state: 'not_started' });
    return task;
  }
  private snapshot(task: Task) {
    return { task_id: task.id, server_id: task.serverId, output_id: task.outputId, status: task.status, phase: task.context.phase, operation_state: task.context.operation_state, started_at: task.startedAt, cancel_requested: task.cancelRequested, ...(task.result ? { result: task.result } : {}) };
  }
  private prune() {
    for (const [id, task] of this.entries) if (task.expires !== undefined && task.expires <= this.now()) this.entries.delete(id);
  }
  private async run(task: Task, input: TaskInput) {
    const start = performance.now(), op = operationSignal(AbortSignal.any([this.root, task.controller.signal]), input.timeout_seconds);
    const execution = createExecResult();
    let error: ReturnType<typeof operationError> | undefined;
    try {
      task.status = 'running';
      const connection = await dial(this.config.servers.get(input.server_id)!, this.config, op.signal, op.deadline);
      try { await exec(connection, input.command, execution, task.context, { ...input, onOutput: (stream, data) => this.outputs.append(task.outputId, stream, data) }); }
      finally { connection.close(); }
    } catch (failure) { error = operationError(failure, task.context); task.context = { phase: error.phase, operation_state: error.operation_state }; }
    finally { op.dispose(); this.outputs.finish(task.outputId); }
    task.result = { server_id: task.serverId, output_id: task.outputId, duration_ms: Math.floor(performance.now() - start), ...execution, ...(error ? { error } : {}) };
    task.status = error?.code === 'ssh_canceled' ? 'canceled' : error ? 'failed' : 'completed';
    task.expires = this.now() + OUTPUT_TTL_MS;
  }
}
