import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import ssh2 from 'ssh2';
import { SSHError } from '../errors.js';
const { utils } = ssh2;

const invalid = () => new SSHError('ssh_known_hosts_invalid', 'known_hosts 缺失、损坏或不可读取；连接已拒绝');
const rejected = () => new SSHError('ssh_host_key_rejected', 'SSH 主机密钥变化、被撤销或不符合信任规则；连接已拒绝，请核对服务器身份');
const writeFailed = () => new SSHError('ssh_known_hosts_write', 'known_hosts 追加或同步失败，未建立信任');
export const hostToken = (host: string, port: number) => port === 22 ? host : `[${host}]:${port}`;

function base64(value: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw invalid();
  const data = Buffer.from(value, 'base64');
  if (data.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) throw invalid();
  return data;
}
function matcher(pattern: string): (host: string, port: number) => boolean {
  if (pattern.startsWith('|')) {
    const parts = pattern.split('|');
    if (parts.length !== 4 || parts[1] !== '1') throw invalid();
    const salt = base64(parts[2]!), hash = base64(parts[3]!);
    if (hash.length !== 20) throw invalid();
    return (host, port) => timingSafeEqual(createHmac('sha1', salt).update(hostToken(host, port)).digest(), hash);
  }
  const patterns = pattern.split(',').map(value => {
    const negate = value.startsWith('!');
    if (negate) value = value.slice(1);
    if (!value) throw invalid();
    let port = 22;
    if (value.startsWith('[')) {
      const match = /^\[(.+)\]:(\d+)$/.exec(value);
      if (!match || +match[2]! < 1 || +match[2]! > 65535) throw invalid();
      value = match[1]!; port = +match[2]!;
    } else {
      const match = /^([^:]+):(\d+)$/.exec(value);
      if (match) {
        if (+match[2]! < 1 || +match[2]! > 65535) throw invalid();
        value = match[1]!; port = +match[2]!;
      }
    }
    const regex = new RegExp('^' + value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return { negate, port, regex };
  });
  return (host, port) => {
    let positive = false;
    for (const entry of patterns) {
      if (entry.port === port && entry.regex.test(host)) {
        if (entry.negate) return false;
        positive = true;
      }
    }
    return positive;
  };
}

// 密钥格式交给 ssh2 解析；此处实现 known_hosts 记录及匹配规则，不解析 SSH 字节协议。
export function checkTrust(content: string, host: string, port: number, key: Buffer): 'known' | 'unknown' {
  let known = false, matched = false, authority = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const fields = trimmed.split(/\s+/);
    const marker = fields[0]?.startsWith('@') ? fields.shift() : '';
    if (marker && marker !== '@revoked' && marker !== '@cert-authority') throw invalid();
    const [pattern, type, encoded] = fields;
    if (!pattern || !type || !encoded) throw invalid();
    const match = matcher(pattern);
    const data = base64(encoded);
    const parsed = utils.parseKey(`${type} ${encoded}`);
    if (parsed instanceof Error || parsed.type !== type || !parsed.getPublicSSH().equals(data)) throw invalid();
    if (marker === '@revoked') {
      // 与旧实现一致，撤销密钥在整个文件内生效。
      if (data.equals(key)) throw rejected();
      continue;
    }
    if (!match(host, port)) continue;
    if (marker === '@cert-authority') { authority = true; continue; }
    matched = true;
    if (data.equals(key)) known = true;
  }
  if (authority) throw new SSHError('ssh_host_key_rejected', '匹配的 known_hosts CA 规则需要 OpenSSH 主机证书，当前版本不支持，连接已拒绝且不会追加信任');
  if (known) return 'known';
  if (matched) throw rejected();
  return 'unknown';
}

function readTrust(path: string): string {
  try {
    if (!statSync(path).isFile()) throw invalid();
    return readFileSync(path, 'utf8');
  } catch { throw invalid(); }
}

// 同步检查与追加构成同进程临界区，保留符号链接，不协调外部 SSH 进程。
export function verifyHost(path: string, policy: 'accept_new' | 'strict', host: string, port: number, key: Buffer) {
  let content = '';
  if (existsSync(path)) content = readTrust(path);
  else {
    try { lstatSync(path); throw invalid(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw invalid(); }
    if (policy === 'strict') throw invalid();
  }
  if (checkTrust(content, host, port, key) === 'known') return;
  if (policy === 'strict') throw new SSHError('ssh_host_unknown', 'strict 策略拒绝未知 SSH 主机，请先核对并配置 known_hosts');
  let fd: number;
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); fd = openSync(path, 'a+', 0o600); }
  catch { throw writeFailed(); }
  try {
    if (!fstatSync(fd).isFile()) throw writeFailed();
    content = readFileSync(fd, 'utf8');
    if (checkTrust(content, host, port, key) === 'known') return;
    const parsed = utils.parseKey(key);
    if (parsed instanceof Error) throw rejected();
    const line = `${content && !content.endsWith('\n') ? '\n' : ''}${hostToken(host, port)} ${parsed.type} ${key.toString('base64')}\n`;
    try { writeSync(fd, line); fsyncSync(fd); } catch { throw writeFailed(); }
  } finally {
    try { closeSync(fd); } catch { throw writeFailed(); }
  }
}
