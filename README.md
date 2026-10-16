# SSH MCP

通过 stdio MCP 连接配置中的多台 SSH 服务器，执行命令、上传和下载文件。使用 TypeScript 开发，编译成 JavaScript，以单个 `@sanjeever/ssh-mcp` npm 包分发。运行要求 Node.js 22+，无需 TypeScript、Go、本机 ssh/scp 或编译工具。

支持 macOS、Linux、Windows 的 x64 与 arm64。ssh2 的原生加速为可选项，禁用安装脚本或省略可选依赖时仍可使用四个工具。0.2.0 起停止发布平台子包和独立 Go 二进制；直接使用旧二进制的用户须切换到 Node 入口，历史版本继续保留。

## 客户端配置

以下适用于采用 `mcpServers` JSON 的客户端。其他客户端按其实际配置格式填写命令和环境变量。

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "@sanjeever/ssh-mcp@0.2.0"],
      "env": {
        "SSH_MCP_SERVER_DEV_HOST": "192.0.2.10",
        "SSH_MCP_SERVER_DEV_USERNAME": "deploy",
        "SSH_MCP_SERVER_DEV_PASSWORD": "<dev-password>",
        "SSH_MCP_SERVER_DEV_DESCRIPTION": "开发环境",
        "SSH_MCP_SERVER_STAGING_HOST": "192.0.2.20",
        "SSH_MCP_SERVER_STAGING_PORT": "2222",
        "SSH_MCP_SERVER_STAGING_USERNAME": "deploy",
        "SSH_MCP_SERVER_STAGING_PRIVATE_KEY_PATH": "~/.ssh/id_ed25519",
        "SSH_MCP_SERVER_STAGING_PASSPHRASE": "<key-passphrase>",
        "SSH_MCP_SERVER_STAGING_DESCRIPTION": "测试环境"
      }
    }
  }
}
```

配置在启动时加载，修改后须重启 MCP 进程。启动和 `ssh_list` 均不逐台联网。程序不修改远端 `authorized_keys`，使用账号密码或已有私钥直接认证；未加密私钥省略 `PASSPHRASE`。

环境变量采用 `SSH_MCP_SERVER_<ID>_<FIELD>`。ID 以大写字母开头，由大写字母、数字和下划线组成，工具使用相应小写 ID，例如 `PROD_DB` 对应 `prod_db`。调用必须精确指定 ID，不自动选择默认服务器。

| 字段 | 说明 |
| --- | --- |
| `HOST` | 必填，主机名或 IP，IPv6 不加方括号，端口单独填写 |
| `PORT` | 默认 22，范围 1–65535 |
| `USERNAME` | 必填 |
| `PASSWORD` | 与 `PRIVATE_KEY_PATH` 二选一，保留原始空白 |
| `PRIVATE_KEY_PATH` | MCP 机器上的普通私钥文件路径，支持 `~/`；Windows 支持 `~\` |
| `PASSPHRASE` | 私钥口令，可选，保留原始空白 |
| `DESCRIPTION` | 可选，用于识别服务器用途 |

至少配置一台服务器。非法 ID、未知服务器字段、缺少必填项、认证冲突、非法端口及必要路径错误会阻止启动。路径支持主目录展开，不展开 `$VAR`。工具输入不接受凭据，列表与默认日志不返回凭据或私钥路径。密码与口令保存在客户端配置及进程环境中，客户端及同账号本地进程可能读取，程序不提供此边界上的凭据隔离。

## 主机信任

`SSH_MCP_HOST_KEY_POLICY` 默认 `accept_new`，也可设为 `strict`。`SSH_MCP_KNOWN_HOSTS` 默认指向 `~/.ssh/known_hosts`，可显式指定路径。

`accept_new` 自动信任首次见到的主机密钥，成功追加到 known_hosts 后才继续认证；首次连接没有外部身份核对。`strict` 拒绝未知主机及缺失信任文件，须先通过可信方式核对并录入服务器密钥。已有密钥变化、撤销、文件损坏或不可读均拒绝连接，不自动替换记录。

支持 OpenSSH 明文与哈希主机名、非默认端口、IPv6、多主机、通配与否定规则。撤销密钥在整个文件内生效，与旧实现一致。追加保留原内容、注释、权限、符号链接入口，并处理末尾缺少换行。Unix 新建目录采用 0700、新建文件采用 0600；Windows 的 Unix mode 不代表 ACL 保证。检查和追加在同一进程内串行，不协调外部 SSH 程序。

**主机证书限制**：ssh2 不支持 OpenSSH 主机证书协商。经迁移确认，匹配 `@cert-authority` 规则的连接明确拒绝，返回 `ssh_host_key_rejected`，且不追加信任。无法解析的证书记录按无效信任文件拒绝，不忽略记录。依赖 CA 主机证书的服务器不能通过此版本连接，应先评估迁移适用性。

## 四个工具

| 工具 | 输入 | 返回 |
| --- | --- | --- |
| `ssh_list` | 无参数 | `servers` 数组，按 `server_id` 排序；含用途、主机、端口、用户名、认证类型，不表示在线状态 |
| `ssh_exec` | `server_id`、`command`，可选 `timeout_seconds` | `server_id`、`stdout`、`stderr`、`exit_code`、`duration_ms`、`output_truncated` |
| `ssh_upload` | `server_id`、`local_path`、`remote_path`，可选 `overwrite`、`timeout_seconds` | 路径、`server_id`、`bytes_transferred`、`duration_ms` |
| `ssh_download` | 同上传 | 同上传 |

参数使用 snake_case，拒绝未知字段。超时默认 180 秒，范围 1–3600 秒，连接与认证握手另有 15 秒上限，并受总超时约束。每次远端调用使用独立连接，结束后关闭。

`ssh_exec` 由远端默认 Shell 解释命令，无 PTY、无持续 Shell；一次调用中的 `cd` 和 `export` 不会延续。不会自动输入 sudo 密码，不承诺 MFA、OTP 或任意 keyboard-interactive 登录。stdout/stderr 合计保留最多 128 KiB，超出后继续排空；截断边界处不完整的 UTF-8 序列丢弃，内部连续非法字节以 `?` 替换。

非零退出码标记 MCP 工具错误并保留输出。没有收到数值退出状态时 `exit_code` 为 `null`，不由信号推导数值。成功和失败均提供 `structuredContent` 与 JSON 文本结果；失败通过 `isError` 及 `error.code`、中文 `error.message` 表达，保留已有输出或传输进度。参数校验失败提供中文工具错误，不回显参数值。超时、取消或连接中断后远端状态可能不确定，关闭连接不保证远端进程已停止，程序不自动重试命令。

传输通过 SFTP 支持单个普通文件，最大 128 MiB，持续检查实际传输字节数。`local_path` 是 MCP 进程机器上的绝对路径，以该进程账号权限访问，无额外工作区沙箱。`remote_path` 使用远端 SFTP 绝对路径，以 `/` 开头（Windows SFTP 可能使用 `/C:/...`），不通过本机 path 改写，不展开远端 `~` 或环境变量，不创建父目录，不传目录或符号链接。

默认 `overwrite=false`，实际创建使用排他模式。目标已存在时拒绝，目录和符号链接目标始终拒绝。下载先写同目录临时文件，完整传输并成功关闭文件后才发布；失败或取消清理临时文件，保留原目标。禁止覆盖使用排他硬链接发布，要求本地文件系统支持硬链接；不支持时明确失败。显式覆盖使用系统重命名。上传失败可能遗留远端部分文件，须检查后处理。

stdout 专用于 MCP 协议，无启动 banner。诊断写 stderr，默认不记录凭据、完整命令、命令输出或整份工具参数。保留 `ssh-mcp --version`。

## 开发与本地验证

开发使用 [package.json](package.json) 指定的 pnpm 11.20.0，要求 Node.js 22.13+；应用运行最低版本为 Node.js 22.0.0。TypeScript 使用 strict 与 NodeNext，通过 tsc 编译，无运行时 TS 加载器。pnpm 配置文件只保留单包安装策略，禁用 ssh2 和 cpu-features 的可选原生构建。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm build
pnpm test
pnpm pack:check
node dist/cli.js --version
```

