import { randomUUID } from 'node:crypto';
import { SSHError } from './errors.js';
import { cleanOutput } from './ssh/output.js';
import { waitUntil } from './wait.js';

export type OutputStream = 'stdout' | 'stderr';
export const SAVED_STREAM_BYTES = 4 * 1024 * 1024;
export const MAX_SAVED_OUTPUTS = 8;
export const OUTPUT_TTL_MS = 10 * 60 * 1000;

interface SavedStream { data: Buffer; used: number; total: number }
interface SavedOutput { streams: Record<OutputStream, SavedStream>; changes: EventTarget; expires?: number }

// 显式保存的输出归属当前 MCP 会话；固定缓冲区限制内容与块元数据的总量。
export class OutputStore {
  private entries = new Map<string, SavedOutput>();
  constructor(private now = () => Date.now()) {}
  create() {
    this.prune();
    if (this.entries.size >= MAX_SAVED_OUTPUTS) throw new SSHError('ssh_output_limit', '会话已保存 8 份输出，请等待输出过期后再启动保存操作', { operation_state: 'not_started' });
    const stream = (): SavedStream => ({ data: Buffer.alloc(SAVED_STREAM_BYTES), used: 0, total: 0 });
    const id = randomUUID();
    this.entries.set(id, { streams: { stdout: stream(), stderr: stream() }, changes: new EventTarget() });
    return id;
  }
  append(id: string, stream: OutputStream, data: Buffer) {
    const entry = this.entries.get(id);
    if (!entry) return; // 会话关闭时已清空，后续网络事件仍可能到达。
    const saved = entry.streams[stream];
    saved.total += data.length;
    saved.used += data.copy(saved.data, saved.used, 0, Math.max(0, saved.data.length - saved.used));
    entry.changes.dispatchEvent(new Event('change'));
  }
  finish(id: string) {
    const entry = this.entries.get(id);
    if (entry && entry.expires === undefined) {
      entry.expires = this.now() + OUTPUT_TTL_MS;
      entry.changes.dispatchEvent(new Event('change'));
    }
  }
  forget(id: string) {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry) throw new SSHError('ssh_output_unknown', '输出 ID 不存在、已过期或属于其他 MCP 会话', { operation_state: 'not_started' });
    if (entry.expires === undefined) throw new SSHError('ssh_output_active', '输出仍属于活动操作，请先取消或等待完成', { operation_state: 'not_started' });
    this.entries.delete(id);
    entry.changes.dispatchEvent(new Event('change'));
    return { output_id: id, forgotten: true };
  }
  read(id: string, stream: OutputStream, offset: number, maxBytes: number) {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry) throw new SSHError('ssh_output_unknown', '输出 ID 不存在、已过期或属于其他 MCP 会话', { operation_state: 'not_started' });
    const saved = entry.streams[stream];
    if (offset > saved.used) throw new SSHError('ssh_input_invalid', 'offset 超过当前可读取字节数', { operation_state: 'not_started' });
    const page = textPage(saved.data.subarray(0, saved.used), offset, maxBytes, entry.expires !== undefined);
    return { output_id: id, stream, ...page, available_bytes: saved.used, total_bytes: saved.total, storage_truncated: saved.total > saved.used, finished: entry.expires !== undefined, eof: entry.expires !== undefined && page.next_offset === saved.used };
  }
  async readWait(id: string, stream: OutputStream, offset: number, maxBytes: number, seconds: number, signal: AbortSignal) {
    this.read(id, stream, offset, maxBytes);
    const entry = this.entries.get(id)!;
    const saved = entry.streams[stream];
    await waitUntil(() => !this.entries.has(id) || entry.expires !== undefined || saved.used === SAVED_STREAM_BYTES || textPage(saved.data.subarray(0, saved.used), offset, maxBytes, false).next_offset > offset, entry.changes, seconds, signal);
    return this.read(id, stream, offset, maxBytes);
  }
  clear() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) entry.changes.dispatchEvent(new Event('change'));
  }
  private prune() {
    for (const [id, entry] of this.entries) if (entry.expires !== undefined && entry.expires <= this.now()) this.entries.delete(id);
  }
}

// 页边界不切断合法 UTF-8 字符；任意偏移落入续字节时从下一个字符开始。
export function textPage(data: Buffer, offset: number, maxBytes: number, finished = true) {
  let start = offset, end = Math.min(data.length, start + maxBytes);
  while (start < end && (data[start]! & 0xc0) === 0x80) start++;
  if (end < data.length || !finished) {
    for (let index = Math.max(start, end - 3); index < end; index++) {
      if (data[index]! < 0xc2 || data[index]! > 0xf4) continue;
      try {
        if (!new TextDecoder('utf8', { fatal: true }).decode(data.subarray(index, end), { stream: true })) { end = index; break; }
      } catch { /* 非法字节交给输出清洗，不能把它当成分页边界。 */ }
    }
  }
  return { offset: start, next_offset: end, text: cleanOutput(data.subarray(start, end)) };
}
