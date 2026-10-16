import type { SFTPWrapper } from 'ssh2';
import type { Connection } from './client.js';
import { SSHError, interrupted } from '../errors.js';

// ssh2 1.17 把 VERSION 扩展表保存在 _extensions，未公开查询 API。
// 此处只读协议协商结果，不发送可能写文件的扩展请求；升级 ssh2 时须运行独立服务端测试。
export function sftpCapabilities(files: SFTPWrapper) {
  const extensions: unknown = Reflect.get(files, '_extensions');
  if (!extensions || typeof extensions !== 'object') throw new SSHError('ssh_probe_failed', 'SSH 库未提供可识别的 SFTP 扩展信息');
  return { atomic_overwrite: Reflect.get(extensions, 'posix-rename@openssh.com') === '1', atomic_no_overwrite: Reflect.get(extensions, 'hardlink@openssh.com') === '1' };
}

export async function probe(connection: Connection) {
  let files: SFTPWrapper;
  try { files = await connection.wait<SFTPWrapper>(done => connection.client.sftp(done)); }
  catch (error) {
    if (connection.signal.aborted) throw interrupted(connection.signal);
    if (error instanceof SSHError || connection.closed) throw error;
    return { ssh: true, host_key_fingerprint: connection.hostKeyFingerprint, sftp: { available: false, reason: 'subsystem_unavailable' } };
  }
  files.on('error', () => {});
  try { return { ssh: true, host_key_fingerprint: connection.hostKeyFingerprint, sftp: { available: true, ...sftpCapabilities(files) } }; }
  finally { files.end(); }
}
