import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBuiltin } from 'node:module';
import { build as bundle } from 'esbuild';

import { root } from './process.js';

function notices(inputs: string[]) {
  const packages = new Map<string, string>();
  for (const input of inputs) {
    if (!input.includes('node_modules/')) continue;
    let dir = dirname(resolve(root, input));
    while (dir !== dirname(dir)) {
      const path = join(dir, 'package.json');
      if (existsSync(path)) {
        const pkg = JSON.parse(readFileSync(path, 'utf8'));
        if (pkg.name && pkg.version) { packages.set(`${pkg.name}@${pkg.version}`, dir); break; }
      }
      dir = dirname(dir);
    }
  }
  return [...packages].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, dir]) => {
    const files = readdirSync(dir).filter(file => /^(?:licen[cs]e(?:[.-].*)?|copying|unlicense|notice(?:\.txt)?)$/i.test(file)).sort();
    assert(files.length, `依赖 ${name} 缺少许可文本，停止打包`);
    return `===== ${name} =====\n\n` + files.map(file => readFileSync(join(dir, file), 'utf8').trim()).join('\n\n');
  }).join('\n\n') + '\n';
}

export async function build() {
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  const result = await bundle({
    absWorkingDir: root,
    entryPoints: ['src/cli.ts'],
    outfile: 'dist/cli.js',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: true,
    charset: 'utf8',
    legalComments: 'eof',
    metafile: true,
    banner: { js: 'import { createRequire as _createRequire } from "node:module"; import { fileURLToPath as _fileURLToPath } from "node:url"; import { dirname as _dirname } from "node:path"; const require = _createRequire(import.meta.url); const __filename = _fileURLToPath(import.meta.url); const __dirname = _dirname(__filename);' },
    plugins: [{
      name: 'ssh2-javascript-crypto',
      setup(build) {
        // 使用 ssh2 已有的 JavaScript 实现和内嵌 WASM，不把可选原生模块带入发布包。
        build.onResolve({ filter: /^(?:cpu-features|\.\/crypto\/build\/Release\/sshcrypto\.node)$/ }, args => ({ path: args.path, namespace: 'ssh2-optional' }));
        build.onLoad({ filter: /.*/, namespace: 'ssh2-optional' }, () => ({ contents: 'throw new Error("单文件构建不加载可选原生加速模块");', loader: 'js' }));
      },
    }],
  });
  const outputs = Object.values(result.metafile.outputs);
  assert.equal(outputs.length, 1, '发布构建必须生成单个 JavaScript 文件');
  const output = outputs[0]; assert(output);
  for (const dependency of output.imports) assert(dependency.external && isBuiltin(dependency.path), `发现未打包的运行依赖 ${dependency.path}`);
  writeFileSync(join(root, 'dist/THIRD_PARTY_NOTICES.txt'), notices(Object.keys(result.metafile.inputs)));
  chmodSync(join(root, 'dist/cli.js'), 0o755);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();
