# IP 方案恢复与验证记录

## 恢复基线

本轮重新读取磁盘：src 仍为旧 token 实现，package.json 无 IP 库，四组旧测试仍依赖 token；未发现 IP 方案 partial 文件。原 fix-1 已终止且不可恢复，本轮没有 revive 或沿用旧测试通过报告。没有 Git 仓库可提供 diff；实际变更由本轮文件操作记录核对。

本轮允许项目内源码、测试、配置和文档写入；没有修改客户端配置或网络、防火墙，没有 commit/push。npm 缓存使用项目内 `.npm-cache`，测试文件位于项目内 `.test-tmp`，测试启动的 SDK/代理/服务通过逆序清理关闭。

## 新证据路径

| 承诺 | 新测试 |
| --- | --- |
| CIDR/IP 正规化、mapped IPv6、边界与 fail-closed | `tests/access.test.js`，配置错误时断言 DB 父目录未创建 |
| 真实来源、所有路由拒绝未知/超范围、伪造头不换身份 | `tests/server.test.js`，http.request localAddress 绑定 127.0.0.1/.2/.3/.4 与 127.0.1.1 |
| IPv6 / IPv4-mapped socket | dual-stack `::` 监听，通过 ::1 和 IPv4 实际 socket 请求 |
| A/B/C 隔离、回复、已读、分页分段、过滤、重启与配置删除 | `tests/server.test.js`，实际文件 DB 和真实 HTTP |
| SDK stdio 与原有五个文本工具 | `tests/e2e-mcp.test.js`，官方 Client/StdioClientTransport 启动真实 bridge；仅测试中通过 localAddress relay 区分来源 |
| 禁止跳转与 10 秒超时 | 真 SDK 调用受控本地 HTTP 服务 |
| doctor 远端默认、严格健康 schema、身份与前缀、只读 DB | `tests/doctor.test.js`，真实 HTTP/本地 DB，不以旧 mock PASS 代替 |
| 旧 DB 无消息丢失、VACUUM INTO | `tests/admin.test.js`，旧结构迁移逐行比较，独立打开备份检查 |

生产代码只接受配置文件位置和 DB 等正常启动参数，没有替换 req.socket.remoteAddress、信任头或注入身份的生产入口。测试 relay 代码仅在 tests/helpers.js。

## 执行及修正过程

1. 项目内缓存更新 lockfile，然后执行 `npm ci`（安装 95 个包）。新增直接依赖 ipaddr.js 2.2.0。
2. 首轮新测试发现 Windows 下清理顺序先删 DB 导致文件占用，并在清理网络资源时等待，触发 120 秒工具超时。检查进程未发现遗留的本项目测试/bridge 进程；改为逆序清理 SDK、代理、中心、目录。
3. 第二轮实际 SDK/IPv6/doctor 测试通过；持久化断言误将默认 2000 码元片段与 2400 码元全文比较，修为显式 limit=4000。此前逐段拼接已通过，未更改正文分段实现。
4. 新测试第一次全量通过时为 28/28（数量巧合与旧报告相同，但文件内容和身份验证全部重写）；补充实际 CLI 子进程与文档链接/JSON 检查后，最终 `npm test` **30/30 通过、0 失败、0 跳过，约 11.3 秒**。运行环境 Node 24.19.0、npm 11.17.0、Windows PowerShell。旧测试不作为新身份方案证据。
5. `npm pack --dry-run --ignore-scripts` 成功，白名单仅含源码、文档及示例/部署文件，无实际 access.json、DB、测试临时文件或 node_modules。npm 固有行为不打包 package-lock.json，README 已明确源码分发需另含 lockfile，不能用 npm tarball 替代完整源码。
6. 实际运行 `npm run admin -- --help`、`npm run doctor -- --help`，并将 MSG_ACCESS_CONFIG 指向 access.example.json 运行 validate-config/list-members，均成功，示例识别一个配置成员 A。真实启动/doctor/backup 子进程命令另由 cli.test.js 验证。

## 已修复的旧 doctor 问题

- 默认不检查或创建本地 DB，无凭据参数；明确打印实际范围。
- health 必须匹配 service/status/time/member schema，并报告当前成员。
- 显式 DB 检查只读打开既有文件，缺库/缺表/列/完整性失败，finally 关闭。
- 与 bridge 共用 URL 校验和前缀拼接，拒绝非 HTTP(S)、userinfo/query/hash、未知参数和 redirect。

## 附件功能验证（2026-09-21）

在既有 30 项测试保持全绿的前提下新增附件能力，`npm test` 最终 **40/40 通过、0 失败、0 跳过，约 23.6 秒**（Node 24、Windows PowerShell）。新增用例集中在 `tests/attachments.test.js`（8 项）与 `tests/e2e-mcp.test.js`（2 项）。测试一律使用临时 DB 和临时端口（`listen(0)`），未连接也未重启当时运行中的中心服务。

