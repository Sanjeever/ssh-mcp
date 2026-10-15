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
      "args": ["-y", "@sanjeever/ssh-mcp@0.1.1"],
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

Go 版本与依赖见 [go.mod](go.mod)，最低 Go 1.26.0，项目通过 `toolchain` 选用 Go 1.26.9，可由自动工具链下载，不修改全局 Go 配置。Node.js 22+ 用于启动器，开发使用 `packageManager` 指定的 pnpm。首次检出先生成平台元数据，再安装冻结锁文件中的本地 workspace 依赖：

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

## 标签发布

[CI](.github/workflows/ci.yml) 在 main push、pull request 和发布流程中运行。配置 macOS、Linux、Windows 两种架构的原生测试与本地安装包检查，另在 Linux 执行六目标交叉编译；Linux x64 还覆盖 Node.js 22。工作流配置本身不代表各 runner 已运行通过。本地验证与平台实际运行须分别记录。

[发布工作流](.github/workflows/release.yml) 接收 `v*` 标签，随后严格校验 `vMAJOR.MINOR.PATCH`、根版本、六项依赖和中文日志，并确认标签提交属于 main 历史。全部原生检查、交叉编译和打包检查通过后才进入发布 job。该 job 使用 GitHub-hosted runner、Node.js 26、npm 11.20.0，开启 `id-token: write` 和发布所需的 `contents: write`，不配置 `NPM_TOKEN`。工作流没有使用 GitHub environment。

同一批二进制用于 npm 平台包和 GitHub 附件。Unix 附件为 `ssh-mcp_<version>_<platform>-<arch>.tar.gz`，Windows 为 `.zip`，解压直接得到可执行文件，另附 `SHA256SUMS`。Release 正文读取 `docs/releases/<version>.md`。发布脚本先建立并填充 draft Release，依次发布六个平台包，再发布入口包，全部成功后公开 Release。不同版本不会相互取消公开发布。

本地制作、解包检查和校验发布产物：

```sh
node scripts/build.mjs build all
node scripts/release.mjs prepare v0.1.1
node scripts/release.mjs verify
```

`prepare` 需要 `tar`、`zip` 和 `unzip`，发布构建在 Ubuntu runner 运行；本地 macOS 也可执行。产物位于 `dist/packages/`、`dist/release/` 和 `dist/release-manifest.json`。npm 包使用文件白名单，入口包不包含平台二进制，不运行 postinstall 或从 GitHub 下载文件。

完成版本提交和检查、确认 npm 侧已初始化后，**另行获得发布授权**再创建及推送标签。例如下一版本为 0.1.1 时：

```sh
git tag -a v0.1.1 -m "发布 v0.1.1"
git push origin main
git push origin v0.1.1
```

开发授权不包含上述推送、标签创建、真实发布或账户配置。`release.mjs publish` 会执行外部发布，不能将它当作本地检查命令。

### npm OIDC 首次初始化

