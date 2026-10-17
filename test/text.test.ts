import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startSSH } from './helpers/ssh-server.js';
import { sftpSession } from './helpers/sftp-session.js';
import { startCLI } from './helpers/stdio.js';
import { readText, textLines, applyTextEdits, MAX_TEXT_BYTES } from '../src/ssh/text.js';
import { dial } from '../src/ssh/client.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

test('文本行分页保留 CRLF、末尾换行和空文件，不跨行截断', () => {
  const input = { content: '第一行\r\n第二行\n末行', revision: 'revision', bytes: 0 };
  assert.deepEqual(textLines(input, 2, 1), { content: '第二行\n', start_line: 2, end_line: 2, next_line: 3, total_lines: 3, revision: 'revision', file_bytes: 0 });
  assert.equal(textLines(input, 1, 100).content, input.content);
  assert.equal(textLines({ ...input, content: '' }, 1, 10).total_lines, 0);
  assert.equal(textLines({ ...input, content: 'a\n' }, 1, 10).content, 'a\n');
  assert.throws(() => textLines(input, 5, 1), { code: 'ssh_input_invalid' });
  assert.throws(() => textLines({ ...input, content: 'a'.repeat(100000) }, 1, 1), { code: 'ssh_text_limit' });
  const page = textLines({ ...input, content: ('a'.repeat(60000) + '\n').repeat(2) }, 1, 2);
  assert.equal(page.next_line, 2); assert.equal(page.content.length, 60001);
});

