import { isUtf8 } from 'node:buffer';

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

export type OutputMode = 'head' | 'tail' | 'head_tail';
const omission = '\n[...已省略输出...]\n';

// 固定大小头部与环形尾部，避免小数据块数量随运行时间增长。
export class OutputCapture {
  private head: Buffer;
  private tail: Buffer;
  private headUsed = 0;
  private tailUsed = 0;
  private cursor = 0;
  bytes = 0;
  constructor(limit: number, private mode: OutputMode) {
    const budget = mode === 'head_tail' ? limit - Buffer.byteLength(omission) : limit;
    const headSize = mode === 'head' ? budget : mode === 'tail' ? 0 : Math.floor(budget / 2);
    this.head = Buffer.alloc(headSize); this.tail = Buffer.alloc(budget - headSize);
  }
  append(data: Buffer) {
    this.bytes += data.length;
    const count = Math.min(data.length, this.head.length - this.headUsed);
    data.copy(this.head, this.headUsed, 0, count); this.headUsed += count;
    data = data.subarray(count);
    if (!this.tail.length || !data.length) return;
    if (data.length >= this.tail.length) {
      data.copy(this.tail, 0, data.length - this.tail.length);
      this.cursor = 0; this.tailUsed = this.tail.length;
    } else {
      const first = Math.min(data.length, this.tail.length - this.cursor);
      data.copy(this.tail, this.cursor, 0, first); data.copy(this.tail, 0, first);
      this.cursor = (this.cursor + data.length) % this.tail.length;
      this.tailUsed = Math.min(this.tail.length, this.tailUsed + data.length);
    }
  }
  result() {
    const head = this.head.subarray(0, this.headUsed);
    let tail = this.tailUsed < this.tail.length ? this.tail.subarray(0, this.tailUsed) : Buffer.concat([this.tail.subarray(this.cursor), this.tail.subarray(0, this.cursor)]);
    const omitted = this.bytes - head.length - tail.length;
    if (!omitted) return { text: cleanOutput(Buffer.concat([head, tail])), omitted, truncated: false };
    // 尾部可能从 UTF-8 续字节开始，移除截断造成的不完整序列。
    let start = 0;
    while (start < Math.min(3, tail.length) && (tail[start]! & 0xc0) === 0x80) start++;
    tail = tail.subarray(start);
    return { text: cleanOutput(head) + (this.mode === 'head_tail' ? omission : '') + cleanOutput(tail), omitted: omitted + start, truncated: true };
  }
}
