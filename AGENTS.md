# 项目约定

- 本项目以 Go 实现 stdio MCP，通过薄 Node.js 启动器和六个平台 npm 包分发。使用官方 MCP Go SDK、SSH 和 SFTP 库。
- 四个工具为 `ssh_list`、`ssh_exec`、`ssh_upload`、`ssh_download`。配置从 `SSH_MCP_SERVER_<ID>_<FIELD>` 环境变量加载，启动后固定，不在启动时联网。
- `handoff.md` 是初始需求和验收输入；长期约束以本文为准，用户入口以 README 和代码为准。
- 根 `package.json` 的 `version` 是唯一应用版本源。正式版本为三段数字，平台依赖精确同步；Go 版本通过构建参数注入，开发构建标记为 `dev`。
- README、工具描述、错误信息、更新日志和必要注释使用简体中文。代码标识符与协议字段使用英文，工具字段使用 snake_case。
- 提交遵循 Conventional Commits，type、scope 使用英文小写，描述与正文使用简体中文。按完整功能增量验证并创建小提交，不自动改写历史。
- 测试使用临时目录、临时密钥和环回 SSH/SFTP 测试服务，不连接真实服务器，不修改用户真实 known_hosts。参考仓库仅供阅读。
- stdout 专用于 MCP 协议。凭据、完整命令和输出不进入默认日志。取消和超时关闭调用连接；远端状态可能不确定，不自动重试命令。
- 保留 origin。实现、测试、本地打包与本地提交已获授权；推送、发布标签、GitHub Release、npm 发布和账户配置须另行授权。
- 发布通过 `release.yml` 标签触发，使用 npm OIDC；七个包的首次初始化与可信发布者配置必须单独完成。未实际发布时不得声称已发布。
- 区分本地测试、交叉编译、目标平台原生运行和公网发布验证。修改后运行直接相关检查；纯文档变更检查内容和 diff。
