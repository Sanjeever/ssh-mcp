# ssh-mcp 实现交接

本文交接用户已经确认的需求、实现边界和验收标准。接手 Agent 应在当前仓库完成实现，按可验证的功能增量逐步提交。本文是实现输入，尚不代表功能已经完成或发布。

## 1. 项目与已确认决策

- 工作目录：`/Users/sanjeev/code/go/ssh-mcp`。
- GitHub：`https://github.com/Sanjeever/ssh-mcp`。
- npm 入口包：`@sanjeever/ssh-mcp`，公开发布。
- Go module 使用 `github.com/Sanjeever/ssh-mcp`。
- 当前仓库已经初始化，分支为 `main`，尚无提交；实际 origin 为 `git@github-sanjeever:Sanjeever/ssh-mcp.git`。保留用户已有 remote 配置。
- 核心逻辑使用 Go，npm 提供薄 Node.js 启动器，通过 `npx` 分发和启动预编译二进制。
- MCP 仅支持 stdio，由客户端启动本地子进程。所有运行配置来自客户端 `mcpServers` 的 `env`，不要求额外配置文件。
- 支持配置多台目标服务器，提供 `ssh_list`、`ssh_exec`、`ssh_upload`、`ssh_download` 四个工具。
- 使用服务器账号密码或已有私钥直接认证。用户无需先登录远端追加公钥，程序也不自动修改远端 `authorized_keys`。
- `SSH_MCP_HOST_KEY_POLICY` 可选，默认 `accept_new`。
- `SSH_MCP_KNOWN_HOSTS` 可选，默认 `~/.ssh/known_hosts`，复用用户现有 OpenSSH 信任记录。
- 首发支持 macOS、Linux、Windows 的 x64 和 arm64，共六个平台。
- 推送正式版本标签时，GitHub Actions 自动测试、构建、创建带更新日志的 GitHub Release，并通过 OIDC 发布 npm 包。
- npm 使用可信发布者，不以 `NPM_TOKEN` 作为日常发布方案。首次发布初始化和可信发布者设置需要写清操作步骤。
- README.md、AGENTS.md、更新日志、工具描述、错误信息、必要代码注释使用简体中文。代码标识符、协议字段和固定技术名称使用英文。
- 提交信息遵循 Conventional Commits，type 和 scope 使用英文小写，description、正文及说明使用简体中文。用户后续已明确撤回“提交信息使用英文”的早期要求。
- 许可证使用 MIT，版权署名 `Sanjeever`，首年为 2026。

以下常规实现细节按本交接采用：初始版本 `0.1.0`；首版仅支持正式三段版本号；根目录 `package.json` 的 `version` 作为应用版本唯一来源。用户未单独指定这些值，若实际约束要求调整，应说明理由并同步关联位置。

## 2. 已查看的参考实现

### qizhihe

路径 `/Users/sanjeev/code/go/qizhihe`。优先阅读：

- `internal/sshclient/client.go`：密码与私钥认证、主机公钥校验、连接与执行超时、取消、退出码处理。
- `internal/sshclient/transfer.go`：通过 SFTP 上传和下载单个文件、默认禁止覆盖、下载使用临时文件。
- `internal/sshclient/client_test.go`：SSH 行为测试。
- `internal/agent/ssh_tools.go`：四个工具的定义和调用入口。

可以提取适用实现，但需重新适配本项目契约。qizhihe 依赖数据库、用户身份、审批、连接 revision、工作区逻辑路径和配置页面；这些不属于本项目。

尤其注意：qizhihe 的原实现将远端输出写入带通道标签的 writer，并在输出达到上限时关闭连接；本项目应分别捕获 stdout/stderr，按下文约定截断返回内容并继续排空输出。

### codex-deck

路径 `/Users/sanjeev/code/go/codex-deck`。已经查看：

- `.github/workflows/release.yml`。
- `scripts/version.mjs`。
- `docs/development.md` 中版本和发布流程。
- `docs/releases/1.3.6.md`。

沿用其发布思路：标签触发，先校验版本和对应日志，测试及构建全部通过，再用 `docs/releases/<version>.md` 作为 Release 正文。ssh-mcp 不依赖 Wails、前端、桌面签名或公证，不照搬这些构建步骤。

参考仓库仅用于阅读，不修改它们。各自 AGENTS.md 约束各自仓库，不替代本项目已经确认的决策。

## 3. 配置契约

