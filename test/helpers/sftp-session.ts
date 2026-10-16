import fs from 'node:fs';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import assert from 'node:assert/strict';
import type { Session } from 'ssh2';

export interface SFTPOptions {
  onOpen?: (path: string, flags: number) => void;
  onRead?: (offset: number) => void;
  onWrite?: (offset: number) => void;
  onClose?: () => void;
  statSize?: number;
  failReadAt?: number;
  failClose?: boolean;
  failSetstat?: boolean;
  failUnlink?: boolean;
  failWriteAt?: number;
  delayMs?: number;
  readDelayMs?: (offset: number) => number;
  shortReadBytes?: number;
  hangRead?: boolean;
  hangWrite?: boolean;
}

export function sftpSession(root: string, options: SFTPOptions = {}) {
  return (session: Session) => session.on('sftp', accept => {
    const sftp = accept(), handles = new Map<string, number>(); let next = 0, closed = false;
    const status = (id: number, error?: NodeJS.ErrnoException | null) => { if (!closed) sftp.status(id, error ? error.code === 'ENOENT' ? 2 : error.code === 'EACCES' ? 3 : 4 : 0); };
    const local = (path: string) => join(root, path.replace(/^\/+/, ''));
    const descriptor = (handle: Buffer) => {
      const fd = handles.get(handle.toString('hex'));
      assert(fd !== undefined);
      return fd;
    };
    sftp.on('error', () => {});
    sftp.on('close', () => { closed = true; for (const fd of handles.values()) fs.close(fd, () => {}); handles.clear(); });
    sftp.on('OPEN', (id, path, flags) => {
      const mode = ssh2.utils.sftp.flagsToString(flags);
      assert(mode);
      fs.open(local(path), mode, 0o600, (error, fd) => {
        if (error) return status(id, error);
        if (closed) return fs.close(fd, () => {});
        const handle = Buffer.alloc(4); handle.writeUInt32BE(++next); handles.set(handle.toString('hex'), fd);
        options.onOpen?.(path, flags); sftp.handle(id, handle);
      });
    });
    const stat = (id: number, callback: (done: (error: NodeJS.ErrnoException | null, info: fs.Stats) => void) => void) => callback((error, info) => {
      if (error) return status(id, error);
      if (!closed) sftp.attrs(id, { mode: info.mode, uid: info.uid, gid: info.gid, size: options.statSize ?? info.size, atime: Math.floor(info.atimeMs / 1000), mtime: Math.floor(info.mtimeMs / 1000) });
    });
    sftp.on('LSTAT', (id, path) => stat(id, done => fs.lstat(local(path), done)));
    sftp.on('FSTAT', (id, handle) => stat(id, done => fs.fstat(descriptor(handle), done)));
    sftp.on('FSETSTAT', (id, handle, attrs) => {
      if (options.failSetstat) { sftp.status(id, 3); return; }
      const fd = descriptor(handle);
      if (attrs.mode !== undefined) fs.fchmod(fd, attrs.mode, error => status(id, error));
      else if (attrs.uid !== undefined && attrs.gid !== undefined) fs.fchown(fd, attrs.uid, attrs.gid, error => status(id, error));
      else status(id);
    });
    sftp.on('REMOVE', (id, path) => { if (options.failUnlink) sftp.status(id, 3); else fs.unlink(local(path), error => status(id, error)); });
    sftp.on('READ', (id, handle, offset, length) => {
      if (options.hangRead) return;
      options.onRead?.(offset);
      if (options.failReadAt !== undefined && offset >= options.failReadAt) return status(id, new Error('读取失败'));
      const buffer = Buffer.alloc(Math.min(length, options.shortReadBytes ?? length)), fd = descriptor(handle);
      const read = () => fs.read(fd, buffer, 0, buffer.length, offset, (error, bytes) => {
        if (error) return status(id, error);
        if (!closed) bytes ? sftp.data(id, buffer.subarray(0, bytes)) : sftp.status(id, 1);
      });
      const latency = options.readDelayMs?.(offset) ?? options.delayMs ?? 0;
      if (latency) setTimeout(read, latency); else read();
    });
    sftp.on('WRITE', (id, handle, offset, data) => {
      options.onWrite?.(offset);
      if (options.hangWrite) return;
      if (options.failWriteAt !== undefined && offset >= options.failWriteAt) { sftp.status(id, 4); return; }
      const fd = descriptor(handle), write = () => fs.write(fd, data, 0, data.length, offset, error => status(id, error));
      if (options.delayMs) setTimeout(write, options.delayMs); else write();
    });
    sftp.on('CLOSE', (id, handle) => {
      const idString = handle.toString('hex'), fd = descriptor(handle); handles.delete(idString);
      fs.close(fd, error => { options.onClose?.(); status(id, error ?? (options.failClose ? new Error('关闭失败') : undefined)); });
    });
  });
}
