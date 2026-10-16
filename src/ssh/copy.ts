import { SSHError, interrupted } from '../errors.js';

export const TRANSFER_WINDOW = 4;
export const MAX_TRANSFER_BYTES = 128 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
export interface CopyOptions {
  window?: number;
  onFailure?: () => void;
  onProgress?: (bytes: number) => Promise<void>;
}

// 每批最多 window 个块；短读继续填充，写入按偏移定位，EOF 后复查源增长。
export async function copyLimited(read: (buffer: Buffer, position: number) => Promise<number>, write: (buffer: Buffer, position: number) => Promise<void>, result: { bytes_transferred: number }, signal: AbortSignal, limit = MAX_TRANSFER_BYTES, options: CopyOptions = {}) {
  const window = options.window ?? TRANSFER_WINDOW;
  if (!Number.isInteger(window) || window < 1 || window > 32) throw new Error('传输窗口须为 1–32 的整数');
  let position = 0;
  const check = () => { if (signal.aborted) throw interrupted(signal); };
  while (true) {
    check();
    if (position === limit) {
      const count = await read(Buffer.alloc(1), position); check();
      if (count) throw new SSHError('ssh_transfer_limit', '文件在传输中超过 128 MiB 上限，请检查上传状态；下载目标尚未发布');
      return;
    }
    let failure: unknown;
    const jobs: Promise<{ offset: number; count: number; capacity: number }>[] = [];
    for (let index = 0; index < window && position + index * CHUNK_BYTES < limit; index++) {
      const offset = position + index * CHUNK_BYTES, capacity = Math.min(CHUNK_BYTES, limit - offset);
      jobs.push((async () => {
        const buffer = Buffer.alloc(capacity);
        let count = 0;
        while (count < capacity) {
          check(); if (failure) throw failure;
          const bytes = await read(buffer.subarray(count), offset + count); check();
          if (!bytes) break;
          count += bytes;
        }
        check(); if (failure) throw failure;
        if (count) {
          await write(buffer.subarray(0, count), offset);
          result.bytes_transferred += count;
          check();
          await options.onProgress?.(result.bytes_transferred);
        }
        return { offset, count, capacity };
      })().catch(error => {
        if (!failure) { failure = error; options.onFailure?.(); }
        throw error;
      }));
    }
    const settled = await Promise.allSettled(jobs);
    if (failure) throw failure;
    const chunks = settled.map(item => { if (item.status === 'rejected') throw item.reason; return item.value; });
    const end = chunks.find(chunk => chunk.count < chunk.capacity);
    if (!end) { position += chunks.reduce((total, chunk) => total + chunk.capacity, 0); continue; }
    position = end.offset + end.count;
    if (chunks.some(chunk => chunk.offset > position && chunk.count > 0)) throw new SSHError('ssh_transfer_failed', '源文件在传输中发生不连续变化，目标尚未发布', { reason: 'source_changed' });
    // 首次写入可能使测试或外部进程扩展源；确认 EOF 时不能沿用预检大小。
    if (!chunks.some(chunk => chunk.count > 0)) return;
    const count = await read(Buffer.alloc(1), position); check();
    if (!count) return;
  }
}
