import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { root, run } from './build.mjs';
import { npm } from './npm.mjs';
import { pack } from './pack-check.mjs';
import { platforms } from './platforms.mjs';
import { check } from './version.mjs';

const digest = (path, algorithm, encoding) => createHash(algorithm).update(readFileSync(path)).digest(encoding);
const manifestPath = join(root, 'dist/release-manifest.json');
const capture = { stdio: ['ignore', 'pipe', 'pipe'] };

export function prepare(tag = `v${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}`) {
  const version = check(root, tag);
  const assets = join(root, 'dist/release');
  const packages = join(root, 'dist/packages');
  for (const dir of [assets, packages]) { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }
  const manifest = { version, packages: [], assets: [] };
  for (const p of platforms) {
    const dir = join(root, 'dist/npm', p.id);
    const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(meta.version, version); assert.equal(meta.name, p.name);
    assert.deepEqual(meta.os, [p.os]); assert.deepEqual(meta.cpu, [p.cpu]);
    const filename = `ssh-mcp_${version}_${p.id}.${p.os === 'win32' ? 'zip' : 'tar.gz'}`;
    const archive = join(assets, filename), binary = join(dir, 'bin', p.binary);
    if (p.os === 'win32') run('zip', ['-j', '-q', archive, binary]);
    else run('tar', ['-czf', archive, '-C', join(dir, 'bin'), p.binary]);
    const temp = mkdtempSync(join(tmpdir(), 'ssh-mcp-archive-'));
    try {
      if (p.os === 'win32') run('unzip', ['-q', archive, '-d', temp]);
      else run('tar', ['-xzf', archive, '-C', temp]);
      assert.deepEqual(readdirSync(temp), [p.binary]);
      assert.equal(digest(join(temp, p.binary), 'sha256', 'hex'), digest(binary, 'sha256', 'hex'));
    } finally { rmSync(temp, { recursive: true, force: true }); }
    manifest.assets.push({ filename, sha256: digest(archive, 'sha256', 'hex') });
    const packed = pack(dir, packages);
    assert.equal(packed.info.name, p.name); assert.equal(packed.info.version, version);
    assert(packed.info.files.some(f => f.path === `bin/${p.binary}`));
    manifest.packages.push({ name: p.name, filename: packed.info.filename, integrity: packed.info.integrity });
  }
  const entry = pack(root, packages);
  manifest.packages.push({ name: entry.info.name, filename: entry.info.filename, integrity: entry.info.integrity });
  writeFileSync(join(assets, 'SHA256SUMS'), manifest.assets.map(a => `${a.sha256}  ${a.filename}\n`).join(''));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`已准备 ${version} 的六个归档、SHA256SUMS 和七个 npm tarball`);
}

export function validateManifest(manifest, base = root) {
  const version = check(base, `v${manifest.version}`);
  assert.deepEqual(manifest.packages.map(p => p.name), [...platforms.map(p => p.name), '@sanjeever/ssh-mcp']);
  assert.equal(manifest.assets.length, 6);
  for (const p of manifest.packages) {
    assert.match(p.filename, /^[a-z0-9.-]+\.tgz$/);
    assert.equal(`sha512-${digest(join(base, 'dist/packages', p.filename), 'sha512', 'base64')}`, p.integrity);
  }
  for (const [index, asset] of manifest.assets.entries()) {
    const p = platforms[index];
    assert.equal(asset.filename, `ssh-mcp_${version}_${p.id}.${p.os === 'win32' ? 'zip' : 'tar.gz'}`);
    assert.equal(digest(join(base, 'dist/release', asset.filename), 'sha256', 'hex'), asset.sha256);
  }
  assert.equal(readFileSync(join(base, 'dist/release/SHA256SUMS'), 'utf8'), manifest.assets.map(a => `${a.sha256}  ${a.filename}\n`).join(''));
}

// 仅明确的 E404 表示版本尚不存在；网络、认证及其他错误原样阻止发布。
export function registryState(result, expectedIntegrity) {
  let data;
  try { data = JSON.parse(result.stdout.toString()); } catch { throw new Error('无法解析 npm registry 响应，停止发布'); }
  if (result.status === 0) {
    if (data !== expectedIntegrity) throw new Error('npm 已有同版本包与本次 tarball 不一致，停止发布；请核对已有产物并准备新版本');
    return 'identical';
  }
  if (data?.error?.code === 'E404') return 'missing';
  throw new Error(`查询 npm 版本失败：${data?.error?.code ?? result.status}，停止发布`);
}

export function publishPackage(pkg, version, runner = npm) {
  const view = runner(['view', `${pkg.name}@${version}`, 'dist.integrity', '--json', '--registry=https://registry.npmjs.org'], { ...capture, allowFailure: true });
  if (registryState(view, pkg.integrity) === 'identical') {
    console.log(`已核对并跳过相同产物 ${pkg.name}@${version}`);
    return;
  }
  runner(['publish', join(root, 'dist/packages', pkg.filename), '--access', 'public', '--registry=https://registry.npmjs.org']);
  console.log(`已发布 ${pkg.name}@${version}`);
}

export function publish(tag) {
  const version = check(root, tag);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.version, version); validateManifest(manifest);
  const repo = process.env.GH_REPO;
  if (repo !== 'Sanjeever/ssh-mcp' || !process.env.GH_TOKEN) throw new Error('发布需要正确的 GH_REPO 和工作流 GH_TOKEN');
  const existing = run('gh', ['api', `repos/${repo}/releases/tags/${tag}`], { ...capture, allowFailure: true });
  let data;
  try { data = JSON.parse(existing.stdout.toString()); } catch { throw new Error('无法解析 GitHub Release 响应，停止发布'); }
  const files = [...manifest.assets.map(a => join(root, 'dist/release', a.filename)), join(root, 'dist/release/SHA256SUMS')];
  if (existing.status === 0) {
    if (!data.draft) throw new Error('该版本 GitHub Release 已公开，请核对发布状态；不会覆盖公开版本');
    run('gh', ['release', 'edit', tag, '--notes-file', `docs/releases/${version}.md`, '--title', tag]);
    run('gh', ['release', 'upload', tag, ...files, '--clobber']);
  } else if (String(data.status) === '404') {
    run('gh', ['release', 'create', tag, ...files, '--verify-tag', '--draft', '--title', tag, '--notes-file', `docs/releases/${version}.md`]);
  } else throw new Error('查询 GitHub Release 失败，停止发布');
  // manifest 固定为六个平台包在前，入口包最后；失败立即停止，保留 draft。
  for (const pkg of manifest.packages) publishPackage(pkg, version);
  run('gh', ['release', 'edit', tag, '--draft=false', '--latest']);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, tag, ...rest] = process.argv.slice(2);
  if (rest.length) throw new Error('参数过多');
  if (command === 'prepare') prepare(tag);
  else if (command === 'verify') validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  else if (command === 'publish') publish(tag);
  else throw new Error('用法：release.mjs prepare|verify|publish <v版本>');
}
