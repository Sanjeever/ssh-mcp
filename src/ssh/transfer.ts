import { lstat, open, link, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { Connection } from './client.js';
import { SSHError, interrupted, failureReason } from '../errors.js';
import type { OperationContext } from '../errors.js';
import { copyLimited, MAX_TRANSFER_BYTES } from './copy.js';
export { copyLimited, MAX_TRANSFER_BYTES } from './copy.js';
import type { CopyOptions } from './copy.js';

export interface TransferResult { bytes_transferred: number; publication_state?: 'not_published' | 'unknown' | 'published'; temporary_path?: string; cleanup_pending?: boolean }
export interface TransferOptions extends Omit<CopyOptions, 'onFailure'> { atomic?: boolean }
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

export async function transfer(connection: Connection, direction: 'upload' | 'download', local: string, remote: string, overwrite: boolean, result: TransferResult, context: OperationContext = { phase: 'open', operation_state: 'not_started' }, options: TransferOptions = {}) {
  validatePaths(local, remote);
  const atomic = direction === 'upload' && options.atomic === true;
  const copyOptions = { ...options, onFailure: () => connection.close() };
  if (atomic) result.publication_state = 'not_published';
  let file: FileHandle | undefined, sftp: SFTPWrapper | undefined, handle: Buffer | undefined, temp: string | undefined, remoteTemp: string | undefined, existing: Stats | undefined, sftpClosed = false;
  let failure: unknown;
  try {
    context.phase = 'open';
    if (connection.signal.aborted) throw interrupted(connection.signal);
    if (direction === 'upload') {
      const info = await lstat(local).catch(error => { throw new SSHError('ssh_transfer_invalid', invalid().message, { reason: failureReason(error) }); });
      if (!info.isFile() || info.size > MAX_TRANSFER_BYTES) throw invalid();
      file = await open(local, 'r');
      const actual = await file.stat();
      if (!actual.isFile() || actual.size > MAX_TRANSFER_BYTES) throw invalid();
    } else await localTarget(local, overwrite);
    sftp = await connection.wait<SFTPWrapper>(done => connection.client.sftp(done));
    // 保持 error 监听，连接关闭后的子系统错误不会成为未处理事件。
    sftp.on('error', () => {});
    sftp.once('close', () => { sftpClosed = true; });
    const files = sftp;
    const wait = <T>(start: (done: (error: Error | undefined | null, value: T) => void) => void) => sftpClosed ? Promise.reject<T>(failed('SFTP 子系统已关闭')) : connection.wait(start, files);
    if (direction === 'upload') {
      try { existing = await wait<Stats>(done => files.lstat(remote, done)); }
      catch (error) { if ((error as { code?: number }).code !== 2) throw error; }
      if (existing) {
        if (!existing.isFile()) throw invalid();
        if (!overwrite) throw new SSHError('ssh_target_exists', '远端目标已存在，覆盖需要 overwrite=true');
      }
      context.operation_state = 'may_have_started';
      if (atomic) {
        remoteTemp = remote.slice(0, remote.lastIndexOf('/') + 1) + `.ssh-upload-${randomUUID()}`;
        result.temporary_path = remoteTemp; result.cleanup_pending = true;
      }
      handle = await wait<Buffer>(done => {
        if (atomic) files.open(remoteTemp!, 'wx', 0o600, done);
        else files.open(remote, overwrite ? 'w' : 'wx', done);
      });
      context.phase = 'write';
      const target = handle, source = file!;
      await copyLimited(async (buffer, position) => (await source.read(buffer, 0, buffer.length, position)).bytesRead,
        (buffer, position) => wait<void>(done => files.write(target, buffer, 0, buffer.length, position, done)), result, connection.signal, MAX_TRANSFER_BYTES, copyOptions);
      if (atomic && existing) {
        context.phase = 'metadata';
        const current = await wait<Stats>(done => files.fstat(target, done));
        if (current.uid !== existing.uid || current.gid !== existing.gid) await wait<void>(done => files.fsetstat(target, { uid: existing!.uid, gid: existing!.gid }, done));
        await wait<void>(done => files.fsetstat(target, { mode: existing!.mode & 0o777 }, done));
      }
    } else {
      const info = await wait<Stats>(done => files.lstat(remote, done));
      if (!info.isFile() || info.size > MAX_TRANSFER_BYTES) throw invalid();
      handle = await wait<Buffer>(done => files.open(remote, 'r', done));
      const source = handle;
      context.phase = 'read';
      const actual = await wait<Stats>(done => files.fstat(source, done));
      if (!actual.isFile() || actual.size > MAX_TRANSFER_BYTES) throw invalid();
      const candidate = join(dirname(local), `.ssh-download-${randomUUID()}`);
      context.operation_state = 'may_have_started';
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
        }, result, connection.signal, MAX_TRANSFER_BYTES, copyOptions);
      await target.sync();
    }
    const remoteHandle = handle;
    context.phase = 'close';
    handle = undefined;
    await wait<void>(done => files.close(remoteHandle, done));
    await file!.close(); file = undefined;
    if (connection.signal.aborted) throw interrupted(connection.signal);
    if (atomic) {
      context.phase = 'publish'; result.publication_state = 'unknown';
      try {
        await wait<void>(done => {
          try {
            if (overwrite) files.ext_openssh_rename(remoteTemp!, remote, done);
            else files.ext_openssh_hardlink(remoteTemp!, remote, done);
          } catch { done(new SSHError('ssh_transfer_failed', '服务器不支持原子发布所需的 SFTP 扩展', { reason: 'unsupported' }), undefined); }
        });
      } catch (error) {
        if (error instanceof SSHError && error.details.reason === 'unsupported' || typeof (error as { code?: unknown })?.code === 'number') result.publication_state = 'not_published';
        throw error;
      }
      result.publication_state = 'published'; context.operation_state = 'completed';
      if (overwrite) { remoteTemp = undefined; delete result.temporary_path; result.cleanup_pending = false; }
    }
    if (direction === 'download') {
      context.phase = 'publish';
      await localTarget(local, overwrite);
      if (connection.signal.aborted) throw interrupted(connection.signal);
      if (overwrite) { await rename(temp!, local); temp = undefined; }
      else await link(temp!, local);
    }
    context.operation_state = 'completed';
  } catch (error) {
    failure = connection.signal.aborted ? interrupted(connection.signal) : error instanceof SSHError ? error : failed(direction === 'upload' ? 'SFTP 上传未完成；无法读取源或创建、写入及关闭目标，远端可能遗留部分文件，请检查后再操作' : 'SFTP 下载未完成或无法发布目标文件，原目标未替换；请检查权限、目标冲突及硬链接支持');
    if (failure instanceof SSHError) failure = new SSHError(failure.code, failure.message, { reason: failureReason(error), ...failure.details });
  } finally {
    if (file) { try { await file.close(); } catch { if (!failure) failure = failed('本地文件关闭失败'); } }
    if (handle && sftp && !sftpClosed && !connection.closed && !connection.signal.aborted) {
      try { await connection.wait<void>(done => sftp!.close(handle!, done), sftp); }
      catch { if (!failure) failure = failed('远端文件关闭失败'); }
    }
    if (remoteTemp && sftp) {
      if (!sftpClosed && !connection.closed && !connection.signal.aborted) {
        try {
          await connection.wait<void>(done => sftp!.unlink(remoteTemp!, done), sftp);
          result.cleanup_pending = false; delete result.temporary_path;
        } catch (error) {
          if ((error as { code?: number }).code === 2) { result.cleanup_pending = false; delete result.temporary_path; }
          else if (!failure) failure = new SSHError('ssh_transfer_failed', '目标已发布，但上传临时文件清理失败', { phase: 'cleanup', operation_state: 'completed', reason: failureReason(error) });
        }
      } else if (!failure) failure = failed('上传临时文件未清理，请检查 temporary_path');
    }
    sftp?.end();
    if (temp) {
      try { await unlink(temp); }
      catch { failure = new SSHError(failure instanceof SSHError ? failure.code : 'ssh_transfer_failed', `${failure instanceof Error ? failure.message + '；' : ''}下载临时文件清理失败，请检查本地目录`, failure instanceof SSHError ? failure.details : { phase: 'cleanup' }); }
    }
  }
  if (failure) throw failure;
}