| 承诺 | 证据 |
| --- | --- |
| 三种发送形态（文本+附件／仅附件／仅文本） | `tests/attachments.test.js`，并断言纯文本响应结构与旧版一致 |
| 纯文件消息摘要回退 `[文件] 文件名` | 同上，同时核对 `text` 为空字符串而非 null |
| 10 MiB 恰好通过、+1 字节 413、0 字节 400 | 同上，载荷在内存生成不落盘 |
| 文件名 200 通过 / 201 拒绝、路径分隔符与控制字符被剥离 | 同上，并断言仅由分隔符组成的文件名被拒 |
| SHA-256 不匹配、非法 base64、非法 padding 拒绝且不入库 | 同上，逐项断言后核对 attachments/messages 行数 |
| 权限三方隔离，**含发送人本人 403** | 同上，并断言 403 响应体不含文件名、发送人与第三方响应完全一致 |
| 文本预览分段、`offset` 翻页拼接还原原文 | 同上，含 `text/*` mime 判定、二进制拒绝、1 MiB 边界与 +1 拒绝 |
| 单附件唯一约束 | 同上，直接向 attachments 插入第二行断言抛约束错误 |
| 旧 schema 升级后历史数据完好 | 同上，逐行比较 messages、比对 `sqlite_master` 中 messages 建表语句未变、已读与 reply_to 保持 |
| 含附件 `VACUUM INTO` 后重新打开读出 | 同上，独立只读连接取回 BLOB 并核对 SHA-256，确认无附件旁挂目录 |
| `MSG_MAX_ATTACHMENT_BYTES` 只能调小 | 同上，子进程注入环境变量，验证超限/非法值回退默认 |
| 真实 SDK stdio 全链路 | `tests/e2e-mcp.test.js`：`send_file` → `getmsg`（`[文件]` 摘要与 attachment 元数据）→ `save_attachment` → `read_attachment_text` 分段拼接还原；含拒绝覆盖、`overwrite:true` 覆盖、相对路径、父目录缺失、发送人与第三方 403、二进制可保存不可预览 |
| 附件 30 秒 / 文本 10 秒超时分级 | 同上，受控慢响应服务延迟 11 秒，断言预览在 11 秒前失败而下载成功且哈希一致 |

本机真实自测（非自动化）：通过重启后的中心（PID 30432，`127.0.0.1:18787`，身份洪伟填）完成 `send_file` → `getmsg` 显示 `[文件] 文件名` → `read_attachment_text` 分段预览 → `save_attachment` 保存且 SHA-256 一致 → 默认拒绝覆盖、`overwrite:true` 可覆盖 → 10 MiB+1 被拒。

### 与 PRD 的三处偏差（已确认保留）

1. **文件名 201 字符直接拒绝，不是截断**。PRD 第 4.2 节 S5 写"截断至 200 字符"，但第 7 章测试计划写"201 拒绝"，两者不一致。实现按拒绝执行：静默改名比明确报错更容易让人误用错误文件，且截断后可能与本地已有文件重名。
2. **`MSG_MAX_ATTACHMENT_BYTES` 只能下调**。超过 10 MiB 的值以及非法值静默回退默认，不报错。放大该值会超出固定 16 MiB 的含附件请求体预算。PRD 原文只说"管理员可下调"，实现据此做了硬约束。
3. **超大纯文本请求体是读入后拒绝，不是入口拒绝**。PRD 第 4.2 节 S2 要求把 `POST /api/messages` 整体提到 16 MiB，但这会使既有断言"纯文本 90 KB 请求返回 413"失效。实现改为：该端点按 16 MiB 读取，解析后若**不含附件**且实际字节超过 64 KiB 则返回 413。对外可观察行为与 PRD 意图一致（只有附件流量享受放宽），但超限纯文本请求体会先被缓冲再拒绝，存在有限的内存开销差异。

### 附件功能未验证项

- **未做跨机器 LAN 实测**：全部验证在 loopback 完成，未由第二台机器经真实局域网收发附件。10 MiB 在真实链路的耗时与 30 秒超时是否足够，未经实测。
- **未在生产库做升级前后对照**：历史兼容性用合成的旧 schema 库验证，没有对当前生产 DB 做升级前后逐项比对。升级前应先 `admin backup`。
- **并发大文件未测**：多人同时上传 10 MiB 时的写锁争用、busy timeout 与文本消息延迟，均未做压力或并发测试。
- **长期容量未测**：附件永久保留下 DB 增长、备份耗时变化没有长期运行数据，仅按每 100 个 10 MiB 约 1 GB 估算。
- 文档由独立文档轮次更新，未做端到端"照文档操作"走查。

## 仍需部署环境验证

Windows loopback 实际来源测试不等于多台 LAN、DHCP、防火墙或 NAT 保真验证。管理员必须从每台成员机器运行 doctor 核对身份。IP 不能提供强用户认证；共享来源不能区分成员。

Docker 当前不可用，未运行容器构建/部署/恢复，不能将文档命令或 npm 测试作为 Docker 运行证据。没有修改机器去使 Docker/网络可用。备份内容验证不替代生产停服恢复演练。