使用 `SSH_MCP_SERVER_<ID>_<FIELD>` 组织服务器配置，不采用 JSON 字符串配置，也不要求编号或单独列出 ID。

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
        "SSH_MCP_SERVER_STAGING_PASSWORD": "<staging-password>",
        "SSH_MCP_SERVER_STAGING_DESCRIPTION": "测试环境"
      }
    }
  }
}
```

这是采用 `mcpServers` JSON 的客户端示例；其他客户端的外层格式按其实际要求填写，不能声称所有客户端都直接使用该 JSON。

| 字段后缀 | 约定 |
| --- | --- |
| `HOST` | 必填，主机名或 IP；端口单独配置 |
| `PORT` | 可选，默认 22，范围 1–65535 |
| `USERNAME` | 必填 |
| `PASSWORD` | 密码认证凭据，与 `PRIVATE_KEY_PATH` 互斥 |
| `PRIVATE_KEY_PATH` | 本机私钥文件路径，与 `PASSWORD` 互斥 |
| `PASSPHRASE` | 可选，仅用于私钥认证 |
| `DESCRIPTION` | 可选，帮助 Agent 识别服务器用途 |

ID 限定为以大写字母开头、由大写字母、数字和下划线组成，例如 `DEV`、`PROD_DB`。工具使用对应的小写 ID，例如 `dev`、`prod_db`。不要猜测、模糊匹配或自动选择默认目标。

按完整字段后缀从长到短匹配，正确处理 `PRIVATE_KEY_PATH` 和带下划线的 ID。未知服务器字段、非法 ID、缺少必填字段、认证冲突、非法端口等在启动时明确报错。至少配置一台服务器。密码和口令保留原始内容，不能为统一处理而 trim。

启动时加载配置，运行期间保持固定，修改配置后重启进程。启动不逐台联网。错误不能回显密码、口令、私钥内容或整份环境配置。

| 全局环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SSH_MCP_HOST_KEY_POLICY` | `accept_new` | 可取 `accept_new` 或 `strict` |
| `SSH_MCP_KNOWN_HOSTS` | `~/.ssh/known_hosts` | OpenSSH known_hosts 文件路径 |

默认路径使用 Go 获取用户主目录后构造。显式路径支持 `~/` 和 Windows 上相应的主目录写法，不依赖 Shell 展开，也不把字符串中的 `$VAR` 当成环境变量模板。路径解析和校验失败时明确返回错误。

本地密码保存在客户端配置和进程环境中。README 如实解释凭据归属，不承诺对客户端或同一账号下的本地进程隔离。工具输入不接受账号密码，`ssh_list` 和日志不返回配置凭据。

## 4. 主机密钥与 known_hosts

使用 `golang.org/x/crypto/ssh/knownhosts` 读取和验证 OpenSSH 格式，兼容已有明文、哈希主机名和非默认端口记录。尊重库支持的撤销和可信主机规则，验证异常不得一概归为“未知主机”。

- 已有匹配记录：允许连接。
- `accept_new` 遇到未知主机：先将可信记录成功写入 known_hosts，再继续认证。
- `strict` 遇到未知主机或缺失信任文件：拒绝，不自动建立信任记录。
- 已知主机的密钥不匹配、被撤销、文件损坏或不可读：拒绝，不覆盖原记录，不自动删除后重试。
- 非默认端口按 OpenSSH 的 `[host]:port` 规则记录；地址使用支持 IPv6 的标准构造方式。
- `accept_new` 不需要交互确认。README 简短说明它信任首次见到的密钥，首次连接没有外部身份核对。

保留用户已有文件内容、注释、哈希记录和权限，采用追加方式；处理缺少末尾换行的情况。仅在需要新增信任记录且路径不存在时创建目录或文件；Unix 上新建 `.ssh` 为 0700，新建文件为 0600。Windows 按实际权限机制处理，不能将 Unix mode 当作 ACL 保证。已有目录和文件不要主动 chmod。

序列化同一进程内的检查和追加，写入前重新检查，防止并发工具调用重复建立信任或接受冲突密钥。不创建专用信任文件、备份文件或永久锁文件。不要宣称进程内锁可以协调所有外部 SSH 程序。

known_hosts 可以是符号链接，保持用户已有入口，不能为了写入而替换链接或重建整份文件。写入失败应返回明确错误，不转成仅内存信任或忽略校验。

## 5. 工具契约

