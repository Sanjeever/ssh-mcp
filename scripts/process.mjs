import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const root = fileURLToPath(new URL('../', import.meta.url));
export function run(command, args, options = {}) {
  const { allowFailure = false, ...spawnOptions } = options;
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false, ...spawnOptions });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`${command} 执行失败，退出码 ${result.status ?? result.signal} ${result.stderr?.toString() ?? ''}`);
  return result;
}
