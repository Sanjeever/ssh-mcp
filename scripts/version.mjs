import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, metadata } from './build.mjs';
import { platforms } from './platforms.mjs';

const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function validVersion(value) {
  return typeof value === 'string' && pattern.test(value) && value.split('.').every(n => Number.isSafeInteger(Number(n)));
}
function checkNotes(base, version) {
  let notes;
  try { notes = readFileSync(join(base, 'docs/releases', `${version}.md`), 'utf8'); }
  catch { throw new Error(`缺少更新日志 docs/releases/${version}.md`); }
  if (!notes.trim()) throw new Error(`更新日志不能为空 docs/releases/${version}.md`);
}
export function check(base, tag) {
  const pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
  if (!validVersion(pkg.version) || tag !== `v${pkg.version}`) throw new Error('标签必须为 vMAJOR.MINOR.PATCH，并与 package.json 版本一致');
  const dependencies = pkg.optionalDependencies ?? {};
  if (Object.keys(dependencies).length !== platforms.length || platforms.some(p => dependencies[p.name] !== pkg.version)) throw new Error('入口包必须精确依赖同版本的六个平台包');
  checkNotes(base, pkg.version);
  return pkg.version;
}
export function bump(base, version) {
  if (!validVersion(version)) throw new Error('请输入正式三段版本号，例如 0.1.1，不允许前导零或预发布后缀');
  checkNotes(base, version);
  const path = join(base, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.version = version;
  pkg.optionalDependencies = Object.fromEntries(platforms.map(p => [p.name, version]));
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  metadata(base);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, value, ...rest] = process.argv.slice(2);
  if (rest.length) throw new Error('参数过多');
  if (command === 'bump') {
    bump(root, value);
    console.log(`版本已更新为 ${value}。请运行 pnpm install --lockfile-only --offline --ignore-scripts，再将 package.json、pnpm-lock.yaml 与对应更新日志放入同一个发布准备提交。`);
  } else if (command === 'check') check(root, value);
  else throw new Error('用法：version.mjs bump <version> 或 check <v版本>');
}