输入字段使用 snake_case，Schema 明确类型、必填字段和限制，拒绝未知参数。工具描述和错误信息使用简体中文。

### ssh_list

- 无参数。
- 按 server_id 稳定排序返回配置中的服务器。
- 返回 `server_id`、`description`、`host`、`port`、`username`、`auth_type`。
- 不返回密码、口令、私钥内容；无需返回私钥路径。
- 不逐台建立连接，不把未探测的服务器标为“在线”。

### ssh_exec

输入为 `server_id`、`command` 和可选 `timeout_seconds`。后者默认 180，范围 1–3600。连接与认证握手另设 15 秒上限，并受调用总超时约束。

- 使用原生 SSH exec，由远端默认 Shell 解释 command，不通过本机 Shell。
- 每次调用建立独立连接和会话，结束后关闭。首版无需连接池。
- 不请求 PTY，不维持持续 Shell。一次调用中的 cd、export 不延续到下次。
- 不自动交互输入 sudo 密码，不自动回答主机或登录提示，不承诺支持 MFA、OTP 或任意 keyboard-interactive 流程。
- 返回 `server_id`、`stdout`、`stderr`、`exit_code`、`duration_ms`、`output_truncated`。
- stdout/stderr 合计最多保留 128 KiB；达到上限后继续读取和丢弃后续内容，不能无限缓冲或停止读取造成阻塞。
- 输出需能被合法 JSON 编码，正确处理多字节字符截断与远端非 UTF-8 字节。
- 非零退出码保留输出并表示工具执行失败，供 Agent 判断；认证失败、连接失败、超时、取消、命令非零退出应可区分。
- 没有收到远端退出状态时 `exit_code` 使用 null，不能伪造成功退出码。
- MCP 取消和超时必须关闭本次底层连接，覆盖 TCP 连接、SSH 握手、创建会话和读取输出，防止请求结束后仍无限等待。
- 超时或连接中断时明确远端状态可能不确定，不承诺关闭 SSH 就已杀死远端进程，不自动重试命令。

成功结果例如：

```json
{
  "server_id": "dev",
  "stdout": "Linux ...\n/home/deploy\n",
  "stderr": "",
  "exit_code": 0,
  "duration_ms": 186,
  "output_truncated": false
}
```

通过 SDK 的结构化输出和适当的文本内容交付结果；错误使用 MCP 工具错误语义，并保留排错需要的已捕获输出。结合实际 SDK API 验证实现，不让输出 Schema 与失败结果互相冲突。

### ssh_upload / ssh_download

输入均为 `server_id`、`local_path`、`remote_path`、可选 `overwrite` 和可选 `timeout_seconds`。`overwrite` 默认 false；超时默认值和范围与 exec 一致。

- 使用 SFTP；不依赖本机 scp/ssh 可执行文件，不使用 Shell 传文件，不静默回退到 SCP。
- 首版支持单个普通文件，最大 128 MiB；不递归传目录，不自动打包解包。
- local_path 是 MCP 进程所在机器的绝对路径，使用本机路径规则；remote_path 是远端绝对路径，按远端 SFTP 规则处理，不使用本机 filepath 改写远端路径。
- 不自动展开远端 `~` 或环境变量，不隐式创建父目录。说明这项路径要求，并明确报错。
- 本地路径以 MCP 进程账号权限访问，无额外工作区沙箱；不沿用 qizhihe 的逻辑路径约束。
- 默认禁止覆盖，不能依赖“先判断不存在再普通创建”实现覆盖保护。目标为目录或符号链接时拒绝写入。
- 下载先写同目录临时文件，完整传输成功后发布到目标；失败清理临时文件，原目标保持可用。覆盖与禁止覆盖语义在 Windows 上也需要验证，不将 Unix 特定技巧直接当作跨平台保证。
- 上传失败可能留下远端部分文件，在结果中如实说明；首版无需承诺原子上传。
- 实际传输过程中持续限制字节数，不仅依赖传输前文件大小。
- 传输完成须处理关闭文件时出现的错误，不能在远端文件尚未成功关闭时报告成功。
- 返回 `server_id`、`local_path`、`remote_path`、`bytes_transferred` 和耗时；失败时保留必要的传输进度与状态说明。

## 6. Go MCP 与进程生命周期

使用官方 `github.com/modelcontextprotocol/go-sdk/mcp`，以 `mcp.StdioTransport` 运行，SDK 负责协议和 Schema 相关能力，不手写 JSON-RPC 或 SSH/SFTP 协议。

