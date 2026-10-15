import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { run } from './build.mjs';

// 直接运行 npm CLI 的 JS 入口，避免 Windows .cmd 需要 Shell 解释。
export function npm(args, options = {}) {
  const candidates = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (process.platform !== 'win32' && existsSync(join(dir, 'npm'))) candidates.push(realpathSync(join(dir, 'npm')));
    candidates.push(join(dir, 'node_modules/npm/bin/npm-cli.js'), join(dir, '../npm/bin/npm-cli.js'));
  }
  const cli = candidates.find(path => existsSync(path) && path.endsWith('npm-cli.js'));
  if (!cli) throw new Error('无法找到 npm CLI，请安装包含 npm 的 Node.js 发行版');
  return run(process.execPath, [cli, ...args], options);
}
