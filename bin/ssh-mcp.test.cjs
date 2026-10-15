const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, chmodSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { platformPackage, resolveBinary } = require('./ssh-mcp.cjs');

test('六平台映射与不支持的平台', () => {
  for (const os of ['darwin', 'linux', 'win32']) for (const cpu of ['x64', 'arm64']) {
    assert.equal(platformPackage(os, cpu), `@sanjeever/ssh-mcp-${os}-${cpu}`);
  }
  assert.throws(() => platformPackage('freebsd', 'x64'), /不支持/);
  assert.throws(() => platformPackage('linux', 'ia32'), /不支持/);
  assert.throws(() => resolveBinary('linux', 'x64', () => { throw Object.assign(new Error(), { code: 'MODULE_NOT_FOUND' }); }), /optionalDependencies/);
});

test('启动器传递参数、环境、标准流与退出码', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'ssh-mcp-launcher-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const fixture = join(temp, 'fixture.go');
  writeFileSync(fixture, `package main
import("encoding/json";"fmt";"io";"os";"os/signal";"syscall")
func main(){
 if os.Getenv("FIXTURE_SIGNAL")=="1" { c:=make(chan os.Signal,1);signal.Notify(c,os.Interrupt,syscall.SIGTERM);fmt.Println("ready");s:=<-c;fmt.Fprintln(os.Stderr,s.String());os.Exit(23) }
 input,_:=io.ReadAll(os.Stdin);json.NewEncoder(os.Stdout).Encode(map[string]any{"args":os.Args[1:],"input":string(input),"env":os.Getenv("FIXTURE_ENV")});fmt.Fprintln(os.Stderr,"测试诊断");os.Exit(7)
}`);
  const dir = join(temp, 'node_modules', ...platformPackage(process.platform, process.arch).split('/'));
  mkdirSync(join(dir, 'bin'), { recursive: true }); mkdirSync(join(temp, 'bin'));
  copyFileSync(join(__dirname, 'ssh-mcp.cjs'), join(temp, 'bin/ssh-mcp.cjs'));
  const version = require('../package.json').version;
  writeFileSync(join(temp, 'package.json'), JSON.stringify({ version }));
  const manifest = join(dir, 'package.json');
  writeFileSync(manifest, JSON.stringify({ name: platformPackage(process.platform, process.arch), version }));
  const binary = join(dir, 'bin', process.platform === 'win32' ? 'ssh-mcp.exe' : 'ssh-mcp');
  const build = spawnSync('go', ['build', '-o', binary, fixture], { env: { ...process.env, CGO_ENABLED: '0' }, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const result = spawnSync(process.execPath, [join(temp, 'bin/ssh-mcp.cjs'), '有 空格', 'a;$x'], { env: { ...process.env, FIXTURE_ENV: '保留环境' }, input: '标准输入', encoding: 'utf8' });
  assert.equal(result.status, 7);
  assert.deepEqual(JSON.parse(result.stdout), { args: ['有 空格', 'a;$x'], input: '标准输入', env: '保留环境' });
  assert.equal(result.stderr, '测试诊断\n');
  assert.match(resolveBinary('win32', 'arm64', () => manifest), /ssh-mcp\.exe$/);
  writeFileSync(manifest, JSON.stringify({ version: '9.9.9' }));
  assert.throws(() => resolveBinary('linux', 'x64', () => manifest), /版本不一致/);
  const mismatch = spawnSync(process.execPath, [join(temp, 'bin/ssh-mcp.cjs')], { encoding: 'utf8' });
  assert.equal(mismatch.status, 1); assert.match(mismatch.stderr, /版本不一致/);
  writeFileSync(manifest, JSON.stringify({ version }));
  if (process.platform !== 'win32') {
    await t.test('终止信号传递给子进程', async () => {
      const child = spawn(process.execPath, [join(temp, 'bin/ssh-mcp.cjs')], { env: { ...process.env, FIXTURE_SIGNAL: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.once('data', () => child.kill('SIGTERM'));
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      const status = await new Promise((accept, reject) => { child.on('error', reject); child.on('exit', (code, signal) => accept({ code, signal })); });
      clearTimeout(timer); assert.equal(status.code, 23);
    });
    chmodSync(binary, 0o600);
    const denied = spawnSync(process.execPath, [join(temp, 'bin/ssh-mcp.cjs')], { encoding: 'utf8' });
    assert.equal(denied.status, 1); assert.match(denied.stderr, /EACCES/);
  }
  rmSync(binary);
  const missing = spawnSync(process.execPath, [join(temp, 'bin/ssh-mcp.cjs')], { encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /ENOENT/);
});
