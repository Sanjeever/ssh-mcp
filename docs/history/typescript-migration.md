# 0.2.0 TypeScript 迁移交接存档

本文保留迁移前的需求、取舍与验收输入，供追溯设计背景。以下内容是历史原文，不是当前任务、授权或操作指南；旧代码路径、阶段步骤及“当前”均指编写时状态。迁移结果见 [0.2.0 记录](../releases/0.2.0.md)，后续单文件构建决策见 [0.2.1 记录](../releases/0.2.1.md)。后续开发以 [AGENTS.md](../../AGENTS.md)、[架构约束](../architecture.md) 和[开发指南](../development.md) 为入口，不重新执行本交接。

## 历史原文

本文记录用户已确认的迁移方案、实施授权与验收条件，替代原 Go 首版交接。文中目标不代表已经实现、验证或发布。接手后应直接推进实现，按完整功能增量验证并创建本地小提交。

## 1. 已确认目标与授权

- 下个版本定为 `0.2.0`，使用 TypeScript 开发，编译成 JavaScript，以单个 `@sanjeever/ssh-mcp` npm 包分发。
- 完全废弃 Go。最终源码、测试服务、开发、构建、打包和 CI 均不依赖 Go，不保留双实现或 Go 回退路径。
- 保持现有四个工具、环境变量配置、结构化结果和错误码。本版集中完成技术栈与分发迁移，不夹带新增产品功能。
- 简化维护与发布是确定目标。启动性能需要实测，不预先承诺提升比例。
- 实现、依赖安装、本地构建、测试、打包和本地小提交已获授权。常规可逆实现选择自主处理，无需逐步请求确认。
- 推送、创建或推送发布标签、GitHub Release、npm 发布和账户配置变更须另行授权。缺少发布授权不阻止本地实现与发布准备。
- 不连接真实 SSH 服务器，不修改用户真实 known_hosts、参考仓库或全局工具配置。保留 origin 和用户已有改动。

当前项目 AGENTS.md 中 Go、平台包、版本注入和七包发布条款描述旧架构。用户已明确授权迁移，实施时应同步改写这些条款，不能据此保留 Go 或重新请求迁移许可。其他仍适用约束继续遵守。

## 2. 当前基线与阅读入口

- 工作目录 `/Users/sanjeev/code/go/ssh-mcp`，仓库 `https://github.com/Sanjeever/ssh-mcp`。
- 编写交接时根 package.json 版本为 `0.1.1`，HEAD 为 `a24147c`。接手时重新核对分支、HEAD、工作区和暂存区，不能假设状态未变化。
- 当前核心位于 `cmd/ssh-mcp`、`internal/config`、`internal/sshclient`、`internal/tools`。
- `internal/testssh` 提供环回 SSH/SFTP 测试服务，Go 测试作为行为参考。
- `bin/ssh-mcp.cjs` 定位平台包并启动 Go 二进制。
- `scripts/platforms.mjs`、`build.mjs`、`pack-check.mjs`、`version.mjs`、`release.mjs` 与 `.github/workflows/` 实现六平台、七包构建发布。
- README 是用户契约入口，`internal/sshclient/errors.go` 与调用方是错误码参考，`cmd/ssh-mcp/main_test.go` 是协议与生命周期参考。

先读相关代码和测试，再迁移行为。保留现有握手总超时分类修复及其回归场景。旧代码最终由 Git 历史保留，不另建备份目录。

## 3. 技术选型与结构

| 项目 | 决策 |
| --- | --- |
| 语言 | TypeScript，启用 strict |
| 运行时 | 延续 Node.js 22+，验证最低版本 |
| 模块 | ESM，TypeScript 使用 NodeNext |
| 构建 | tsc，不默认引入 bundler 或运行时 TS 加载器 |
| MCP | 官方 TypeScript SDK 稳定版本，验证客户端协议兼容性 |
| SSH / SFTP | 直接使用 ssh2，不叠加无实际需要的高层 wrapper |
| Schema | Zod，拒绝未知字段 |
| 测试 | node:test，测试编译产物和真实 stdio 入口 |
| 包管理 | 沿用 pnpm，提交冻结锁文件；公开发布使用 npm CLI |

