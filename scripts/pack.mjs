import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { npm } from './npm.mjs';

export function pack(dir, destination) {
  mkdirSync(destination, { recursive: true });
  const result = npm(['pack', dir, '--json', '--ignore-scripts', '--pack-destination', destination], { stdio: ['ignore', 'pipe', 'pipe'] });
  const [info] = JSON.parse(result.stdout);
  for (const file of info.files) assert.match(file.path, /^(package\.json|README\.md|LICENSE|dist\/[a-z0-9/.-]+\.js)$/);
  assert(info.files.some(file => file.path === 'dist/cli.js'));
  assert(!info.files.some(file => /dist\/(npm|packages|release)\//.test(file.path)));
  return { path: join(destination, info.filename), info };
}
