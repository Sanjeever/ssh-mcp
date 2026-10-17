import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { startDropbear } from './helpers/dropbear-server.js';
import { startCLI } from './helpers/stdio.js';

for (const sftp of [false, true]) test(`独立 Dropbear / BusyBox：${sftp ? 'SFTP 与文本原子发布' : '无 SFTP 的能力诊断'}`, { skip: process.env.SSH_MCP_TEST_DROPBEAR !== '1', timeout: 180000 }, async t => {
  const s = await startDropbear(t, sftp);
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_SERVER_TEST_USERNAME: s.config.username, SSH_MCP_SERVER_TEST_PASSWORD: undefined, SSH_MCP_SERVER_TEST_PRIVATE_KEY_PATH: s.config.privateKeyPath, SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
  await p.init();
  const call = (name: string, args: Record<string, unknown>) => p.request('tools/call', { name, arguments: { server_id: 'test', ...args } }).result;
  const cat = await call('ssh_exec', { command: 'cat', stdin: 'Dropbear 中文输入\n', save_output: true, stdout_max_bytes: 256 });
  assert.equal(cat.isError, false); assert.equal(cat.structuredContent?.stdout, 'Dropbear 中文输入\n'); assert.equal(cat.structuredContent?.exit_code, 0);
  const failure = await call('ssh_exec', { command: 'exit 7' });
  assert.equal(failure.isError, true); assert.equal(failure.structuredContent?.exit_code, 7);
  const busybox = await call('ssh_exec', { command: "readlink /bin/sh; printf 'busybox\\n'" });
  assert.equal(busybox.isError, false); assert.match(String(busybox.structuredContent?.stdout), /busybox/);
  const capabilities = await call('ssh_probe', {});
  assert.equal(capabilities.isError, false); assert.equal(capabilities.structuredContent?.ssh, true);
  const info = capabilities.structuredContent?.sftp as { available: boolean; atomic_overwrite?: boolean; atomic_no_overwrite?: boolean };
  assert.equal(info.available, sftp);
  const source = join(s.root, 'source'); writeFileSync(source, 'name=old\nport=22\n');
  const uploaded = await call('ssh_upload', { local_path: source, remote_path: '/tmp/config', atomic: true });
  if (sftp) {
    assert.equal(info.atomic_overwrite, true); assert.equal(info.atomic_no_overwrite, true);
    assert.equal(uploaded.isError, false); assert.equal(uploaded.structuredContent?.publication_state, 'published');
    const read = await call('ssh_read_file', { remote_path: '/tmp/config' });
    assert.equal(read.isError, false); assert.equal(read.structuredContent?.content, 'name=old\nport=22\n');
    const edited = await call('ssh_edit_file', { remote_path: '/tmp/config', edits: [{ old_text: 'old', new_text: 'new' }, { old_text: 'port=22', new_text: 'port=2222' }], expected_revision: read.structuredContent?.revision });
    assert.equal(edited.isError, false); assert.equal(edited.structuredContent?.publication_state, 'published');
    assert.equal(edited.structuredContent?.replacements, 2);
    const target = join(s.root, 'download');
    assert.equal((await call('ssh_download', { remote_path: '/tmp/config', local_path: target })).isError, false);
    assert.equal(readFileSync(target, 'utf8'), 'name=new\nport=2222\n');
  } else {
    assert.equal(uploaded.isError, true); assert.equal(uploaded.structuredContent?.publication_state, 'not_published');
    const command = await call('ssh_exec', { command: "printf 'still usable\\n'" });
    assert.equal(command.structuredContent?.stdout, 'still usable\n');
  }
  p.child.stdin.end(); await p.closed;
});
