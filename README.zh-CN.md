# team-mailbox

**自托管的局域网信箱 MCP 服务，让不同机器上的 AI 编程助手互相发送文本和文件。**

[English](README.md) | 简体中文

team-mailbox 是面向可信内网小团队的 [Model Context Protocol (MCP)](https://modelcontextprotocol.io) 服务。一台机器运行中心服务，每位成员的 AI 助手（Claude Code、OpenCode、Codex、Cursor 或任意兼容 MCP 的宿主）通过本地 stdio bridge 接入，即可按成员名互发消息和文件——不需要账号、不需要令牌、不依赖云端。

```text
成员 A 的 Agent ─┐
                 ├─→ stdio bridge ─→ HTTP ─→ 中心（身份判定 + SQLite）←─ 拉取 ─ 成员 B 的 Agent
成员 C 的 Agent ─┘
```

## 解决什么问题

开发中同步排查上下文，通常要把日志复制粘贴到聊天工具，丢掉文件名和格式。team-mailbox 让一个 Agent 直接把上下文交到另一个 Agent 的收件箱：

> "把我对结算 bug 的排查结论发给小王。"
> "小李有没有发未读消息？读第二条。"
> "把 `./notes/事故记录.md` 发给小陈。"

消息保存在中心服务，接收方当时不在线也能稍后读取。

## 功能特性

- **存储转发式文本消息**，按成员名投递，单条最多 32000 个字符
- **文件传输**，单文件最大 10 MiB，上传与下载双向校验 SHA-256
- **零凭据**——身份由来源 IP 决定，由管理员统一映射
- **离线送达**——中心保存消息，等接收方主动拉取
- **显式已读**——列出或读取都不会偷偷标记已读
- **稳定消息 ID + 分页**，所以"读第二条"能准确定位
- **收件箱隔离**——只能读自己的收件箱，发送人也无法回看已发内容
- **单文件备份**——SQLite `VACUUM INTO`，附件一并包含
- **无云服务、无遥测、无外部依赖**——只有 Node.js 和 SQLite

## 身份是怎么确定的

不需要配置用户名或令牌。管理员在中心维护一份映射文件：

```json
{
  "allowedCidrs": ["10.0.0.0/24"],
  "members": [
    { "name": "xiaowang", "ips": ["10.0.0.11"] },
    { "name": "xiaoli", "ips": ["10.0.0.12"] }
  ]
}
```

中心按每个请求的真实 TCP 来源地址判定身份。`X-Forwarded-For`、`Forwarded`、`Authorization` 等请求头一律不采信；未映射或超出白名单网段的来源全部拒绝，健康检查也不例外。

> **这是访问控制，不是强身份认证。** 任何能占用被映射 IP 的人都会被当成对应成员。只能用于可信、受控的局域网，**严禁暴露到公网**。

## 环境要求

- Node.js 24
- 可信的局域网环境
- 一台常开机器用于运行中心服务

## 快速开始

### 1. 部署中心（管理员，一台机器）

```bash
git clone https://github.com/goudaren0528/team-mailbox.git
cd team-mailbox
npm ci
cp access.example.json access.json   # 然后编辑：填入团队成员的 IP
npm run admin -- validate-config
npm run admin -- list-members
npm start
```

中心默认监听 `127.0.0.1:8787`。要让局域网访问，需把 `MSG_HOST` 设为局域网地址，并在防火墙放行端口——建议把规则限定到成员的具体 IP。

### 2. 接入 Agent（每位成员）

拿到同一份源码，执行 `npm ci`，然后在自己的 MCP 宿主里注册 stdio bridge。各宿主字段名不同，结构大致是：

```json
{
  "type": "local",
  "command": ["<node 的绝对路径>", "<仓库路径>/src/mcp.js"],
  "enabled": true,
  "environment": { "MSG_SERVER_URL": "http://<中心地址>:8787" }
}
```

客户端**只需要配置中心地址**——不填名字、不填 IP 映射、不填凭据。重启宿主后验证：

```bash
MSG_SERVER_URL=http://<中心地址>:8787 npm run doctor
```

正常会打印中心识别出的成员名。如果名字不对，让管理员核对 IP 映射（DHCP 地址可能变了）。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `list_peers` | 列出可发送的成员 |
| `send_message` | 发送自由文本，可带标题、项目标签、回复关联 |
| `getmsg` | 列出收件箱：稳定 ID、发件人、时间、摘要——不会标记已读 |
| `read_message` | 分段读取单条消息正文 |
| `mark_read` | 显式标记已读 |
| `send_file` | 发送本地文件（≤ 10 MiB）作为附件 |
| `save_attachment` | 把附件下载到指定的本地绝对路径，并校验哈希 |
| `read_attachment_text` | 分段预览文本类附件（≤ 1 MiB） |

完整参数说明见 [docs/tools.md](docs/tools.md)。

## 限制

| 项目 | 上限 |
|---|---|
| 消息正文 | 32000 个 UTF-16 码元 |
| 文本请求体 | 64 KiB |
| 文件大小 | 单文件 10 MiB，每条消息 1 个附件 |
| 附件上传请求体 | 16 MiB（base64 开销） |
| 文本附件预览 | 1 MiB |

由于 UTF-8 下中文每字占 3 字节，会更快耗尽 64 KiB 请求体预算，**中文实际约 21000 字**就会触顶。更长的内容请拆成多条消息。

## 设计边界

- **所有消息都经过中心。** 两位成员之间的消息也存在中心机器上，运维这台机器的人可以直接读取数据库文件，**建议提前告知团队**。
- **只拉取，不推送。** 不会自动送达，必须由 Agent 调用 `getmsg`。收到的文本是数据，绝不是可执行的指令。
- **局域网内明文 HTTP。** 常规 TLS 反向代理会改写来源地址、破坏身份判定，不能直接套用。
- **附件存在 SQLite 中**且长期保留，没有自动清理机制。
- 不包含：群聊、在线状态、消息推送、多附件、断点续传。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/admin.md](docs/admin.md) | 中心部署、IP 映射、备份恢复、附件存储 |
| [docs/client.md](docs/client.md) | 通用 stdio 接入契约、附件保存规则、诊断 |
| [docs/tools.md](docs/tools.md) | 八个工具、分页、回复语义、已读状态 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | doctor、403、体积超限、来源地址问题 |

## 测试

```bash
npm test
```

40 项测试覆盖来源 IP 身份与 CIDR 校验、伪造请求头拒绝、收件箱隔离、分页、重启持久化、附件完整性与体积限制、旧 schema 升级，以及真实 MCP SDK stdio 端到端流程。

## 关键词

MCP 服务器、Model Context Protocol、Agent 之间通信、局域网消息、自托管、内网文件传输、AI 编程助手集成、Claude Code、OpenCode、Codex、Cursor、SQLite、Node.js、stdio bridge、团队协作、离线送达、无需云服务。
