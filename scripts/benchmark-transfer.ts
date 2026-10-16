import assert from 'node:assert/strict';
import { openSync, closeSync, ftruncateSync } from 'node:fs';
import { join } from 'node:path';
import { startSSH } from '../test/helpers/ssh-server.js';
import { sftpSession } from '../test/helpers/sftp-session.js';
import { dial } from '../src/ssh/client.js';
import { transfer } from '../src/ssh/transfer.js';

const full = process.argv.slice(2).includes('--full');
assert(process.argv.slice(2).every(arg => arg === '--full'), '用法：benchmark-transfer.ts [--full]');
const records = [];
for (const latency of [0, 50, 100]) {
  const cleanups: (() => void | Promise<void>)[] = [];
  const s = await startSSH({ after: fn => { cleanups.push(fn); } }, { session: session => sftpSession(s.root, { delayMs: latency })(session) });
  try {
    for (const size of [1024, 4 * 1024 * 1024, ...(latency === 0 || full ? [120 * 1024 * 1024] : [])]) {
      for (const name of ['source', 'payload']) {
        const fd = openSync(join(s.root, name), 'w'); ftruncateSync(fd, size); closeSync(fd);
      }
      for (const direction of ['upload', 'download'] as const) for (const window of [1, 4]) {
        const connection = await dial(s.config, { servers: new Map(), knownHosts: join(s.root, 'known_hosts'), hostKeyPolicy: 'accept_new' }, new AbortController().signal);
        let peakRss = process.memoryUsage().rss, peakBuffers = process.memoryUsage().arrayBuffers;
        const sampler = setInterval(() => { const memory = process.memoryUsage(); peakRss = Math.max(peakRss, memory.rss); peakBuffers = Math.max(peakBuffers, memory.arrayBuffers); }, 10);
        const start = performance.now(), result = { bytes_transferred: 0 };
        try {
          await transfer(connection, direction, join(s.root, direction === 'upload' ? 'source' : 'download'), direction === 'upload' ? '/uploaded' : '/payload', true, result, undefined, { window });
          assert.equal(result.bytes_transferred, size);
          const duration = performance.now() - start;
          const record = { direction, size_bytes: size, request_delay_ms: latency, window, duration_ms: Math.round(duration), mib_per_second: Number((size / 1024 / 1024 / (duration / 1000)).toFixed(2)), process_peak_rss_mib: Math.round(peakRss / 1024 / 1024), process_peak_buffers_mib: Math.round(peakBuffers / 1024 / 1024) };
          records.push(record); process.stdout.write(JSON.stringify(record) + '\n');
        } finally { clearInterval(sampler); connection.close(); }
      }
    }
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
}
assert(records.length > 0);
