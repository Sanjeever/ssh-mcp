import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { npm } from './npm.mjs';

export function pack(dir, destination) {
  mkdirSync(destination, { recursive: true });
  const result = npm(['pack', dir, '--json', '--ignore-scripts', '--pack-destination', destination], { stdio: ['ignore', 'pipe', 'pipe'] });
  const [info] = JSON.parse(result.stdout);
  assert.deepEqual(info.files.map(file => file.path).sort(), ['LICENSE', 'README.md', 'dist/THIRD_PARTY_NOTICES.txt', 'dist/cli.js', 'package.json'].sort());
  return { path: join(destination, info.filename), info };
}