- 本机 stdout 专用于 MCP 消息。启动信息、日志、诊断写 stderr，远端输出封装进工具结果。
- 不提供 HTTP/SSE 监听、Web UI、数据库、动态新增服务器工具或后台守护进程。
- stdin EOF、终止信号和上下文取消时及时清理连接与子任务，正常退出。
- 程序可提供 `--version` 用于 CLI 检查；普通 MCP 启动不能输出 banner。MCP server info 同样报告构建版本。
- 不记录完整命令、命令输出或整份工具参数作为默认诊断日志，这些内容也可能含秘密。
- 可采用 `cmd/ssh-mcp`、`internal/config`、`internal/sshclient`、`internal/tools` 的适度结构，保持业务独立，不为四个工具引入插件框架。
- Go 使用兼容所选官方 SDK 和依赖的受支持版本，CI 从 go.mod 读取。交接时本机 Go 为 1.23.12，不能假设它能直接编译当前 SDK；按项目声明使用 Go 自动工具链或明确说明实际要求，不擅自改全局用户配置。

## 7. npm 与六平台二进制

入口包为 `@sanjeever/ssh-mcp`，`bin` 命令为 `ssh-mcp`。启动器保持轻量，可使用 CommonJS 和 Node 内置模块，无需运行时第三方依赖。

| npm 平台包 | Go 目标 |
| --- | --- |
| `@sanjeever/ssh-mcp-darwin-arm64` | darwin/arm64 |
| `@sanjeever/ssh-mcp-darwin-x64` | darwin/amd64 |
| `@sanjeever/ssh-mcp-linux-arm64` | linux/arm64 |
| `@sanjeever/ssh-mcp-linux-x64` | linux/amd64 |
| `@sanjeever/ssh-mcp-win32-arm64` | windows/arm64 |
| `@sanjeever/ssh-mcp-win32-x64` | windows/amd64 |

- 平台包使用 package.json 的 os、cpu 字段筛选；Node 的 x64、win32 与 Go 的 amd64、windows 要显式映射。
- 入口包通过 optionalDependencies 精确引用同版本的六个平台包，不使用 ^ 或 ~。
- `CGO_ENABLED=0` 构建，Windows 文件为 `.exe`。macOS 分别提供两种架构，无需 universal binary。
- 平台包元数据可以从统一矩阵和根版本生成，避免手工重复维护版本。
- 根 package.json 的 version 为版本源；bump 同步入口包的六项依赖版本，构建生成平台包版本，Go 通过 ldflags 注入同一版本。开发构建可标记 dev。
- npm 包均包含正确的仓库地址、许可证和必要说明，使用 files 白名单控制发布内容。发布包不得带凭据、测试临时文件或无关构建产物。
- 入口包不携带全部平台二进制，不用 postinstall 或首次启动从 GitHub 下载二进制，不要求用户安装 Go。
- 启动器用 spawn 和 stdio inherit 执行对应二进制，不通过 Shell；保留环境变量，传递 CLI 参数，处理启动失败、退出码和终止信号。
- 可执行权限和 Windows 路径需要实际覆盖。平台不支持或 optionalDependencies 被省略时明确报错，不在错误路径偷偷下载。
- 确保 npm pack 之后的入口包能找到匹配的平台包，不能仅在源码树中可用。保留版本完全一致的检查。
- Node 开发依赖管理优先 pnpm；CI 使用冻结锁文件。发布使用 npm CLI。运行时最低 Node 版本根据实际 API 和测试声明，发布 CI 可使用 Node 26，不将发布环境要求误当成所有用户要求。

## 8. 版本、日志与 GitHub Actions

初始版本按 0.1.0 实现。仅接受 `vMAJOR.MINOR.PATCH` 正式标签，校验数字与 SemVer 规则，不因 on.push.tags 使用 v* 就允许任意 v 开头文本。

版本工具需要提供明确的 bump 和 check 命令。借鉴 codex-deck：bump 前要求对应 `docs/releases/<version>.md` 存在且非空，再同步版本；check 验证标签、入口版本、平台依赖版本与日志一致。版本更新和对应日志放在同一个独立发布准备提交。

每个版本的中文更新日志保存在 `docs/releases/<version>.md`，根据上一版本以来真实完成的用户可见变化编写。按内容保留“新增、优化、修复”等分组，不罗列空分组、不原样堆放 commit message，不把尚未验证的目标写成已完成。0.1.0 日志描述实际交付能力。