推荐布局可按实际模块边界调整：

```text
src/
  cli.ts
  config.ts
  server.ts
  errors.ts
  ssh/
    client.ts
    known-hosts.ts
    exec.ts
    transfer.ts
test/
  helpers/
    ssh-server.mjs
  *.test.mjs
scripts/
  version.mjs
  pack-check.mjs
  release.mjs
  smoke.mjs
dist/
  编译后的 JS
```

package.json 的 bin 直接指向带 Node shebang 的 `dist/cli.js`，在当前进程内启动 MCP。用户安装后无需 TypeScript、Go、本机 ssh/scp 或编译工具。开发脚本和测试可沿用 mjs 风格。

根 package.json 的 version 继续作为唯一应用版本源。CLI 和 MCP server info 从同一来源读取，验证发布包内路径解析，移除 Go ldflags 和平台版本同步机制。

## 4. 先验证的关键依赖

全面迁移前先完成小规模可运行验证，查阅实施时官方稳定 API，固定所选依赖并提交锁文件。

### 主机信任兼容性

ssh2 的 hostVerifier 是验证入口，不是完整 known_hosts 实现，必须显式设置。目前尚未确认一个 JS 库完整满足要求，应先筛选并验证成熟库，检查源码、维护状态和实际行为。

验收涵盖明文与哈希主机名、非默认端口、IPv6、多主机与通配规则、撤销记录及现有实现支持的可信主机规则。不能将所有校验失败视为未知主机。

若候选库有缺口，明确缺口及补齐成本，在已有授权内继续研究。不要默认手写完整 OpenSSH 解析器，不通过忽略记录、关闭验证、调用本机 ssh 或保留 Go 绕过问题。若最终确需改变用户契约，提出具体取舍供用户决定，同时继续不依赖该决定的工作。未确认的库不能写成已验证选型。

### 原生扩展与安装

ssh2 存在可选原生扩展。验证正常安装、禁用安装脚本及省略可选依赖的路径，确认没有编译工具时基本功能可用。可选加速扩展不等于本项目必须维护平台包。

不能把构建本机原生模块变成安装必要条件，不修改用户全局 npm 配置。验证实际 tarball 和依赖安装结果，不能从“纯 JS 库”描述推断安装一定无需编译。

## 5. 配置与工具契约

### 配置

- 保留 `SSH_MCP_SERVER_<ID>_<FIELD>`，不新增配置文件或 JSON 环境变量格式。
- ID 以大写字母开头，由大写字母、数字和下划线组成；工具使用对应小写 ID，精确指定，不猜测目标。
- 按完整字段后缀从长到短解析，正确处理 PRIVATE_KEY_PATH 和带下划线的 ID。
- HOST、USERNAME 必填；PORT 默认 22，范围 1–65535。HOST 支持 IPv6，端口单独填写。
- PASSWORD 和 PRIVATE_KEY_PATH 互斥且不能为空，PASSPHRASE 仅用于私钥，DESCRIPTION 可选。
- 密码和口令保留原始空白。至少配置一台服务器；未知字段、非法 ID、认证冲突、端口和必要路径错误在启动时拒绝。
- 保留 `SSH_MCP_HOST_KEY_POLICY`，默认 accept_new，可选 strict；`SSH_MCP_KNOWN_HOSTS` 默认 `~/.ssh/known_hosts`。
- 保留主目录展开与平台路径规则，不展开字符串中的 `$VAR`，不依赖 Shell 展开。
- 启动加载后配置固定，启动和 ssh_list 不逐台联网。错误和日志不得泄露凭据或整份配置。

### 四个工具

| 工具 | 输入 | 结果主要字段 |
| --- | --- | --- |
| ssh_list | 无参数 | servers 数组，含 server_id、description、host、port、username、auth_type |
| ssh_exec | server_id、command，可选 timeout_seconds | server_id、stdout、stderr、exit_code、duration_ms、output_truncated |
| ssh_upload | server_id、local_path、remote_path，可选 overwrite、timeout_seconds | server_id、路径、bytes_transferred、duration_ms |
| ssh_download | 同上传 | 同上传 |

