# SSH MCP

通过 stdio MCP 连接配置中的多台 SSH 服务器，执行命令、上传和下载文件。核心使用 Go，npm 入口自动选择预编译二进制，使用者无需安装 Go、本机 ssh 或 scp。

支持 macOS、Linux、Windows 的 x64 与 arm64。npm 启动器要求 Node.js 22 或更新版本，并启用 optionalDependencies。Linux 二进制以 `CGO_ENABLED=0` 构建。

## 客户端配置

以下适用于采用 `mcpServers` JSON 的客户端。其他客户端按其实际配置格式填写命令和环境变量。

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "@sanjeever/ssh-mcp@0.1.0"],
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

配置在启动时加载，修改后须重启 MCP 进程。启动和 `ssh_list` 均不逐台联网。程序不自动修改远端 `authorized_keys`，使用账号密码或已有私钥直接认证；未加密私钥省略 `PASSPHRASE`。

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

至少配置一台服务器。非法 ID、未知服务器字段、缺少必填项、认证冲突和非法端口会阻止启动。工具输入不接受凭据，列表和默认日志不返回凭据。密码与口令保存在客户端配置及进程环境中，客户端及同账号本地进程可能读取，程序不提供此边界上的凭据隔离。

## 主机信任

`SSH_MCP_HOST_KEY_POLICY` 默认 `accept_new`，也可设为 `strict`。`SSH_MCP_KNOWN_HOSTS` 默认指向用户主目录下 `.ssh/known_hosts`，可显式指定路径，支持主目录展开，不展开 `$VAR`。

`accept_new` 自动信任首次见到的主机密钥，成功追加到 known_hosts 后才继续认证；首次连接没有外部身份核对。`strict` 拒绝未知主机及缺失信任文件，须先通过可信方式核对并录入服务器密钥。已有密钥变化、撤销、文件损坏或不可读均拒绝连接，不自动替换记录。

复用 OpenSSH 明文、哈希主机名及非默认端口记录，追加保留原内容、权限和符号链接入口。Unix 新建目录采用 0700、新建文件采用 0600；Windows 的 Unix mode 不代表 ACL 保证。检查和追加在同一进程内串行，不能协调所有外部 SSH 程序。

## 四个工具

| 工具 | 输入 | 返回 |
| --- | --- | --- |
| `ssh_list` | 无参数 | `servers` 数组，按 `server_id` 排序；含用途、主机、端口、用户名、认证类型，不表示在线状态 |
| `ssh_exec` | `server_id`、`command`，可选 `timeout_seconds` | `server_id`、`stdout`、`stderr`、`exit_code`、`duration_ms`、`output_truncated` |
| `ssh_upload` | `server_id`、`local_path`、`remote_path`，可选 `overwrite`、`timeout_seconds` | 路径、`server_id`、`bytes_transferred`、`duration_ms` |
| `ssh_download` | 同上传 | 同上传 |

参数使用 snake_case，拒绝未知字段。超时默认 180 秒，范围 1–3600 秒，连接与认证握手另有 15 秒上限，并受总超时约束。每次远端调用使用独立连接。

`ssh_exec` 由远端默认 Shell 解释命令，无 PTY、无持续 Shell；一次调用中的 `cd` 和 `export` 不会延续。不会自动输入 sudo 密码，不承诺 MFA、OTP 或任意 keyboard-interactive 登录。stdout/stderr 合计保留最多 128 KiB，超出后继续排空；多字节截断和非法 UTF-8 会整理为合法 JSON 字符串。

非零退出码标记 MCP 工具错误并保留输出。没有收到退出状态时 `exit_code` 为 `null`。连接、认证、握手、超时、取消和非零退出可通过结构化 `error.code` 区分。失败结果保留执行输出或传输进度，并包含中文 `error.message`。超时、取消或连接中断后远端状态可能不确定，关闭连接不保证远端进程已停止，程序不自动重试命令。

传输通过 SFTP 支持单个普通文件，最大 128 MiB，持续检查实际传输字节数。`local_path` 是 MCP 进程机器上的绝对路径，以该进程账号权限访问，无额外工作区沙箱。`remote_path` 使用远端 SFTP 绝对路径（以 `/` 开头，Windows SFTP 可能使用 `/C:/...`），不展开远端 `~` 或环境变量，不创建父目录，不传目录或符号链接。

默认 `overwrite=false`。目标已存在时拒绝，目录和符号链接目标始终拒绝。下载先写同目录临时文件，完整传输并关闭文件后才发布；失败清理临时文件，保留原目标。禁止覆盖使用排他硬链接发布，要求本地文件系统支持硬链接；不支持时明确失败。显式覆盖使用系统重命名。上传失败可能遗留远端部分文件，须检查后处理。

## 开发与本地验证

Go 版本与依赖见 [go.mod](go.mod)，当前最低 Go 1.26.0，可由自动工具链下载，不修改全局 Go 配置。Node.js 22+ 用于启动器，开发使用 `packageManager` 指定的 pnpm。首次检出先生成平台元数据，再安装冻结锁文件中的本地 workspace 依赖：

```sh
node scripts/build.mjs metadata
pnpm install --frozen-lockfile --offline --ignore-scripts
go test -race ./...
go vet ./...
pnpm test
```

测试服务监听环回地址，密钥、known_hosts、传输文件均位于临时目录，不访问真实服务器。`-race` 需要平台支持与 C 编译器。Windows arm64 可运行普通 Go 测试，Go race 检测不支持该目标。

```sh
go run ./cmd/ssh-mcp --version
node scripts/build.mjs build darwin-arm64
pnpm pack:check
```

将构建目标换为本机平台：`darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64`、`win32-arm64`、`win32-x64`。`build all` 构建六个目标。平台包从 [统一矩阵](scripts/platforms.mjs) 和根版本生成至 `dist/npm/`，开发目录不提交。平台筛选警告表示 workspace 中包含其他系统包，不影响精确可选依赖。

`pack:check` 对入口包和本机平台包运行真实 `npm pack`，在临时目录从本地 tarball 离线安装，再验证 CLI、MCP 初始化和 `ssh_list`。这证明本机安装包可用，不等于公开 registry 的 `npx` 验证。开发直接 `go run` 默认报告 `dev`；打包构建通过 ldflags 注入根版本。

## 版本

根 [package.json](package.json) 的 `version` 是唯一应用版本源。每版中文日志放在 `docs/releases/<version>.md`，先编写非空日志，再运行：

```sh
pnpm bump 0.1.1
pnpm install --lockfile-only --offline --ignore-scripts
node scripts/version.mjs check v0.1.1
```

`bump` 同步入口版本、六项精确依赖和生成的平台元数据。缺失或空日志会在改写前拒绝。锁文件通过 pnpm 更新，将 `package.json`、`pnpm-lock.yaml` 与对应日志放入同一个发布准备提交。`check` 核对正式标签、版本、六项依赖和非空日志。首版不支持预发布版本，不自动提交、打标签或推送。

许可证为 [MIT](LICENSE)，版权归 Sanjeever。
