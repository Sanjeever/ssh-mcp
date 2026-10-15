import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { platforms } from './platforms.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败，退出码 ${result.status ?? result.signal}`);
  return result;
}

export function metadata(base = root) {
  const pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
  for (const platform of platforms) {
    const dir = join(base, 'dist/npm', platform.id);
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: platform.name, version: pkg.version,
      description: `SSH MCP 的 ${platform.id} 预编译二进制`,
      license: pkg.license, repository: pkg.repository, homepage: pkg.homepage, bugs: pkg.bugs,
      os: [platform.os], cpu: [platform.cpu], files: ['bin/', 'LICENSE', 'README.md'],
      publishConfig: { access: 'public' },
    }, null, 2) + '\n');
    copyFileSync(join(base, 'LICENSE'), join(dir, 'LICENSE'));
    writeFileSync(join(dir, 'README.md'), `# ${platform.name}\n\n此包包含 ${platform.id} 预编译二进制，由同版本 [@sanjeever/ssh-mcp](https://www.npmjs.com/package/@sanjeever/ssh-mcp) 自动选择。使用说明见 [项目 README](https://github.com/Sanjeever/ssh-mcp#readme)。\n`);
  }
}

export function build(target = 'all') {
  const selected = target === 'all' ? platforms : platforms.filter(p => p.id === target);
  if (!selected.length) throw new Error(`未知构建目标：${target}`);
  metadata();
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('应用版本必须是正式三段数字');
  for (const p of selected) {
    const output = join(root, 'dist/npm', p.id, 'bin', p.binary);
    run('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', output, './cmd/ssh-mcp'], {
      env: { ...process.env, CGO_ENABLED: '0', GOOS: p.goos, GOARCH: p.goarch },
    });
    chmodSync(output, 0o755);
    console.log(`已构建 ${p.id} ${version}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, target] = process.argv.slice(2);
  if (command === 'metadata') metadata();
  else if (command === 'build') build(target);
  else throw new Error('用法：build.mjs metadata 或 build [all|平台-架构]');
}