- 字段使用 snake_case，Schema 拒绝未知参数，工具描述和错误信息使用简体中文。
- ssh_list 按 server_id 稳定排序，不返回凭据或私钥路径，不虚构在线状态。
- 成功与失败结果保持现有结构。使用 MCP 工具错误语义和结构化 error.code、error.message，保留已有输出或传输进度。
- 核对现有错误码，不因更换库随意合并、重命名或回显敏感底层错误。

## 6. SSH、信任与生命周期

- 支持密码、普通私钥和加密私钥，不修改远端 authorized_keys。
- 每次远端调用建立独立连接，结束后关闭；不引入连接池、自动重试、持续 Shell 或 PTY。
- 命令交给远端默认 Shell，不通过本机 Shell，不自动输入 sudo 密码，不新增 MFA/OTP 承诺。
- 总超时默认 180 秒，范围 1–3600 秒；TCP 连接与认证握手另有 15 秒上限，并受总超时约束。
- 使用 SDK 取消信号覆盖连接、握手、会话、输出和传输。总超时到期不能因定时器顺序误报握手超时。
- stdin EOF、终止信号和 MCP 会话关闭时，清理活动调用与连接，不留下无限等待、未处理 rejection 或未结束的流。
- 关闭连接不保证远端命令停止，失败结果继续说明远端状态可能不确定。
- stdout/stderr 共用 128 KiB 保存配额，超出后继续排空，内存不随输出无限增长。保留 UTF-8 截断和非法字节处理语义。
- 非零退出保留输出；未收到数值退出状态时 exit_code 为 null，不能从信号推导数值或伪造成功。
- stdout 专用于 MCP 协议，诊断写 stderr。默认日志不记录凭据、完整命令、命令输出或整份工具参数。保留 --version，无启动 banner。
- 不新增 HTTP/SSE、Web UI、数据库、动态服务器配置工具或后台守护进程。

主机信任要求：

- 已知匹配记录允许；密钥变化、撤销、文件损坏或不可读拒绝，不自动替换记录。
- strict 拒绝未知主机和缺失信任文件，不自动创建信任。
- accept_new 对真正未知主机追加，写入成功后才继续认证，写入失败拒绝，不降级为内存信任。
- 保留内容、注释、权限和符号链接入口，处理末尾缺少换行，不重写整份文件。
- Unix 新目录采用 0700、新文件采用 0600，不主动修改已有权限。Windows mode 不代表 ACL 保证。
- 同一进程内串行检查与追加，写入前重新验证，避免重复追加或接受冲突密钥。不声称能协调外部 SSH 进程。

## 7. SFTP 行为

- 传输单个普通文件，最大 128 MiB，不回退 SCP，不递归、不建父目录。
- local_path 是 MCP 所在机器的绝对路径；remote_path 按远端 SFTP 绝对路径处理，以 `/` 开头，不用本机 path 改写，不展开远端主目录或环境变量。
- 本地访问使用 MCP 进程账号权限，不新增工作区沙箱。保留源与目标类型检查，目录和符号链接目标拒绝。
- overwrite 默认 false，实际创建必须排他，不能依赖先检查后普通创建；并发也不能覆盖已有目标。
- 下载写同目录临时文件，完整传输并成功关闭后才发布。禁止覆盖使用排他硬链接，显式覆盖使用系统重命名；验证 Windows 行为，不支持硬链接时明确失败。
- 下载失败或取消清理临时文件并保留原目标，处理发布前目标变化和冲突。
- 持续检查实际字节数，覆盖源文件增长；处理背压、流错误及远端与本地文件关闭错误。
- 上传失败可能遗留远端部分文件，如实报告，不新增原子上传承诺。

## 8. 单包分发与发布流程