离线安装前先运行 `pnpm fetch --frozen-lockfile` 准备 registry 依赖缓存，再运行 `pnpm install --frozen-lockfile --offline --ignore-scripts`。CI 环境设有 `CI=true`。测试针对编译产物，修改源码后先构建。

测试采用 node:test、临时密钥、临时 known_hosts 与 Node 环回 SSH/SFTP 服务，不连接真实服务器。官方 SDK 客户端和真实 stdio 测试覆盖四工具 Schema、结构化结果及生命周期。`pack:check` 真实执行 npm pack，在仓库外使用独立缓存完成正常安装、禁用脚本和省略可选依赖三条路径，验证 CLI、初始化、四工具调用与 SFTP 往返。Unix 正常安装的 PATH 不提供编译器。

包内通过 files 白名单发布编译 JS、package.json、README 和 LICENSE，排除源码、测试、凭据和发布产物。安装与首次启动不下载应用二进制、不运行 tsc、不需要开发依赖。

## 版本与发布准备

根 [package.json](package.json) 的 `version` 是唯一应用版本源，CLI 与 MCP server info 读取同一字段，安装后的包内路径也有验证。每版中文日志放在 `docs/releases/<version>.md`，先编写非空日志，再运行：

```sh
pnpm bump 0.2.0
pnpm install --lockfile-only --offline --ignore-scripts
node scripts/version.mjs check v0.2.0
```

