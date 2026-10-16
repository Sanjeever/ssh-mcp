import { lstat, open, link, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { Connection } from './client.js';
import { SSHError, interrupted } from '../errors.js';

export const MAX_TRANSFER_BYTES = 128 * 1024 * 1024;
export interface TransferResult { bytes_transferred: number }
const failed = (message: string) => new SSHError('ssh_transfer_failed', message);
const invalid = () => new SSHError('ssh_transfer_invalid', '传输源必须是可访问的单个普通文件，目标不能是目录或符号链接，源文件不能超过 128 MiB');
export function validatePaths(local: string, remote: string) {
  if (!isAbsolute(local) || local.includes('\0')) throw new SSHError('ssh_path_invalid', 'local_path 必须是 MCP 进程所在机器的绝对路径');
  if (!remote.startsWith('/') || remote.includes('\0')) throw new SSHError('ssh_path_invalid', 'remote_path 必须是远端 SFTP 绝对路径，不展开 ~ 或环境变量');
}
async function localTarget(local: string, overwrite: boolean) {
  try {
    const info = await lstat(local);
    if (!info.isFile()) throw invalid();
    if (!overwrite) throw new SSHError('ssh_target_exists', '本地目标已存在，覆盖需要 overwrite=true');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

// 每次读取和写入均等待完成，自然施加背压；额外读取一个字节检查源在传输中增长。
export async function copyLimited(read: (buffer: Buffer, position: number) => Promise<number>, write: (buffer: Buffer, position: number) => Promise<void>, result: TransferResult, signal: AbortSignal, limit = MAX_TRANSFER_BYTES) {
  const buffer = Buffer.alloc(64 * 1024);
  while (true) {
    if (signal.aborted) throw interrupted(signal);
    const remaining = limit - result.bytes_transferred;
    const count = await read(buffer.subarray(0, Math.min(buffer.length, remaining || 1)), result.bytes_transferred);
    if (signal.aborted) throw interrupted(signal);
    if (!count) return;
    if (!remaining) throw new SSHError('ssh_transfer_limit', '文件在传输中超过 128 MiB 上限，上传可能遗留部分文件，下载原目标未替换');
    await write(buffer.subarray(0, count), result.bytes_transferred);
    result.bytes_transferred += count;
  }
}

export async function transfer(connection: Connection, direction: 'upload' | 'download', local: string, remote: string, overwrite: boolean, result: TransferResult) {
  validatePaths(local, remote);
  let file: FileHandle | undefined, sftp: SFTPWrapper | undefined, handle: Buffer | undefined, temp: string | undefined;
  let failure: unknown;
  try {
    if (connection.signal.aborted) throw interrupted(connection.signal);
    if (direction === 'upload') {
      const info = await lstat(local).catch(() => { throw invalid(); });
      if (!info.isFile() || info.size > MAX_TRANSFER_BYTES) throw invalid();
      file = await open(local, 'r');
      const actual = await file.stat();
      if (!actual.isFile() || actual.size > MAX_TRANSFER_BYTES) throw invalid();
    } else await localTarget(local, overwrite);
    sftp = await connection.wait<SFTPWrapper>(done => connection.client.sftp(done));
    // 保持 error 监听，连接关闭后的子系统错误不会成为未处理事件。
    sftp.on('error', () => {});
    const files = sftp;
    const wait = <T>(start: (done: (error: Error | undefined | null, value: T) => void) => void) => connection.wait(start, files);
    if (direction === 'upload') {
      let existing: Stats | undefined;
      try { existing = await wait<Stats>(done => files.lstat(remote, done)); }
      catch (error) { if ((error as { code?: number }).code !== 2) throw error; }
      if (existing) {
        if (!existing.isFile()) throw invalid();
        if (!overwrite) throw new SSHError('ssh_target_exists', '远端目标已存在，覆盖需要 overwrite=true');
      }
      handle = await wait<Buffer>(done => files.open(remote, overwrite ? 'w' : 'wx', done));
      const target = handle, source = file!;
      await copyLimited(async (buffer, position) => (await source.read(buffer, 0, buffer.length, position)).bytesRead,
        (buffer, position) => wait<void>(done => files.write(target, buffer, 0, buffer.length, position, done)), result, connection.signal);
    } else {
      const info = await wait<Stats>(done => files.lstat(remote, done));
      if (!info.isFile() || info.size > MAX_TRANSFER_BYTES) throw invalid();
      handle = await wait<Buffer>(done => files.open(remote, 'r', done));
      const source = handle;
      const actual = await wait<Stats>(done => files.fstat(source, done));
      if (!actual.isFile() || actual.size > MAX_TRANSFER_BYTES) throw invalid();
      const candidate = join(dirname(local), `.ssh-download-${randomUUID()}`);
      file = await open(candidate, 'wx', 0o600); temp = candidate;
      const target = file;
      await copyLimited((buffer, position) => wait<number>(done => files.read(source, buffer, 0, buffer.length, position, (error, bytes) => done(error, bytes))),
        async (buffer, position) => {
          let offset = 0;
          while (offset < buffer.length) {
            const { bytesWritten } = await target.write(buffer, offset, buffer.length - offset, position + offset);
            if (!bytesWritten) throw failed('本地文件写入未取得进展');
            offset += bytesWritten;
          }
        }, result, connection.signal);
      await target.sync();
    }
    const remoteHandle = handle;
    handle = undefined;
    await wait<void>(done => files.close(remoteHandle, done));
    await file!.close(); file = undefined;
    if (connection.signal.aborted) throw interrupted(connection.signal);
    if (direction === 'download') {
      await localTarget(local, overwrite);
      if (connection.signal.aborted) throw interrupted(connection.signal);
      if (overwrite) { await rename(temp!, local); temp = undefined; }
      else await link(temp!, local);
    }
  } catch (error) {
    failure = connection.signal.aborted ? interrupted(connection.signal) : error instanceof SSHError ? error : failed(direction === 'upload' ? 'SFTP 上传未完成；无法读取源或创建、写入及关闭目标，远端可能遗留部分文件，请检查后再操作' : 'SFTP 下载未完成或无法发布目标文件，原目标未替换；请检查权限、目标冲突及硬链接支持');
    connection.close();
  } finally {
    if (file) { try { await file.close(); } catch { if (!failure) failure = failed('本地文件关闭失败'); } }
    sftp?.end();
    if (temp) {
      try { await unlink(temp); }
      catch { failure = new SSHError(failure instanceof SSHError ? failure.code : 'ssh_transfer_failed', `${failure instanceof Error ? failure.message + '；' : ''}下载临时文件清理失败，请检查本地目录`); }
    }
  }
  if (failure) throw failure;
}