- 保留 npm 名称 `@sanjeever/ssh-mcp` 和命令 `ssh-mcp`，升级示例改为 `npx -y @sanjeever/ssh-mcp@0.2.0`。
- files 白名单发布编译 JS、必要元数据、README 和 LICENSE，排除测试、Go、凭据、临时文件和无关产物。
- 安装和首次启动不下载二进制、不运行 tsc、不要求开发依赖。--version 和 MCP server info 与根版本一致。
- 删除六个平台依赖、平台 workspace 和生成机制；pnpm 若仍需单包配置，可保留必要设置，不保留空 workspace。
- 改造 version bump/check，继续严格校验正式三段版本、标签、非空中文日志；非法输入不能部分改写版本。删除平台依赖同步。
- pack-check 真实执行 npm pack，在项目外临时目录安装 tarball，验证 CLI、初始化、工具发现及调用，不依赖源码或未发布的 0.2.0。
- 新增 registry 依赖后重新安排缓存。先准备依赖缓存再验证离线安装，不能照搬旧包几乎无 registry 运行依赖的假设。

CI 保留 macOS、Linux、Windows 六个平台原生验证与最低 Node 22 覆盖，移除 Go setup、Go 检查、交叉编译和平台包任务。集中构建一次，用同一份 JS 产物完成平台安装验证与发布，避免发布时重新构建不同内容。

release.yml 继续使用正式标签触发与 npm OIDC：

```text
校验标签、根版本、中文日志与 main 历史
  → 类型检查、测试、原生安装验证
  → 核对已验证的单个 npm tarball
  → 发布 npm 包
  → 公开 GitHub Release
```

- 保留发布失败即停止、恢复时核对同版本产物完整性的机制，不能把任意 registry 错误视为已发布。
- 可先创建 draft Release，npm 成功后再公开。正文读取对应中文日志，可附同一份 npm tarball。
- 移除六个二进制归档及其专用清单，不为单包重新建立多产物编排。
- 保留最小权限、按版本并发控制和 OIDC，不引入日常 NPM_TOKEN 发布方式。
- 核对根包已有可信发布者是否匹配 owner、repo、workflow filename 和 environment，不声称账户配置已经完成。
- 旧版本及平台包保留，不自动删除、unpublish 或 deprecate。0.2.0 起停止平台包和独立 Go 二进制发布，README 与日志说明直接二进制用户需切换到 Node 入口。

## 9. 实施顺序与小提交

每个提交对应完整、可审阅的功能增量，包含直接相关测试。阶段可拆分，按依赖推进，不能最后一次性提交全部迁移，也不机械按文件拆分。

| 阶段 | 工作 | 验证出口 |
| --- | --- | --- |
| 基线与依赖 | 行为与启动基线，SDK、SSH、known_hosts、安装验证 | 关键选型有证据，缺口明确 |
| TS 基础 | 工具链、配置、错误、版本、stdio、ssh_list | 编译入口初始化、列表与配置测试通过 |
| SSH 信任 | 认证、known_hosts、连接生命周期 | 认证、信任、握手超时取消通过 |
| 命令执行 | exec、配额、UTF-8、退出状态 | 正常和中断输出测试通过 |
| 文件传输 | 上传下载、大小限制、排他与临时发布 | 往返、并发、失败和取消通过 |
| 分发与清理 | 切换 bin、版本与打包，移除 Go 和平台机制 | 单包隔离安装可用，开发测试脱离 Go |
| CI 与发布 | 原生矩阵、单产物、OIDC | 本地流程与发布恢复测试通过 |
| 文档与版本 | README、AGENTS.md、0.2.0 日志、版本、锁文件 | 文档与最终实现一致，检查通过 |

提交遵循 Conventional Commits，type/scope 英文小写，描述与正文简体中文。示例可按真实增量调整：

1. `build(ts): 添加 TypeScript 编译与测试入口`
2. `refactor(config): 将服务器配置解析迁移到 TypeScript`
3. `refactor(ssh): 迁移认证与主机信任校验`
4. `refactor(ssh): 迁移命令执行与取消处理`
5. `refactor(sftp): 迁移文件传输与覆盖保护`
6. `build(npm)!: 切换为单包 JavaScript 分发并移除 Go`
7. `ci: 改为 JavaScript 原生验证与单包发布`
8. `build(release): 准备 0.2.0 版本与迁移日志`

分发变化需在相关提交正文中说明不再提供独立 Go 二进制。根版本与对应日志放在同一个发布准备提交，锁文件有变化时一并提交。