建议提供两个工作流：

1. `ci.yml`：main push 和 pull_request 触发，执行相关检查、测试和打包验证，不发布。
2. `release.yml`：正式版本标签 push 触发，校验、测试、构建六平台、制作 GitHub 附件和 npm 包，再执行发布。

发布流程应满足：

- 从标签提交构建，确保发布提交属于 main 的历史，校验版本和对应日志。
- 发布前所有测试、六平台构建和本地包检查完成；将同一批构建产物用于 npm 和 GitHub 附件。
- GitHub 附件命名使用 ssh-mcp、版本、平台和架构；Unix 使用 tar.gz，Windows 使用 zip，解压可直接得到对应可执行文件。另附 SHA256SUMS 供用户验证下载。
- GitHub Release 正文直接读取 `docs/releases/<version>.md`，不用 GitHub 自动生成提交列表替代。
- 可以先创建并填充 draft Release，依次发布六个平台 npm 包，再发布入口包；全部成功后公开 Release。不要在平台包未发布完时发布依赖它们的入口包。
- GitHub 与 npm 没有跨服务事务，部分 npm 发布后失败时如实报告，不声称全流程原子完成，不自动 unpublish、移动标签或覆盖已发布版本。文档说明如何识别已完成步骤和安排恢复；如支持重跑，不能把任意发布错误视为“版本已存在”而吞掉。
- 使用 GitHub-hosted runner 和 npm OIDC，发布 job 开启 id-token: write；GitHub Release job 按需拥有 contents: write，其余尽量 contents: read。
- 并发控制以版本为单位，不因新标签进入而中断正在进行的公开发布。
- Actions 和 npm CLI 版本根据实现时官方支持情况选定，不机械复制参考仓库旧版本，不依赖含糊的隐式环境前提。
- 首版不实现预发布通道、自动决定版本号或根据提交自动打标签。

### npm OIDC 首次准备

在 README 的发布说明中写清七个包分别需要哪些配置，不假装写好 workflow 就已完成 npm 侧准备。

- 需要拥有 `@sanjeever` scope 的发布权限。
- 入口包和六个平台包均需具备可信发布者配置，身份对应 GitHub owner `Sanjeever`、repo `ssh-mcp`、workflow filename `release.yml`；若使用 GitHub environment，名称必须精确对应。
- 需要允许直接 npm publish，不能配置成每次还需人工批准的 stage-only 发布后又承诺标签自动公开发布。
- 核对实现时 npm 对首次创建新包、初始化和 OIDC 的实际支持。若需先人工发布创建包，使用真正构建的有效包并写清一次性步骤，不上传占位包；日常 workflow 仍使用 OIDC。
- 初始化必须避免先人工发布 0.1.0 后，再让同版本标签 workflow 无条件重复发布。说明首次版本、后续版本或恢复路径如何衔接，不能承诺尚未验证的首发一键完成。
- 在官方文档确认当前 Node/npm 最低版本、可信配置允许操作及生效条件，在文档注明实际要求。
- 如本次实现没有真实 npm/GitHub 发布权限，交付完整可检查流程和初始化说明，清楚报告外部准备项；不要索要账号密码、私自读取令牌或绕过 OIDC 方案。

## 9. 验证要求

测试以可观察行为为中心，优先采用项目内启动的真实 SSH/SFTP 测试服务、临时密钥和临时目录。不连接用户真实服务器，不修改用户 ~/.ssh/known_hosts，不把 mock 当成真实远端或公网发布验证。

最低覆盖：

- 环境分组、下划线 ID、字段后缀、默认值、认证互斥、未知字段、配置错误不泄露凭据。
- 密码、普通私钥和加密私钥认证；认证失败能正确报告。
- known_hosts 已有明文及哈希记录、非默认端口、首次自动追加、缺少换行、密钥变化拒绝、strict 未知主机拒绝；保留原内容与权限，写入失败明确报错。
- exec 的 stdout/stderr、非零退出码、超时和取消、无法取得退出码、输出截断后仍能完成且不会死锁。
- SFTP 文件往返内容一致、默认禁止覆盖、显式覆盖、目录或符号链接拒绝、大小限制、失败下载不损坏原目标、取消能结束。
- 通过真实 stdio 子进程完成 MCP 初始化、工具列表和调用；普通日志不污染 stdout，stdin 关闭后进程能退出。
- Node 启动器的平台映射、参数和标准流传递、错误与退出行为；使用 node:test 等现有标准能力，避免为小启动器引入测试框架。
- 版本工具的 bump/check、空日志拒绝且不部分改写版本、六个平台元数据和依赖版本同步。
- 对本机真实平台执行 npm pack 后的隔离安装与 MCP 启动，使用本地打包的平台包解析依赖，不能依赖尚未存在的公开版本。不得声称本地安装 tarball 等同公开 registry 上的 npx 已验证。

