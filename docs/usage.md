# 使用指南

本文说明客户端配置、主机信任和工具操作方式。快速启动示例见 [README](../README.md)。配置定义以 [src/config.ts](../src/config.ts) 为准，精确工具字段以 MCP `tools/list` 返回的 Schema 为准，其定义位于 [src/server.ts](../src/server.ts)；本文解释使用方式与限制。

## 服务器配置

环境变量采用 `SSH_MCP_SERVER_<ID>_<FIELD>`。ID 以大写字母开头，由大写字母、数字和下划线组成，工具使用相应小写 ID，例如 `PROD_DB` 对应 `prod_db`。至少配置一台服务器，调用须精确指定 ID。

| 字段 | 说明 |
| --- | --- |
| `HOST` | 必填，主机名或 IP；IPv6 不加方括号，端口单独填写 |
| `PORT` | 默认 22，范围 1–65535 |
| `USERNAME` | 必填 |
| `PASSWORD` | 与 `PRIVATE_KEY_PATH`、`AGENT_SOCKET` 三选一，不能为空，保留原始空白 |
| `PRIVATE_KEY_PATH` | MCP 机器上的普通私钥文件路径，不能为空，支持 `~/`；Windows 支持 `~\` |
| `PASSPHRASE` | 私钥口令，可选，仅适用于私钥认证，保留原始空白 |
| `AGENT_SOCKET` | 显式 SSH Agent 端点；macOS/Linux 为 Unix socket 绝对路径或 `~/` 路径，Windows 为 `\\.\pipe\...` |
| `JUMP_SERVER_ID` | 可选，已配置跳板服务器的精确小写 ID，仅支持单跳 |
| `DESCRIPTION` | 可选，用于识别服务器用途 |

在 README 示例的 `env` 中继续添加其他 ID 即可配置多台服务器。例如使用已有加密私钥的服务器：

```json
{
  "SSH_MCP_SERVER_STAGING_HOST": "192.0.2.20",
  "SSH_MCP_SERVER_STAGING_PORT": "2222",
  "SSH_MCP_SERVER_STAGING_USERNAME": "deploy",
  "SSH_MCP_SERVER_STAGING_PRIVATE_KEY_PATH": "~/.ssh/id_ed25519",
  "SSH_MCP_SERVER_STAGING_PASSPHRASE": "<key-passphrase>",
  "SSH_MCP_SERVER_STAGING_DESCRIPTION": "测试环境"
}
```

未加密私钥省略 `PASSPHRASE`。程序不修改远端 `authorized_keys`。非法 ID、未知服务器字段、缺少必填项、认证冲突、非法端口及必要路径错误会阻止启动；私钥内容与口令在连接时校验。

Agent 认证设置 `SSH_MCP_SERVER_<ID>_AGENT_SOCKET`，并省略密码、私钥及口令字段。Unix 填写实际 `SSH_AUTH_SOCK` 值，程序不展开环境变量或自动选择 Agent；Windows 可使用 `\\.\pipe\openssh-ssh-agent`。不支持依赖外部辅助程序的 Pageant/Cygwin 入口。认证使用本机 Agent 签名，不开启 Agent forwarding；Agent socket 受本次调用取消、握手上限和总超时约束。

目标设置 `SSH_MCP_SERVER_<ID>_JUMP_SERVER_ID` 引用另一台已配置服务器，例如值 `bastion` 引用 `SSH_MCP_SERVER_BASTION_*`。目标地址由跳板机连接并解析。未知引用、自引用、循环和嵌套跳转阻止启动。跳板与目标分别验证主机密钥并使用各自凭据，本机 Agent 也可用于目标认证。列表返回可选 `jump_server_id`，失败的连接步骤通过 `error.hop_server_id` 标明所在服务器。

配置路径支持主目录展开，相对路径基于进程工作目录解析，不展开 `$VAR` 或命名用户主目录。工具传输路径规则见[文件传输](#文件传输)，与配置路径不同。

配置在启动后固定，修改须重启进程。工具输入不接受凭据，列表与默认日志不返回凭据或私钥路径。密码与口令保存在客户端配置及进程环境中，客户端及同账号本地进程可能读取，程序不提供此边界上的凭据隔离。

远端操作共享调用并发限制，包括同步命令、异步任务、探测、文本读写与传输：

| 环境变量 | 默认值 | 范围 / 语义 |
| --- | --- | --- |
| `SSH_MCP_MAX_CONCURRENT` | 4 | 1–32，同时执行的逻辑操作数量 |
| `SSH_MCP_MAX_CONCURRENT_PER_SERVER` | 2 | 1–32，每个服务器 ID 的活动操作数量；单跳同时计入跳板与目标 |
| `SSH_MCP_MAX_QUEUE` | 32 | 0–256，等待队列容量，0 表示忙碌时直接拒绝 |

队列满返回 `ssh_queue_full`。排队时间计入总超时，排队取消不会建立连接。按等待顺序启动具备配额的操作，忙碌主机不会阻塞有空闲配额的其他主机。全局按逻辑操作计数，单跳操作包含两条 SSH 连接；每服务器按配置 ID 计数，两个 ID 指向同一物理设备时不会自动合并。列表、输出读取和任务状态查询不占远端配额。

## 主机信任

| 环境变量 | 默认值 | 可选值 / 用途 |
| --- | --- | --- |
| `SSH_MCP_HOST_KEY_POLICY` | `accept_new` | `accept_new` 或 `strict` |
| `SSH_MCP_KNOWN_HOSTS` | `~/.ssh/known_hosts` | 本机信任文件路径 |

`accept_new` 自动信任首次见到的主机密钥，成功追加到 known_hosts 后才继续认证；首次连接没有外部身份核对。`strict` 拒绝未知主机及缺失信任文件，须先通过可信方式核对并录入服务器密钥。已有密钥变化、撤销、文件损坏或不可读均拒绝连接，不自动替换记录。

支持 OpenSSH 明文与哈希主机名、非默认端口、IPv6、多主机、通配与否定规则。撤销密钥在整个文件内生效，即使该行主机名不匹配当前目标也拒绝使用该密钥。

追加保留原内容、注释、已有权限和符号链接入口，处理末尾缺少换行。Unix 新建目录采用 0700、新建文件采用 0600；Windows 的 Unix mode 不代表 ACL 保证。检查和追加在同一进程内串行，不协调外部 SSH 程序。

**主机证书限制**：当前 SSH 后端不支持 OpenSSH 主机证书协商。匹配 `@cert-authority` 规则的连接明确拒绝，返回 `ssh_host_key_rejected`，且不追加信任。无法解析的证书记录按无效信任文件拒绝，不忽略记录。依赖 CA 主机证书的服务器无法通过此实现连接，迁移前须评估适用性。设计边界见[架构说明](architecture.md#主机信任)。

## 工具调用

| 工具 | 输入 | 返回 |
| --- | --- | --- |
| `ssh_list` | 无参数 | `servers` 数组，按 `server_id` 排序；含 `server_id`、`description`、`host`、`port`、`username`、`auth_type` |
| `ssh_probe` | `server_id`，可选 `timeout_seconds` | SSH 认证结果、已验证主机密钥指纹、SFTP 可用性和原子发布扩展 |
| `ssh_exec` | `server_id`、`command`，可选 `stdin`、`output_mode`、`stdout_max_bytes`、`stderr_max_bytes`、`save_output`、`timeout_seconds` | `server_id`、`stdout`、`stderr`、退出状态、时长与输出统计；保存时含 `output_id` |
| `ssh_exec_start` | 同 `ssh_exec`，省略 `save_output`，始终保存输出 | `task_id`、`output_id`、任务状态与当前操作阶段 |
| `ssh_task_status` | `task_id`，可选 `wait_seconds` | 当前状态，结束后包含 `result` 命令结果 |
| `ssh_task_list` | 无 | 当前会话任务摘要与共享输出容量，包含句柄、服务器、状态与可用的过期时间 |
| `ssh_task_cancel` | `task_id` | 取消请求状态与当前任务快照 |
| `ssh_output` | `output_id`，可选 `stream`、`offset`、`tail`、`max_bytes`、`wait_seconds` | 输出页、`next_offset`、可读取量与实际接收量、保存截断和完成状态 |
| `ssh_output_forget` | `output_id` | 释放已结束操作的保存输出和关联任务记录，归还容量 |
| `ssh_upload` | `server_id`、`local_path`、`remote_path`，可选 `overwrite`、`atomic`、`timeout_seconds` | 路径、字节数、时长；原子模式增加发布与清理状态 |
| `ssh_download` | `server_id`、`local_path`、`remote_path`，可选 `overwrite`、`timeout_seconds` | 路径、字节数、时长 |
| `ssh_read_file` | `server_id`、`remote_path`，可选 `start_line`、`line_count`、`timeout_seconds` | 文本页、行范围、`next_line`、文件大小与 `revision` |
| `ssh_edit_file` | `server_id`、`remote_path`、`expected_revision`，提供 `old_text`/`new_text` 或 `edits`，可选 `timeout_seconds` | 替换数量、新旧版本、传输字节及原子发布状态 |

参数使用 snake_case，拒绝未知字段。`ssh_list` 不联网探测，不表示在线状态。远端调用总超时默认 180 秒，范围 1–3600 秒；每跳连接与认证握手另有 15 秒上限，并受总超时约束。目标跳的 15 秒包含转发通道建立与目标认证。每次远端调用使用独立连接或单跳连接链，结束、取消或会话关闭时释放整条链。

### 连接探测

显式调用 `ssh_probe` 可验证当前连接、认证与 SFTP 能力。成功认证后返回 SHA256 主机密钥指纹；SFTP 打开被拒绝时，SSH 成功仍返回 `sftp.available=false` 和 `reason=subsystem_unavailable`。SFTP 成功时，`atomic_overwrite` 和 `atomic_no_overwrite` 分别表示已协商所需 POSIX rename 与 hardlink 扩展；这不保证目标文件权限或具体操作会成功。探测不执行命令、不读写远端文件，沿用主机信任策略，`accept_new` 可能追加本机 known_hosts。连接、信任或认证失败仍返回工具错误。

### 命令执行

`ssh_exec` 由远端默认 Shell 解释命令，不经过本机 Shell。无 PTY、无持续 Shell；一次调用中的 `cd` 和 `export` 不会延续。不会自动输入 sudo 密码，不承诺 MFA、OTP 或任意 keyboard-interactive 登录。

`stdin` 是最多 1 MiB 的 UTF-8 文本，按编码后的字节数检查。发送服从背压，完成后发送 EOF；省略或空字符串也发送 EOF。例如 `command="bash -s"`，脚本内容放在 `stdin`。输入不会延续到其他调用，也不写入日志。

stdout 最多保存 96 KiB，stderr 最多保存 32 KiB，分别排空和统计。`output_mode` 为 `head`、`tail` 或默认的 `head_tail`；后者各保留一半头尾，中间显示省略标记，标记也计入保存配额。短输出保持原样。`stdout_bytes`、`stderr_bytes` 是实际接收字节数，`stdout_omitted_bytes`、`stderr_omitted_bytes` 表示截断省略的原始字节，边界不完整的 UTF-8 序列丢弃，内部连续非法字节以 `?` 替换。各流的 `*_truncated` 和汇总 `output_truncated` 表达是否截断。

`stdout_max_bytes` 和 `stderr_max_bytes` 可以降低本次结果预算，最小均为 256 字节，默认值分别为上述上限。无论预算大小，输出持续排空。

`save_output=true` 显式在当前 MCP 会话内存中保存输出，并返回 `output_id`。每流保留前 4 MiB，会话最多 8 份，总缓冲区上限 64 MiB。容量耗尽时在执行前返回 `ssh_output_limit`，不自动淘汰已有输出。保存内容在操作完成后 10 分钟过期，读取不会续期；会话关闭时释放。不写本地日志文件，不跨进程恢复。

容量满时可用 `ssh_output_forget` 立即释放已结束输出；活动操作须先取消或等待完成。`ssh_task_list` 的 `output_capacity` 报告同步保存与异步任务共享的份数：`used`、`limit`、`available`、`active`（含排队的未结束操作）和 `releasable`（已结束可释放）。这些字段按输出记录计数，不表示字节数或额外任务配额。

用 `ssh_output` 指定 `output_id`、`stream=stdout|stderr`，从默认 `offset=0` 开始读取，后续沿返回的 `next_offset` 继续。`max_bytes` 默认 16 KiB，范围 256 字节至 96 KiB。偏移按原始字节计算，合法 UTF-8 字符不会在页边界拆开；任意偏移落入续字节时跳到下一个字符。`available_bytes` 为已保存量，`total_bytes` 为实际接收量，`storage_truncated` 表示保存上限导致丢弃。`finished` 表示操作已结束，`eof` 表示保存内容已读完；保存截断时 EOF 不代表完整远端输出。失败调用也可读取已有输出。未知、过期或其他会话的 ID 返回 `ssh_output_unknown`。

设置 `tail=true` 可直接读取已保存内容末尾最多 `max_bytes` 字节，不必计算起始偏移；与显式 `offset` 互斥。返回的 `offset` 和 `next_offset` 仍是保存区原始字节位置，UTF-8 边界行为相同。后续需要增量读取时，去掉 `tail`，使用 `next_offset`。保存截断时，读取的是前 4 MiB 保存区的末尾，无法取得上限以外的远端输出。

`ssh_output` 的 `wait_seconds` 默认 0，范围 0–30 秒。当前偏移没有可读取的新内容时，可等待完整 UTF-8 字符、操作结束或等待到期；保存区已满时立即返回。其他流的新输出不会结束本流等待。等待到期返回当前页，不作为操作超时；取消等待不会取消原命令。

非零退出码标记 MCP 工具错误并保留输出。信号结束或未收到数值退出状态时，`exit_code` 为 `null` 并返回错误，不由信号推导数值；收到具体信号时通过 `exit_signal` 返回，否则为 `null`。

无需继续保留时，可调用 `ssh_output_forget` 立即释放输出和关联任务结果，归还保存容量；后续读取或查询返回未知 ID。活动操作返回 `ssh_output_active`，须先取消或等待完成。此操作不连接远端、不删除远端文件。

### 异步命令

`ssh_exec_start` 在当前 MCP 会话启动一次独立命令，返回句柄后通过 `ssh_task_status` 查询。任务状态为 `queued`、`running`、`completed`、`failed` 或 `canceled`。启动接受成功不代表命令已成功执行；查询本身成功时，失败命令通过 `status=failed` 和 `result.error` 表达。总超时从启动计时，沿用同步命令的输入、输出预算和 SSH 边界。

异步任务始终保存输出，与同步 `save_output` 共享 8 份输出容量。使用 `output_id` 调用 `ssh_output`，沿 `next_offset` 读取增量；运行期间读到当前末尾不表示任务结束，尚未到齐的 UTF-8 字符会等后续读取。任务结果和输出在结束后保留 10 分钟，查询不续期。未知、过期或其他会话任务返回 `ssh_task_unknown`。

`ssh_task_status` 可传 `wait_seconds`，默认 0，范围 0–30 秒，等待任务结束或等待到期后返回当前快照。等待不会延长任务总超时，取消查询也不会取消任务。会话关闭会中断等待并按原生命周期清理任务。

`ssh_task_list` 列出当前会话尚未过期的排队、运行及已结束任务，按启动顺序返回句柄、服务器、状态与开始时间；已结束任务额外包含 `expires_at`。列表不含命令、stdin、输出正文和完整结果，不连接远端。释放关联输出后，任务从列表移除。任务容量满时，错误提示通过列表找到关联 `output_id` 并释放已结束记录；共享输出容量见上述 `output_capacity`。

`ssh_task_cancel` 发送本地取消请求，重复调用保持幂等。`cancel_requested=true` 表示已请求取消，继续查询取得最终状态；已结束任务不再取消。`canceled` 表示本地调用已取消并清理连接，不能据此确认远端进程停止。启动请求完成后，任务由显式取消、总超时和 MCP 会话生命周期管理；会话 EOF、终止信号或进程退出都会结束连接，不跨进程恢复，不自动重试。

异步接口使用普通 MCP 工具，不要求客户端支持 Tasks 扩展。这里的 `task_id` 是本项目工具字段，不是协议层 Tasks 句柄。

### 文件传输

传输通过 SFTP 支持单个普通文件，最大 128 MiB，持续检查实际传输字节数。不传目录或符号链接，不创建父目录。

传输使用最多 4 个块的有限并发窗口，按偏移写入并处理短读，保持内存和在途操作受限。`bytes_transferred` 统计已确认写入的字节，失败时可能包含分散的已完成块，不表示可据此断点续传。客户端通过请求 `_meta.progressToken` 选择接收字节进度；通知经过节流，无 token 时不发送，结束后停止。源可能增长，因此不提供不可靠的固定总量。

`local_path` 是 MCP 进程机器上的绝对路径，以该进程账号权限访问，无额外工作区沙箱。`remote_path` 使用远端 SFTP 绝对路径，以 `/` 开头（Windows SFTP 可能使用 `/C:/...`），不通过本机 path 改写，不展开远端 `~` 或环境变量。

默认 `overwrite=false`。上传以排他模式创建，下载以排他方式发布；目标已存在时拒绝，显式覆盖须传 `overwrite=true`。目录和符号链接目标拒绝。

下载先写同目录临时文件，完整传输并成功关闭文件后才发布。禁止覆盖使用排他硬链接发布，要求本地文件系统支持硬链接，不支持时明确失败；显式覆盖使用系统重命名。发布前失败或取消保留原目标，临时文件清理失败会报告错误。上传失败可能遗留远端部分文件，须检查后处理。

上传可设置 `atomic=true`，默认 `false`。原子模式先写远端同目录临时文件，再发布到目标；覆盖要求 `posix-rename@openssh.com` 扩展，禁止覆盖要求 `hardlink@openssh.com` 扩展。不支持时明确失败，不切换到直接写入。新文件采用 0600，覆盖保留普通 POSIX 权限位和 uid/gid，无法设置时在发布前失败。ACL、扩展属性与硬链接关系不保留；原子可见性不承诺断电持久性。

原子上传返回 `publication_state`，取值为 `not_published`、`unknown` 或 `published`。发布请求发出但结果丢失时为 `unknown`，须检查远端；发布成功后清理失败，结果仍为 `published` 并返回错误。`cleanup_pending=true` 和 `temporary_path` 指出可能残留的临时文件。清理受调用超时约束，不自动重连。

### 文本读取与编辑

`ssh_read_file` 经 SFTP 读取单个普通 UTF-8 文件，拒绝目录、符号链接、无效编码和 NUL。文件最大 1 MiB，持续限制实际读取量。默认从第 1 行读取 200 行，`line_count` 范围 1–1000，每页正文最多 96 KiB，保留 CRLF 与末尾换行。页边界落在完整行之间；使用 `next_line` 继续，`null` 表示末尾。单行超过预算返回 `ssh_text_limit`。空文件为 0 行。

读取返回整个文件内容的 SHA256 `revision`。`ssh_edit_file` 必须提供该值，以及非空 `old_text` 和不同的 `new_text`；新文本可以为空。旧文本须精确出现一次，重叠匹配也视为歧义，否则返回 `ssh_text_match`。内容版本不符返回 `ssh_text_conflict`，编辑前后文件均受 1 MiB 限制。

同一文件多处修改可改传 `edits=[{old_text,new_text},...]`，与顶层 `old_text`/`new_text` 二选一。数组包含 1–100 项，新旧文本编码后合计最多 2 MiB，每项仍须满足上述文本要求。所有匹配均基于 `expected_revision` 对应的原始内容，互不重叠，允许相邻；前一项生成的新文本不会成为后一项的匹配来源。全部校验通过后一次原子发布，`replacements` 返回替换项数；任一项失败时不发布部分修改。

例如同一原始版本中修改两个配置项：

```json
{
  "server_id": "staging",
  "remote_path": "/etc/example.conf",
  "expected_revision": "<ssh_read_file 返回的 revision>",
  "edits": [
    { "old_text": "port=8080", "new_text": "port=8081" },
    { "old_text": "workers=2", "new_text": "workers=4" }
  ]
}
```

编辑使用权限受限的本地临时目录暂存新内容，经已有原子上传路径发布，要求远端 POSIX rename 扩展，保留普通 POSIX 权限位与 uid/gid。发布前再次读取并核对内容版本，失败保留旧目标并报告发布及清理状态。版本检查与 rename 之间仍有外部写入窗口，不保证原子比较交换；需要严格互斥时，调用方须与远端写入者协调锁。符号链接、ACL 和扩展属性边界同原子上传。

### 结果、错误与取消

调用成功、操作失败与参数校验失败均提供 `structuredContent` 与内容相同的 JSON 文本。操作失败通过 `isError` 及 `error.code`、中文 `error.message` 表达，并保留已有输出或传输进度。错误包含 `phase` 和 `operation_state`，可识别的底层原因通过 `reason` 表达，例如 `permission_denied`、`not_found`、`target_exists`、`no_space` 和 `unsupported`。状态为 `not_started`、`may_have_started` 或 `completed`，不表示失败后可以自动重试。

参数校验失败返回 `ssh_input_invalid`，`issues` 指出字段路径、问题类型以及适用的类型或上下限，不回显参数值；此时不包含操作结果字段。未知工具返回协议错误。工具 annotations 描述只读性和副作用，下载会写本地文件。MCP 取消或会话关闭后，客户端不一定能收到最终工具结果。

超时、取消或连接中断会关闭本次连接。远端进程与文件状态可能不确定，关闭连接不保证远端进程已停止，程序不自动重试命令。

stdout 专用于 MCP 协议，无启动 banner。诊断写 stderr，默认不记录凭据、完整命令、命令输出或整份工具参数。`ssh-mcp --version` 可独立查询版本。

网络错误可提供 `dns_failed`、`connection_refused`、`network_unreachable`、`connection_timeout` 或 `connection_reset` 原因。它们与操作总超时、握手上限分别分类，不回显底层完整错误文本，也不据此自动重试。
