import { once } from 'node:events';
import type { Session } from 'ssh2';

export function execSession(session: Session) {
  session.on('exec', async (accept, reject, info) => {
    const stream = accept(); stream.on('error', () => {});
    if (info.command === 'stdin') {
      stream.on('data', (data: Buffer) => stream.write(data));
      stream.on('end', () => { stream.exit(0); stream.end(); });
      return;
    }
    if (info.command === 'late_error') {
      stream.write('BEGIN\n' + '正常日志\n'.repeat(30000) + '\nEND\n');
      stream.stderr.write('最后的错误原因\n'); stream.exit(9); stream.end(); return;
    }
    if (info.command === 'hang') { stream.write('partial'); return; }
    if (info.command === 'large') {
      for (let i = 0; i < 150; i++) {
        if (!stream.write(Buffer.from('测试'.repeat(1024)))) await once(stream, 'drain').catch(() => {});
      }
    } else if (info.command === 'invalid') stream.write(Buffer.from([0xff, 0xfe, 0x78, 0xe4, 0xb8]));
    else { stream.write('remote ok\n'); stream.stderr.write('remote warning\n'); }
    if (info.command === 'signal') stream.exit('TERM');
    else if (info.command !== 'missing') stream.exit(info.command === 'fail' ? 7 : 0);
    stream.end();
  });
}
