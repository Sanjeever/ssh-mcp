import fs from 'node:fs';
import { join } from 'node:path';
import ssh2 from 'ssh2';

export function sftpSession(root, options = {}) {
  return session => session.on('sftp', accept => {
    const sftp = accept(), handles = new Map(); let next = 0, closed = false;
    const status = (id, error) => { if (!closed) sftp.status(id, error ? error.code === 'ENOENT' ? 2 : error.code === 'EACCES' ? 3 : 4 : 0); };
    const local = path => join(root, path.replace(/^\/+/, ''));
    sftp.on('error', () => {});
    sftp.on('close', () => { closed = true; for (const fd of handles.values()) fs.close(fd, () => {}); handles.clear(); });
    sftp.on('OPEN', (id, path, flags) => {
      fs.open(local(path), ssh2.utils.sftp.flagsToString(flags), 0o600, (error, fd) => {
        if (error) return status(id, error);
        if (closed) return fs.close(fd, () => {});
        const handle = Buffer.alloc(4); handle.writeUInt32BE(++next); handles.set(handle.toString('hex'), fd);
        options.onOpen?.(path, flags); sftp.handle(id, handle);
      });
    });
    const stat = (id, callback) => callback((error, info) => {
      if (error) return status(id, error);
      if (!closed) sftp.attrs(id, { mode: info.mode, uid: info.uid, gid: info.gid, size: options.statSize ?? info.size, atime: Math.floor(info.atimeMs / 1000), mtime: Math.floor(info.mtimeMs / 1000) });
    });
    sftp.on('LSTAT', (id, path) => stat(id, done => fs.lstat(local(path), done)));
    sftp.on('FSTAT', (id, handle) => stat(id, done => fs.fstat(handles.get(handle.toString('hex')), done)));
    sftp.on('READ', (id, handle, offset, length) => {
      if (options.hangRead) return;
      options.onRead?.(offset);
      if (options.failReadAt !== undefined && offset >= options.failReadAt) return status(id, new Error('读取失败'));
      const buffer = Buffer.alloc(length);
      fs.read(handles.get(handle.toString('hex')), buffer, 0, length, offset, (error, bytes) => {
        if (error) return status(id, error);
        if (!closed) bytes ? sftp.data(id, buffer.subarray(0, bytes)) : sftp.status(id, 1);
      });
    });
    sftp.on('WRITE', (id, handle, offset, data) => {
      if (options.hangWrite) return;
      options.onWrite?.(offset);
      fs.write(handles.get(handle.toString('hex')), data, 0, data.length, offset, error => status(id, error));
    });
    sftp.on('CLOSE', (id, handle) => {
      const idString = handle.toString('hex'), fd = handles.get(idString); handles.delete(idString);
      fs.close(fd, error => { options.onClose?.(); status(id, error ?? (options.failClose ? new Error('关闭失败') : undefined)); });
    });
  });
}
