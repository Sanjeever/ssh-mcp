export const platforms = ['darwin', 'linux', 'win32'].flatMap(os => ['arm64', 'x64'].map(cpu => ({
  id: `${os}-${cpu}`,
  name: `@sanjeever/ssh-mcp-${os}-${cpu}`,
  os, cpu,
  goos: os === 'win32' ? 'windows' : os,
  goarch: cpu === 'x64' ? 'amd64' : cpu,
  binary: os === 'win32' ? 'ssh-mcp.exe' : 'ssh-mcp',
})));