test('SFTP 文本读取持续限制源增长并拒绝二进制，关闭失败不伪造成功', async t => {
  for (const options of [{}, { statSize: 1 }, { failClose: true }]) {
    const s = await startSSH(t, { session: session => sftpSession(s.root, options)(session) });
    writeFileSync(join(s.root, 'invalid'), Buffer.from([0xff, 0x00])); writeFileSync(join(s.root, 'large'), Buffer.alloc(MAX_TEXT_BYTES + 1, 97)); writeFileSync(join(s.root, 'valid'), '中文\n');
    for (const [path, code] of [['/invalid', 'ssh_text_invalid'], ['/large', 'ssh_text_limit'], ['/valid', options.failClose ? 'ssh_text_failed' : null]] as const) {
      const connection = await dial(s.config, { servers: new Map(), knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' }, new AbortController().signal);
      try { if (code) await assert.rejects(readText(connection, path), { code }); else assert.equal((await readText(connection, path)).content, '中文\n'); }
      finally { connection.close(); }
    }
  }
});

test('批量编辑基于原始内容匹配，支持相邻替换、删除、乱序和 UTF-8，拒绝歧义与重叠', () => {
  assert.equal(applyTextEdits('甲乙\r\n备注\n', [
    { old_text: '备注', new_text: '' }, { old_text: '乙', new_text: '甲' }, { old_text: '甲', new_text: '乙😀' },
  ]).toString(), '乙😀甲\r\n\n');
  assert.equal(applyTextEdits('old next', [
    { old_text: 'old', new_text: 'next' }, { old_text: 'next', new_text: 'last' },
  ]).toString(), 'next last');
  for (const edits of [
    [{ old_text: 'missing', new_text: 'x' }],
    [{ old_text: 'aa', new_text: 'x' }],
    [{ old_text: 'aaab', new_text: 'x' }, { old_text: 'ab', new_text: 'y' }],
    [{ old_text: 'b', new_text: 'x' }, { old_text: 'b', new_text: 'y' }],
  ]) assert.throws(() => applyTextEdits('aaab', edits), { code: 'ssh_text_match' });
  assert.throws(() => applyTextEdits('ab', [
    { old_text: 'a', new_text: '中'.repeat(180000) }, { old_text: 'b', new_text: '文'.repeat(180000) },
  ]), { code: 'ssh_text_limit' });
});

test('真实 MCP 编辑拒绝过期版本、缺失或歧义匹配及不支持的原子发布', async t => {
  const s = await startSSH(t, { session: session => sftpSession(s.root)(session) });
  const path = join(s.root, 'config'); writeFileSync(path, 'name=old\n重复 重复\n');
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
  await p.init();
  const read = await p.request('tools/call', { name: 'ssh_read_file', arguments: { server_id: 'test', remote_path: '/config', line_count: 1 } }).result;
  assert.equal(read.isError, false); assert.equal(read.structuredContent?.content, 'name=old\n'); assert.equal(read.structuredContent?.next_line, 2);
  const original = readFileSync(path, 'utf8');
  for (const [old_text, expected_revision, code] of [['name=old', '0'.repeat(64), 'ssh_text_conflict'], ['missing', read.structuredContent?.revision, 'ssh_text_match'], ['重复', read.structuredContent?.revision, 'ssh_text_match'], ['name=old', read.structuredContent?.revision, 'ssh_transfer_failed']] as const) {
    const edited = await p.request('tools/call', { name: 'ssh_edit_file', arguments: { server_id: 'test', remote_path: '/config', old_text, new_text: 'name=new', expected_revision } }).result;
    assert.equal(edited.isError, true); assert.equal((edited.structuredContent?.error as { code: string }).code, code);
    assert.equal(edited.structuredContent?.publication_state, 'not_published'); assert.equal(readFileSync(path, 'utf8'), original);
    assert(!readdirSync(s.root).some(name => name.startsWith('.ssh-upload-')));
  }
  for (const [edits, code] of [
    [[{ old_text: 'name=old', new_text: 'name=new' }, { old_text: 'missing', new_text: 'x' }], 'ssh_text_match'],
    [[{ old_text: 'name=old', new_text: 'name=new' }, { old_text: 'old', new_text: 'x' }], 'ssh_text_match'],
    [[{ old_text: 'name=old', new_text: 'name=new' }, { old_text: '重复 重复', new_text: '备注' }], 'ssh_transfer_failed'],
  ] as const) {
    const edited: CallToolResult = await p.request('tools/call', { name: 'ssh_edit_file', arguments: { server_id: 'test', remote_path: '/config', edits, expected_revision: read.structuredContent?.revision } }).result;
    assert.equal((edited.structuredContent?.error as { code: string }).code, code);
    assert.equal(edited.structuredContent?.publication_state, 'not_published'); assert.equal(readFileSync(path, 'utf8'), original);
    assert(!readdirSync(s.root).some(name => name.startsWith('.ssh-upload-')));
  }
  for (const args of [
    {}, { old_text: 'old' }, { new_text: 'new' }, { old_text: 'old', new_text: 'old' }, { edits: [] },
    { edits: [{ old_text: '', new_text: 'x' }] }, { edits: [{ old_text: 'x', new_text: 'x' }] },
    { edits: [{ old_text: 'old', new_text: 'new', extra: true }] },
    { old_text: 'old', new_text: 'new', edits: [{ old_text: 'old', new_text: 'new' }] },
    { edits: Array.from({ length: 101 }, () => ({ old_text: 'old', new_text: 'new' })) },
    { edits: Array.from({ length: 3 }, () => ({ old_text: 'x'.repeat(400000), new_text: 'y'.repeat(400000) })) },
  ]) {
    const invalid: CallToolResult = await p.request('tools/call', { name: 'ssh_edit_file', arguments: { server_id: 'test', remote_path: '/config', expected_revision: read.structuredContent?.revision, ...args } }).result;
    assert.equal((invalid.structuredContent?.error as { code: string }).code, 'ssh_input_invalid');
    assert.equal(readFileSync(path, 'utf8'), original);
  }
  p.child.stdin.end(); await p.closed;
});

test('发布前再次检查文件变化，保留外部写入内容并清理临时文件', async t => {
  const s = await startSSH(t, { session: session => sftpSession(s.root, { onWrite: () => writeFileSync(join(s.root, 'config'), '外部修改\n') })(session) });
  writeFileSync(join(s.root, 'config'), 'name=old\nport=22\n');
  const p = startCLI(t, { SSH_MCP_SERVER_TEST_HOST: s.config.host, SSH_MCP_SERVER_TEST_PORT: String(s.config.port), SSH_MCP_KNOWN_HOSTS: join(s.root, 'known_hosts') });
  await p.init();
  const read = await p.request('tools/call', { name: 'ssh_read_file', arguments: { server_id: 'test', remote_path: '/config' } }).result;
  const result = await p.request('tools/call', { name: 'ssh_edit_file', arguments: { server_id: 'test', remote_path: '/config', edits: [{ old_text: 'old', new_text: 'new' }, { old_text: 'port=22', new_text: 'port=2222' }], expected_revision: read.structuredContent?.revision } }).result;
  assert.equal((result.structuredContent?.error as { code: string }).code, 'ssh_text_conflict'); assert.equal(result.structuredContent?.publication_state, 'not_published');
  assert.equal(readFileSync(join(s.root, 'config'), 'utf8'), '外部修改\n'); assert(!readdirSync(s.root).some(name => name.startsWith('.ssh-upload-')));
  p.child.stdin.end(); await p.closed;
});
