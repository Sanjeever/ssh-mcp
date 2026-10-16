import { chmodSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { root, run } from './process.mjs';
export function build() {
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc')]);
  chmodSync(join(root, 'dist/cli.js'), 0o755);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) build();
