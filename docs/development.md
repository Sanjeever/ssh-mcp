# 开发与发布

本文说明本地验证、单包准备、正式发布与恢复。命令入口以 [package.json](../package.json)、[scripts/](../scripts/) 和[工作流](../.github/workflows/) 为准；分发与发布必须保持的约束见[架构说明](architecture.md#单包分发与发布)。

## 开发环境与验证

使用 `package.json` 的 `packageManager` 指定的 pnpm 版本，开发 Node 版本参考 [CI](../.github/workflows/ci.yml)。应用运行最低版本由 `engines.node` 定义；开发工具的要求可能更高，CI 在较新 Node 下安装开发依赖后再切换到最低运行版本验证。

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

常规本地检查命令见 [README](../README.md#开发)，各项验证边界见下文，日常修改选择直接相关检查。`pnpm test` 通过 tsx 运行测试，模块测试直接加载 TypeScript 源码，不会生成单文件入口；涉及应用源码的变更须先 `pnpm build`，再验证真实 stdio 或安装包。纯文档与注释变更检查内容、链接和 diff，无需编译测试。

开发依赖离线安装前，先运行 `pnpm fetch --frozen-lockfile` 准备缓存，再运行 `pnpm install --frozen-lockfile --offline --ignore-scripts`。安装策略见 [pnpm-workspace.yaml](../pnpm-workspace.yaml)，依赖安装脚本禁用；开发构建使用 esbuild 的平台预编译工具。

### 验证边界

- `pnpm typecheck` 检查应用、测试与工程脚本类型；tsx 执行时不检查类型。`pnpm build` 生成单文件 ESM 入口与第三方许可文本，并检查外部导入边界。
- `pnpm test` 使用 node:test。模块测试直接加载 `src/`，端到端与官方 SDK 客户端测试运行 `dist/cli.js`。测试覆盖配置、主机信任、执行与传输、取消与进程生命周期；具体场景以 `test/` 和 `scripts/*.test.ts` 为准，不在文档维护用例数量。
- `pnpm pack:check` 实际打包，并在仓库外临时目录完成正常安装、禁用脚本和省略可选依赖三条路径，核对只有应用包，再验证 CLI、MCP 初始化、全部工具调用、标准输入、Agent 与跳板机及 SFTP 往返。环境文件启动另行验证命令执行与标准输入。工具调用覆盖能力探测、文本读取与批量编辑扩展缺失、输出尾读和释放、异步启动与状态查询、取消、任务列表和容量；文本及批量编辑成功路径在独立 OpenSSH 和 Dropbear 测试验证。Unix 正常安装限制 PATH，验证无需编译器。

测试使用临时目录、临时密钥、临时 known_hosts 和 Node 环回 SSH/SFTP 服务，不连接真实服务器。发布恢复单元测试隔离 npm/GitHub 外部边界，其结果不代表真实发布验证。

独立 OpenSSH 测试采用临时 `sshd`、密钥及信任文件，验证认证、退出状态、标准输入与原子 SFTP 发布。Unix 已安装 OpenSSH 时可执行 `SSH_MCP_TEST_OPENSSH=1 node --import=tsx --test test/openssh.test.ts`。普通 `pnpm test` 显式跳过此环境测试；CI 独立 job 必须执行。Linux 若需以 root 启动测试 daemon，配置 `SSH_MCP_TEST_SSHD_SUDO=1`，需要无交互 sudo；不修改系统 sshd 配置或服务。

独立 Dropbear 测试需要可用 Docker，执行 `SSH_MCP_TEST_DROPBEAR=1 node --import=tsx --test test/dropbear.test.ts`。测试在固定摘要的 Alpine 容器内安装 Dropbear 与 BusyBox，分别验证有、无 OpenSSH SFTP 子系统的情况，覆盖认证、stdin、退出状态、能力探测、传输和文本原子编辑。端口绑定环回地址，账户、服务端密钥与 authorized_keys 位于临时容器，客户端密钥和 known_hosts 位于临时目录，结束后清理。普通测试跳过此环境测试；CI 独立 job 必须执行。首次运行需要下载镜像和容器内软件包，验证对象不包含真实路由器固件。

包内文件白名单由 `package.json` 定义，并由 [pack.ts](../scripts/pack.ts) 检查。构建生成 `dist/THIRD_PARTY_NOTICES.txt`，保留内嵌依赖许可；不要手工维护生成文件或在文档重复完整包文件清单。

### CI 产物

[ci.yml](../.github/workflows/ci.yml) 集中构建并生成 tarball 与完整性记录，原生矩阵复用该产物，不重新构建应用入口。矩阵覆盖 macOS、Linux、Windows 的 x64/arm64，并单独验证最低 Node 版本；具体 runner、工具版本和产物保留期以工作流为准。

工作流配置不能证明各 runner 已运行通过。本机、最低 Node、六平台原生运行与公网安装分别报告验证证据。

## 版本与发布

版本由根 `package.json` 管理，`docs/releases/<version>.md` 记录该版变化、升级说明与实际验证范围。日志是历史快照，不作为当前操作手册；旧版实现、性能和验证数据应保留适用版本与测量条件。

先编写目标版本的非空中文日志，再执行版本更新。以下 `0.3.0` 是命令示例，执行时换成已确定的目标版本：

```sh
next_version=0.3.0
pnpm bump "$next_version"
pnpm install --lockfile-only --offline --ignore-scripts
pnpm version:check "v$next_version"
```

`bump` 改写前校验正式三段版本和日志，不自动提交、打标签或推送。版本、锁文件与日志放在同一个发布准备提交。版本变化后重新构建，以生成对应发布包。

### 本地准备

```sh
pnpm typecheck
pnpm build
pnpm test
node --import=tsx scripts/release.ts prepare
node --import=tsx scripts/release.ts verify
node --import=tsx scripts/pack-check.ts dist/packages/*.tgz
```

`prepare` 默认使用根版本，也可传入与其一致的 `v<version>`。tarball 位于 `dist/packages/`，版本、文件名与完整性记录位于 `dist/release-manifest.json`。`verify` 核对版本、日志和 tarball 摘要，不执行安装测试。准备完成后不重新构建或重打包替换已验证产物；`pnpm build` 会清空 `dist/`。

以上命令完成本地准备，不执行公开发布。

### 正式发布

推送、发布标签、GitHub Release、npm 发布和账户配置须另行授权。`release.ts publish` 执行外部写入，不能用作本地检查。

[release.yml](../.github/workflows/release.yml) 由 `v*` 标签触发，校验正式版本、中文日志及标签提交已进入 main 历史，再复用 CI 完成原生与安装验证。发布 job 下载并核对原 tarball，通过 npm OIDC 发布。Node/npm 版本、权限和 environment 设置以该工作流为准。

标签校验与发布 job 按锁文件安装开发依赖并禁用安装脚本，以执行 TypeScript 工程脚本。发布 job 不重新构建或打包，继续使用 CI 已验证的同一 tarball。

发布前核对根包 `@sanjeever/ssh-mcp` 的 npm Trusted Publisher 与仓库 `Sanjeever/ssh-mcp`、工作流文件名 `release.yml` 及实际 environment 设置一致，并允许直接发布。当前工作流不使用 GitHub environment，对应配置应留空；账户配置是否完成须单独确认。外部配置要求参考 [npm 可信发布者文档](https://docs.npmjs.com/trusted-publishers/)。六个旧平台包不参与发布。

### 失败恢复

脚本先创建或恢复 draft Release，附同一 tarball，npm 成功后才公开 Release。npm 或 GitHub 查询错误、发布错误均停止；已公开的 npm 版本不会自动撤回。

恢复时优先在原工作流选择 Re-run failed jobs，复用保留的 `release-assets`。脚本仅将明确 E404 视为 npm 版本不存在；已有版本须与原 tarball 的 `dist.integrity` 一致才跳过发布。同版本摘要冲突或 Release 已公开时拒绝继续。

产物过期后重新打包不能保证摘要相同。缺少原产物时先核对已发布状态与可恢复证据，不能把重打包视为同一份已验证内容。

## 启动性能测量

[benchmark.ts](../scripts/benchmark.ts) 从进程启动测到 MCP initialize 响应，默认串行测量 30 次，输出中位数和 P95：

```sh
node --import=tsx scripts/benchmark.ts node dist/cli.js
/绝对路径/项目/node_modules/.bin/tsx /绝对路径/项目/scripts/benchmark.ts npm exec --offline --yes --package=/绝对路径/包.tgz -- ssh-mcp
```

第二项先预热 npm exec 缓存，并在仓库外运行，tsx、脚本与包路径使用绝对路径，避免解析到当前项目。脚本只初始化 MCP，不连接示例地址对应的 SSH 服务器。

直接入口、缓存启动与首次安装分开记录，说明样本数、运行环境和缓存条件。`--version` 耗时不能替代初始化耗时。本地 tarball 不等于公开 registry 首次 npx 安装，不以不稳定公网耗时作为 CI 门槛。历史测量见对应[版本记录](releases/)。

## 文件传输性能测量

`node --import=tsx scripts/benchmark-transfer.ts` 使用环回 SSH/SFTP 服务，对比窗口 1 与 4 的上传和下载，注入每次读写请求 0、50、100 ms 延迟。默认测量 1 KiB、4 MiB，以及零延迟下的 120 MiB 文件；加 `--full` 扩展到所有大小与延迟组合。输出包含时长、吞吐和采样峰值内存，内存统计包含同进程测试服务端，单次样本用于本机对比，不等于公网带宽或独立客户端内存。
