# 项目约定

- 本项目使用 strict TypeScript、NodeNext ESM 和官方 MCP TypeScript SDK，以 ssh2 提供 SSH/SFTP，Zod 校验输入。通过 tsc 编译 JavaScript，以单个 `@sanjeever/ssh-mcp` npm 包分发，要求 Node.js 22+。
- 四个工具为 `ssh_list`、`ssh_exec`、`ssh_upload`、`ssh_download`。配置从 `SSH_MCP_SERVER_<ID>_<FIELD>` 环境变量加载，启动后固定，不在启动时联网。
- `handoff.md` 是初始需求和验收输入；长期约束以本文为准，用户入口以 README 和代码为准。
- 根 `package.json` 的 `version` 是唯一应用版本源，CLI 和 MCP server info 直接读取。正式版本为三段数字，对应非空中文更新日志；版本和锁文件随发布准备一同提交。
- README、工具描述、错误信息、更新日志和必要注释使用简体中文。代码标识符与协议字段使用英文，工具字段使用 snake_case。
- 提交遵循 Conventional Commits，type、scope 使用英文小写，描述与正文使用简体中文。按完整功能增量验证并创建小提交，不自动改写历史。
- 测试使用临时目录、临时密钥和环回 SSH/SFTP 测试服务，不连接真实服务器，不修改用户真实 known_hosts。参考仓库仅供阅读。
- stdout 专用于 MCP 协议。凭据、完整命令和输出不进入默认日志。取消和超时关闭调用连接；远端状态可能不确定，不自动重试命令。
- known_hosts 保持明文、哈希、端口、IPv6、通配、否定、撤销及安全追加规则。经用户确认，ssh2 不支持 OpenSSH 主机证书；匹配 CA 规则时明确拒绝且不追加信任。
- 保留 origin。实现、测试、本地打包与本地提交已获授权；推送、发布标签、GitHub Release、npm 发布和账户配置须另行授权。
- 发布通过 `release.yml` 正式标签触发，使用 npm OIDC。集中构建一次，同一个 tarball 用于六平台安装验证与发布；根包可信发布者配置须单独核对。停止平台包与独立二进制发布，保留旧版本。
- 使用 pnpm 冻结锁文件安装，运行 `pnpm typecheck`、`pnpm build`、`pnpm test` 和 `pnpm pack:check`。测试使用 node:test 和 Node 环回 SSH/SFTP 服务，不依赖 Go。
- 区分本机验证、最低 Node 版本、六平台实际原生运行和公网发布验证。修改后运行直接相关检查；纯文档变更检查内容和 diff。未实际发布时不得声称已发布。
