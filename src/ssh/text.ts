import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { Connection } from './client.js';
import { transfer } from './transfer.js';
import type { TransferResult } from './transfer.js';
import { SSHError, interrupted, failureReason } from '../errors.js';
import type { OperationContext } from '../errors.js';

export const MAX_TEXT_BYTES = 1024 * 1024;
const revision = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export function validateRemotePath(path: string) {
  if (!path.startsWith('/') || path.includes('\0')) throw new SSHError('ssh_path_invalid', 'remote_path 必须是远端 SFTP 绝对路径，不展开 ~ 或环境变量');
}

export async function readText(connection: Connection, path: string) {
  validateRemotePath(path);
  const files = await connection.wait<SFTPWrapper>(done => connection.client.sftp(done));
  files.on('error', () => {});
  let closed = false, handle: Buffer | undefined;
  files.once('close', () => { closed = true; });
  const wait = <T>(start: (done: (error: Error | null | undefined, value: T) => void) => void) => connection.wait(start, files);
  let failure: unknown, data: Buffer | undefined;
  try {
    const check = (info: Stats) => {
      if (!info.isFile()) throw new SSHError('ssh_text_invalid', '文本源必须是普通文件，不能是目录或符号链接');
      if (info.size > MAX_TEXT_BYTES) throw new SSHError('ssh_text_limit', '文本文件不能超过 1 MiB');
    };
    check(await wait<Stats>(done => files.lstat(path, done)));
    handle = await wait<Buffer>(done => files.open(path, 'r', done));
    const source = handle;
    check(await wait<Stats>(done => files.fstat(source, done)));
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const length = Math.min(32 * 1024, buffer.length - used);
      const bytes = await wait<number>(done => files.read(source, buffer, used, length, used, (error, count) => done(error, count)));
      if (!bytes) break;
      used += bytes;
    }
    if (used > MAX_TEXT_BYTES) throw new SSHError('ssh_text_limit', '文本文件在读取中超过 1 MiB');
    data = buffer.subarray(0, used);
    if (!isUtf8(data) || data.includes(0)) throw new SSHError('ssh_text_invalid', '文件须为不含 NUL 的有效 UTF-8 文本');
    handle = undefined;
    await wait<void>(done => files.close(source, done));
  } catch (error) { failure = error; }
  finally {
    if (handle && !closed && !connection.closed && !connection.signal.aborted) {
      try { await wait<void>(done => files.close(handle!, done)); }
      catch (error) { failure ??= error; }
    }
    files.end();
  }
  if (failure) {
    if (connection.signal.aborted) throw interrupted(connection.signal);
    if (failure instanceof SSHError) throw failure;
    throw new SSHError('ssh_text_failed', 'SFTP 文本读取失败，请检查文件、权限和子系统', { reason: failureReason(failure) });
  }
  return { content: data!.toString('utf8'), revision: revision(data!), bytes: data!.length };
}

export function textLines(text: Awaited<ReturnType<typeof readText>>, startLine: number, lineCount: number) {
  const lines = text.content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (startLine > lines.length + 1) throw new SSHError('ssh_input_invalid', 'start_line 超过文件行数');
  let content = '', end = startLine - 1, bytes = 0;
  for (let index = startLine - 1; index < Math.min(lines.length, startLine - 1 + lineCount); index++) {
    const line = lines[index]! + (index < lines.length - 1 || text.content.endsWith('\n') ? '\n' : '');
    const size = Buffer.byteLength(line);
    if (bytes + size > 96 * 1024) {
      if (!content) throw new SSHError('ssh_text_limit', '单行超过 96 KiB 返回预算，请使用命令读取所需片段');
      break;
    }
    content += line; bytes += size; end = index + 1;
  }
  return { content, start_line: startLine, end_line: end, next_line: end < lines.length ? end + 1 : null, total_lines: lines.length, revision: text.revision, file_bytes: text.bytes };
}

export async function editText(connection: Connection, path: string, oldText: string, newText: string, expectedRevision: string, result: TransferResult, context: OperationContext) {
  context.phase = 'read';
  const previous = await readText(connection, path);
  if (previous.revision !== expectedRevision) throw new SSHError('ssh_text_conflict', '文件内容已变化，请重新读取后编辑');
  const index = previous.content.indexOf(oldText);
  if (index === -1 || previous.content.indexOf(oldText, index + 1) !== -1) throw new SSHError('ssh_text_match', 'old_text 必须在当前文件中精确出现一次');
  const data = Buffer.from(previous.content.slice(0, index) + newText + previous.content.slice(index + oldText.length));
  if (data.length > MAX_TEXT_BYTES) throw new SSHError('ssh_text_limit', '编辑后的文本不能超过 1 MiB');
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-edit-'));
  let failure: unknown;
  try {
    const source = join(directory, 'content');
    await writeFile(source, data, { mode: 0o600, signal: connection.signal });
    await transfer(connection, 'upload', source, path, true, result, context, { atomic: true, beforePublish: async () => {
      context.phase = 'verify';
      if ((await readText(connection, path)).revision !== expectedRevision) throw new SSHError('ssh_text_conflict', '文件在编辑期间变化，尚未发布，请重新读取后编辑');
    } });
  } catch (error) { failure = error; }
  finally {
    try { await rm(directory, { recursive: true, force: true }); }
    catch { failure ??= new SSHError('ssh_text_cleanup', '本地编辑临时文件清理失败', { phase: 'cleanup', operation_state: context.operation_state }); }
  }
  if (failure) throw failure;
  return { previous_revision: previous.revision, revision: revision(data), replacements: 1 };
}