以下依据 2026-10-15 查阅的 [npm 可信发布者文档](https://docs.npmjs.com/trusted-publishers/) 和 [npm trust 官方说明](https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-trust.md)。npm OIDC 要求 Node.js 至少 22.14.0、npm CLI 至少 11.5.1；CI 固定使用更高版本。启动器的 Node.js 22 要求独立于发布环境。

可信配置依附已经存在的 npm 包，不能假定新包第一次创建就能通过 OIDC。需要 `@sanjeever` scope 的发布权限，登录账号应启用 2FA。以下七个包分别需要初始化和可信发布者配置：

| 包名 | 用途 |
| --- | --- |
| `@sanjeever/ssh-mcp-darwin-arm64` | macOS arm64 |
| `@sanjeever/ssh-mcp-darwin-x64` | macOS x64 |
| `@sanjeever/ssh-mcp-linux-arm64` | Linux arm64 |
| `@sanjeever/ssh-mcp-linux-x64` | Linux x64 |
| `@sanjeever/ssh-mcp-win32-arm64` | Windows arm64 |
| `@sanjeever/ssh-mcp-win32-x64` | Windows x64 |
| `@sanjeever/ssh-mcp` | 入口包 |

若七个包均尚未创建，建议以完整有效的 0.1.0 包完成一次人工初始化，**首个自动 OIDC 版本使用后续版本，例如 0.1.1**。不要人工发布 0.1.0 后再直接推送 v0.1.0，期望工作流无条件重复发布相同版本。npm 名称和版本一经发布便不能重用。若这些包已有版本，先核对已有内容和所有权，再安排版本号，不能覆盖既有包。

1. 在已验证的待初始化提交构建、打包，检查 `dist/packages/` 中七个真实 tarball。也可在推送获授权后，从该提交成功 CI 的 `release-assets` 下载产物。不要发布占位包。
2. 获初始化授权后，在本机用 `npm login --auth-type=web` 交互登录。凭据不写进仓库、CI 或聊天。先发布平台包，最后发布入口包：

   ```sh
   npm publish dist/packages/sanjeever-ssh-mcp-darwin-arm64-0.1.0.tgz --access public
   npm publish dist/packages/sanjeever-ssh-mcp-darwin-x64-0.1.0.tgz --access public
   npm publish dist/packages/sanjeever-ssh-mcp-linux-arm64-0.1.0.tgz --access public
   npm publish dist/packages/sanjeever-ssh-mcp-linux-x64-0.1.0.tgz --access public
   npm publish dist/packages/sanjeever-ssh-mcp-win32-arm64-0.1.0.tgz --access public
   npm publish dist/packages/sanjeever-ssh-mcp-win32-x64-0.1.0.tgz --access public
   npm publish dist/packages/sanjeever-ssh-mcp-0.1.0.tgz --access public
   ```

3. 每个包进入 npm Settings → Trusted Publisher，选择 GitHub Actions，设置 owner 为 `Sanjeever`、repository 为 `ssh-mcp`、workflow filename 为 `release.yml`。Environment 留空，与当前 workflow 一致。允许直接 `npm publish`，不能设为仅 stage、每次仍需人工批准后又期待标签自动公开。CLI 管理配置另需 npm 11.15.0+ 和账号 2FA，也可使用网页。
4. 工作流文件必须已经存在于该 GitHub 仓库；公开仓库和公开包才满足自动 provenance 条件。新可信配置须在两天内完成首次成功 OIDC 发布以验证并绑定仓库身份，过期后要删除并重建。因此在下一个正式版本准备就绪时设置可信配置，再授权推送该版本标签。
5. 为后续版本编写真实更新日志，运行 bump、更新锁文件、执行检查并提交，再按授权创建和推送标签。七个包都必须配置完成。日常发布由 OIDC 认证，不需要 `NPM_TOKEN`。

如果还需要 0.1.0 的 GitHub Release，可在人工初始化后另行审阅、授权创建；不要用移动标签或覆盖 npm 版本的方式补齐。当前仓库提供完整流程，未代为创建包、配置可信发布者或真实发布。

### 部分发布与恢复

GitHub 和 npm 没有跨服务事务。平台包已公开后若下一步失败，已公开包仍存在，入口包可能尚未公开，Release 保持 draft。不要将工作流失败理解为全部未发布，也不要自动 unpublish 或移动标签。

先查看失败 job 日志中逐包的“已发布”或“已核对并跳过”记录，再用 `npm view <包>@<版本> dist.integrity --json` 与 `dist/release-manifest.json` 核对。优先对原运行选择 **Re-run failed jobs**，复用已完成构建的 `release-assets`，产物保留 14 天。恢复步骤会核对全部产物，恢复 draft 的正文和附件，跳过完整性完全一致的 npm 版本，继续缺失包，最后公开 Release。

网络、权限或其他 registry 错误会停止流程，发布命令本身的任何失败也会向上传递。同版本摘要不一致时拒绝继续，须核对已有发布内容并安排新版本；不能以“版本已存在”为由忽略冲突。Release 已公开时脚本拒绝覆盖，应先确认任务是否已经完成。产物过期或人工初始化后的包与重新构建摘要不一致，也不能声称可无条件重跑成功。

## 许可证与资料

许可证为 [MIT](LICENSE)，版权归 Sanjeever。

- [MCP Go SDK](https://github.com/modelcontextprotocol/go-sdk)
- [SSH](https://pkg.go.dev/golang.org/x/crypto/ssh) 与 [known_hosts](https://pkg.go.dev/golang.org/x/crypto/ssh/knownhosts)
- [SFTP](https://pkg.go.dev/github.com/pkg/sftp)
- [Node.js 子进程](https://nodejs.org/api/child_process.html)
- [npm 包字段](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
- [GitHub Release CLI](https://cli.github.com/manual/gh_release_create)
