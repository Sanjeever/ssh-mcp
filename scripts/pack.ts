import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { npm } from './npm.js';
import { z } from 'zod';

const packInfo = z.object({ name: z.string(), version: z.string(), filename: z.string(), integrity: z.string(), files: z.array(z.object({ path: z.string() })) });

export function pack(dir: string, destination: string) {
  mkdirSync(destination, { recursive: true });
  const result = npm(['pack', dir, '--json', '--ignore-scripts', '--pack-destination', destination], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert(result.stdout);
  const [info] = z.array(packInfo).length(1).parse(JSON.parse(result.stdout.toString()));
  assert(info);
  assert.deepEqual(info.files.map(file => file.path).sort(), ['LICENSE', 'README.md', 'dist/THIRD_PARTY_NOTICES.txt', 'dist/cli.js', 'package.json'].sort());
  return { path: join(destination, info.filename), info };
}