运行 Go 格式、go vet、go test（可行时使用 race）及必要 Node 测试。CI 至少安排 macOS、Linux、Windows 原生测试和六目标交叉编译；能安排的 arm64 原生验证可增加，但必须区分真实运行和交叉编译。不能把构建通过写成六个平台均已实际运行。

纯文档变更检查内容、链接和 diff，无需重复编译。后续发生新改动或失败才重复相关验证。具体无法运行的检查和外部验证限制要如实记录在最终交付说明中。

## 10. 文档与小步提交

实现开始时创建简体中文 AGENTS.md，记录稳定约束、版本来源、文档语言、提交约定、发布与授权边界。README.md 提供用途、要求、npx 配置示例、多服务器及两种认证、主机信任策略、四工具、开发与发布入口。尽量通过 README 和版本日志完成必要说明，只有内容确需独立维护时再拆文档，不建立空目录和重复规范。

本文 handoff.md 是交接输入，可纳入首次文档提交；后续代码事实以代码和测试为准，长期约束以 AGENTS.md 为准，用户入口以 README 为准，不要求长期同步多份实现清单。

本次接手任务已授权实现过程中创建本地小提交。按实际功能边界划分，每个提交保持完整、可检查，并运行与该增量直接相关的验证。不要最后一次性提交全部实现，也不要机械按每个文件拆分。

以下是可调整的提交顺序和中文示例：

1. `docs: 记录项目约定与实现交接`。
2. `feat(config): 支持多服务器环境变量配置`，包含对应测试和所需模块初始化。
3. `feat(ssh): 支持认证与主机密钥校验`，包含对应测试。
4. `feat(ssh): 支持远端命令与文件传输`，包含对应测试。
5. `feat(mcp): 通过 stdio 提供四个 SSH 工具`，包含协议与生命周期验证。
6. `build(npm): 添加六平台二进制包与启动器`，包含本地打包验证。
7. `ci: 添加持续集成与标签发布流程`。
8. `docs: 完善使用说明与首次发布步骤`。
9. `build(release): 准备 0.1.0 版本与更新日志`。

提交前检查暂存区和 diff，不带入密钥、密码、本地路径配置或无关文件。修复新增问题时继续做对应的小提交，不自动改写已经提交的历史。

当前任务授权实现、本地构建、测试、打包和本地提交；实际 git push、创建或推送发布标签、GitHub Release、npm 发布及账户设置变更属于外部操作，需要用户另行授权。交付可审阅实现和完整发布步骤后再处理真实发布，不因为缺少发布授权而停下已授权的实现工作。

## 11. 完成交付

完成后报告实际实现、验证证据、已创建的小提交、工作区状态，以及 npm OIDC 首次准备或平台实际运行中仍需完成的外部步骤。

交付物至少包含可构建的 Go MCP、四工具及相关测试、六平台 npm 打包与启动器、CI 和标签发布工作流、版本工具、0.1.0 中文日志、README.md、AGENTS.md、MIT LICENSE。正常 npx 运行不依赖用户手动安装 Go，不添加新的常驻服务或配置数据库。

## 12. 官方资料入口

实现前核对所选依赖当前稳定 API，使用官方资料：

- MCP Go SDK：<https://github.com/modelcontextprotocol/go-sdk>。
- SSH：<https://pkg.go.dev/golang.org/x/crypto/ssh>。
- known_hosts：<https://pkg.go.dev/golang.org/x/crypto/ssh/knownhosts>。
- SFTP：<https://pkg.go.dev/github.com/pkg/sftp>，选择稳定主版本并按对应 API 实现，不混用不同主版本示例。
- npm 包字段：<https://docs.npmjs.com/cli/v11/configuring-npm/package-json/>。
- npm OIDC：<https://docs.npmjs.com/trusted-publishers/>。
- Node 子进程：<https://nodejs.org/api/child_process.html>。
- GitHub Release CLI：<https://cli.github.com/manual/gh_release_create>。