每次提交前检查 diff、暂存区和必要验证，不带入用户改动或敏感文件。失败先修复再提交，不用占位、跳过断言或 mock 结果冒充集成验证。不自动 amend、squash 或改写历史。

实施期间可临时保留 Go 作对照，最终删除 Go 源码、测试服务、go.mod/go.sum、旧 launcher 与专用测试及孤立构建文件。中间提交保持当前阶段适用检查可运行，不留下无故损坏的默认入口。

## 10. 验收与启动性能

使用 Node 内真实环回 SSH/SFTP 服务、临时目录和密钥，覆盖现有回归场景：

- 配置分组、下划线 ID、默认值、认证互斥、未知字段、凭据不泄露。
- 密码、普通及加密私钥、认证失败；明文和哈希信任、撤销、strict、首次追加、并发冲突、符号链接及写入失败。
- stdout/stderr、非零与信号退出、缺失退出码、超限后继续排空、多字节截断及非法 UTF-8。
- TCP、握手、会话、执行与传输取消；总超时和握手上限分类；EOF、终止信号、活动连接清理。
- 文件往返、禁止与显式覆盖、并发冲突、源增长、目录/符号链接拒绝、部分失败和取消保留原目标。
- 真实 stdio 初始化、工具发现和调用、结构化错误、stdout 隔离。
- 版本检查、空或缺失日志、发布错误传播、同版本恢复产物一致性。
- 正常安装、禁用脚本、省略可选依赖、tarball 隔离安装，不借助源码或 Go。

性能以从启动到 MCP 初始化完成为终点，区分直接入口、缓存命中的 npx 与首次安装。迁移前后重复测量直接启动和缓存场景，报告样本数、中位数、较慢分位、Node/npm 版本与缓存条件。--version 耗时不能替代初始化耗时。

首次安装单独报告包体积、依赖与下载成本，不把不稳定公网时间作为 CI 门槛。用本地 tarball 或预热缓存测新版本时，明确不等于公开 registry 首次安装；未发布不能声称公网 npx 已验证。

最终执行类型检查、构建、完整相关测试与打包验证，确认无必要 Go 依赖或平台包机制。检查通过后，仅因新改动、失败或关键前提变化重跑。纯文档变更检查内容与 diff，无需编译测试。

## 11. 文档与交付

- 同步 README 和项目 AGENTS.md，移除当前约束中的 Go、平台依赖、交叉编译和七包发布描述，写清 Node 单包使用、开发、测试、版本与发布入口。
- 保留历史日志，编写 `docs/releases/0.2.0.md`，描述真实完成的迁移及二进制分发变化，不夸大性能或发布状态。
- 本文是一次性交接输入，不要求与 README 和代码长期重复同步；长期约束以更新后的 AGENTS.md 为准。
- 最终报告实际结果、验证、性能数据、小提交列表与工作区状态。
- 区分本机验证、CI 配置、各平台实际运行和公网发布。未运行的 CI、未确认的 npm 配置和未发布状态如实列出。

完成标准：0.2.0 四个工具及原有契约通过验证；单个 npm 包可安装运行；开发、构建、测试和分发脱离 Go；CI、版本与发布流程完成单包改造；必要文档与小提交齐全。实际外部发布不属于本次本地实现完成条件。

## 12. 官方资料入口

实施时核对所选稳定版本的 Node 要求、协议兼容性与 API：

- MCP TypeScript SDK：<https://github.com/modelcontextprotocol/typescript-sdk>。
- ssh2：<https://github.com/mscdex/ssh2>。
- TypeScript 模块：<https://www.typescriptlang.org/docs/handbook/modules/reference.html>。
- Zod：<https://zod.dev/>。
- Node 测试：<https://nodejs.org/api/test.html>。
- Node 流与文件：<https://nodejs.org/api/stream.html>、<https://nodejs.org/api/fs.html>。
- npm 包字段：<https://docs.npmjs.com/cli/configuring-npm/package-json/>。
- npm 执行与缓存：<https://docs.npmjs.com/cli/commands/npm-exec/>。
- npm OIDC：<https://docs.npmjs.com/trusted-publishers/>。
- GitHub Release CLI：<https://cli.github.com/manual/gh_release_create>。
