import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, run } from './process.mjs';
import { npm } from './npm.mjs';
import { pack } from './pack.mjs';
import { check } from './version.mjs';

const digest = (path, algorithm, encoding) => createHash(algorithm).update(readFileSync(path)).digest(encoding);
const manifestPath = join(root, 'dist/release-manifest.json');
const capture = { stdio: ['ignore', 'pipe', 'pipe'] };

export function prepare(tag = `v${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}`) {
  const version = check(root, tag);
  const packages = join(root, 'dist/packages');
  mkdirSync(packages, { recursive: true });
  const entry = pack(root, packages);
  assert.equal(entry.info.name, '@sanjeever/ssh-mcp'); assert.equal(entry.info.version, version);
  const manifest = { version, package: { name: entry.info.name, filename: entry.info.filename, integrity: entry.info.integrity } };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`已准备 ${version} 的单个 npm tarball`);
}

export function validateManifest(manifest, base = root) {
  const version = check(base, `v${manifest.version}`);
  const p = manifest.package;
  assert.equal(p.name, '@sanjeever/ssh-mcp');
  assert.equal(p.filename, `sanjeever-ssh-mcp-${version}.tgz`);
  assert.equal(`sha512-${digest(join(base, 'dist/packages', p.filename), 'sha512', 'base64')}`, p.integrity);
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

export function publishPackage(pkg, version, runner = npm, base = root) {
  const view = runner(['view', `${pkg.name}@${version}`, 'dist.integrity', '--json', '--registry=https://registry.npmjs.org'], { ...capture, allowFailure: true });
  if (registryState(view, pkg.integrity) === 'identical') {
    console.log(`已核对并跳过相同产物 ${pkg.name}@${version}`);
    return;
  }
  runner(['publish', join(base, 'dist/packages', pkg.filename), '--access', 'public', '--registry=https://registry.npmjs.org']);
  console.log(`已发布 ${pkg.name}@${version}`);
}

export function publish(tag, { base = root, env = process.env, github = run, registry = npm } = {}) {
  const version = check(base, tag);
  const manifest = JSON.parse(readFileSync(join(base, 'dist/release-manifest.json'), 'utf8'));
  assert.equal(manifest.version, version); validateManifest(manifest, base);
  const repo = env.GH_REPO;
  if (repo !== 'Sanjeever/ssh-mcp' || !env.GH_TOKEN) throw new Error('发布需要正确的 GH_REPO 和工作流 GH_TOKEN');
  const existing = github('gh', ['api', `repos/${repo}/releases/tags/${tag}`], { ...capture, allowFailure: true });
  let data;
  try { data = JSON.parse(existing.stdout.toString()); } catch { throw new Error('无法解析 GitHub Release 响应，停止发布'); }
  const files = [join(base, 'dist/packages', manifest.package.filename)];
  if (existing.status === 0) {
    if (!data.draft) throw new Error('该版本 GitHub Release 已公开，请核对发布状态；不会覆盖公开版本');
    github('gh', ['release', 'edit', tag, '--notes-file', join(base, `docs/releases/${version}.md`), '--title', tag]);
    github('gh', ['release', 'upload', tag, ...files, '--clobber']);
  } else if (String(data.status) === '404') {
    github('gh', ['release', 'create', tag, ...files, '--verify-tag', '--draft', '--title', tag, '--notes-file', join(base, `docs/releases/${version}.md`)]);
  } else throw new Error('查询 GitHub Release 失败，停止发布');
  // 发布失败立即停止，保留 draft；恢复时核对同一 tarball 的完整性。
  publishPackage(manifest.package, version, registry, base);
  github('gh', ['release', 'edit', tag, '--draft=false', '--latest']);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, tag, ...rest] = process.argv.slice(2);
  if (rest.length) throw new Error('参数过多');
  if (command === 'prepare') prepare(tag);
  else if (command === 'verify') validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  else if (command === 'publish') publish(tag);
  else throw new Error('用法：release.mjs prepare|verify|publish <v版本>');
}