`bump` 在改写前校验正式三段版本和非空中文日志，不自动提交、打标签或推送。版本、锁文件和对应日志放在同一个发布准备提交。迁移说明和本机性能数据见 [0.2.0 日志](docs/releases/0.2.0.md)。

[CI](.github/workflows/ci.yml) 集中编译一次，生成一个 npm tarball 和恢复所需的版本、文件名、完整性记录。macOS、Linux、Windows 的 x64/arm64 原生矩阵，以及 Node.js 22.0.0 任务，复用同一份 JS 与 tarball，测试时不重新构建。工作流配置不代表各 runner 已运行通过。

本地制作并核对发布包：

```sh
pnpm build
node scripts/release.mjs prepare v0.2.0
node scripts/release.mjs verify
node scripts/pack-check.mjs dist/packages/sanjeever-ssh-mcp-0.2.0.tgz
```

产物位于 `dist/packages/`，完整性记录为 `dist/release-manifest.json`。发布准备完成后，不重新构建或重打包替换已验证产物。

## 标签发布与恢复

[release.yml](.github/workflows/release.yml) 接收 `v*` 标签，严格校验正式版本、中文日志与 main 历史，等待原生矩阵和安装验证通过，然后使用原 tarball 发布单个 npm 包。发布 job 使用 Node.js 26、npm 11.20.0、`id-token: write` 和 `contents: write`，通过 npm OIDC 认证，不配置日常 `NPM_TOKEN`。工作流不使用 GitHub environment。

发布前需核对根包 `@sanjeever/ssh-mcp` 的 npm Trusted Publisher，owner 为 `Sanjeever`、repository 为 `ssh-mcp`、workflow filename 为 `release.yml`，Environment 留空，并允许直接发布。相关要求见 [npm 可信发布者文档](https://docs.npmjs.com/trusted-publishers/)。账户初始化或配置变更须单独授权。六个旧平台包不再参与发布，也不自动删除、unpublish 或 deprecate。

**推送、创建发布标签、GitHub Release、npm 发布和账户配置须另行授权。** `release.mjs publish` 执行外部写入，不能用作本地检查。

发布脚本先创建或恢复 draft Release，并附同一 tarball；npm 成功后才公开 Release。npm 或 GitHub 查询错误、发布错误均停止流程，已公开的 npm 版本不会自动撤回。恢复时优先对原工作流选择 Re-run failed jobs，复用保留 14 天的 `release-assets`。脚本仅对明确 E404 视为版本不存在；已有版本须与 tarball 的 `dist.integrity` 完全一致，才跳过发布。同版本摘要冲突或 Release 已公开时拒绝继续。产物过期后重新打包不能保证摘要相同。

## 启动性能测量

使用 [benchmark.mjs](scripts/benchmark.mjs) 从进程启动测到 MCP initialize 响应，默认 30 次，输出中位数和 P95：

```sh
node scripts/benchmark.mjs node dist/cli.js
node scripts/benchmark.mjs npm exec --offline --yes --package=/绝对路径/包.tgz -- ssh-mcp
```

第二项先预热 npm exec 缓存，并在仓库外运行，避免解析到当前项目。直接入口、缓存启动与首次安装分开记录。使用本地 tarball 验证未发布版本，不等于公开 registry 的首次 npx 安装；不以不稳定公网耗时作为 CI 门槛。

## 许可证与资料

许可证为 [MIT](LICENSE)，版权归 Sanjeever。

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [ssh2](https://github.com/mscdex/ssh2)
- [Zod](https://zod.dev/)
- [Node 测试](https://nodejs.org/api/test.html)、[文件](https://nodejs.org/api/fs.html)与[流](https://nodejs.org/api/stream.html)
- [npm 包字段](https://docs.npmjs.com/cli/configuring-npm/package-json/)与[npm exec](https://docs.npmjs.com/cli/commands/npm-exec/)
