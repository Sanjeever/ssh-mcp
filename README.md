# SSH MCP

通过 stdio MCP 连接配置中的多台 SSH 服务器，执行命令、上传和下载文件。以单个 `@sanjeever/ssh-mcp` npm 包分发，运行要求 Node.js 22+，无需本机 ssh/scp 或编译工具，安装不下载 registry 运行依赖。

支持 macOS、Linux、Windows 的 x64 与 arm64。四个工具为 `ssh_list`、`ssh_exec`、`ssh_upload`、`ssh_download`。

## 快速开始

在采用 `mcpServers` JSON 的客户端中配置命令和环境变量。其他客户端按其实际配置格式填写。

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "@sanjeever/ssh-mcp"],
      "env": {
        "SSH_MCP_SERVER_DEV_HOST": "192.0.2.10",
        "SSH_MCP_SERVER_DEV_USERNAME": "deploy",
        "SSH_MCP_SERVER_DEV_PASSWORD": "<dev-password>",
        "SSH_MCP_SERVER_DEV_DESCRIPTION": "开发环境"
      }
    }
  }
}
```

将示例地址和凭据换成实际值。需要固定版本时，在包名后追加 `@<version>`。配置在启动时加载，修改后须重启 MCP 进程。启动和 `ssh_list` 不逐台联网；远端操作使用列表返回的精确 `server_id`。

默认首次连接自动信任主机密钥并写入 known_hosts，首次连接没有外部身份核对。需要预先建立信任时，设置 `SSH_MCP_HOST_KEY_POLICY=strict` 并通过可信方式录入服务器密钥。私钥、多服务器配置及主机证书限制见[使用指南](https://github.com/Sanjeever/ssh-mcp/blob/main/docs/usage.md)。

命令在独立连接中执行，无 PTY、无持续 Shell。传输支持单个普通文件，默认禁止覆盖。超时、取消或连接中断后远端状态可能不确定，程序不自动重试命令。完整参数、限制和错误语义见[工具说明](https://github.com/Sanjeever/ssh-mcp/blob/main/docs/usage.md#工具调用)。

0.2.0 起停止发布平台子包和独立 Go 二进制；直接使用旧二进制的用户须切换到 Node 入口，历史版本继续保留。

## 开发

使用 [package.json](package.json) 指定的 pnpm 版本，开发 Node 版本参考 [CI](https://github.com/Sanjeever/ssh-mcp/blob/main/.github/workflows/ci.yml)。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm build
pnpm test
pnpm pack:check
node dist/cli.js --version
```

主要目录为 `src/`（应用与 SSH/SFTP）、`test/`（协议与环回集成测试）、`scripts/`（构建、打包和发布）、`docs/`（使用、设计和维护资料）。`dist/` 是生成产物。

## 文档入口

- [使用指南](https://github.com/Sanjeever/ssh-mcp/blob/main/docs/usage.md) — 配置、主机信任、工具参数与操作边界。
- [架构与设计约束](https://github.com/Sanjeever/ssh-mcp/blob/main/docs/architecture.md) — 模块边界、设计原因与必须保持的契约。
- [开发与发布](https://github.com/Sanjeever/ssh-mcp/blob/main/docs/development.md) — 验证、打包、版本准备、发布恢复与性能测量。
- [Coding Agent 约定](https://github.com/Sanjeever/ssh-mcp/blob/main/AGENTS.md) — 事实来源、修改边界与文档影响判断。
- [版本记录](https://github.com/Sanjeever/ssh-mcp/tree/main/docs/releases) — 各版变化、升级说明和当时的验证记录。

以上指南链接指向仓库 main；查阅旧版本时应切换到对应标签。npm 包保留本 README，详细文档在仓库维护。

许可证为 [MIT](LICENSE)，版权归 Sanjeever。
