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
| SDK stdio 与五工具 | `tests/e2e-mcp.test.js`，官方 Client/StdioClientTransport 启动真实 bridge；仅测试中通过 localAddress relay 区分来源 |
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

## 仍需部署环境验证

Windows loopback 实际来源测试不等于多台 LAN、DHCP、防火墙或 NAT 保真验证。管理员必须从每台成员机器运行 doctor 核对身份。IP 不能提供强用户认证；共享来源不能区分成员。

Docker 当前不可用，未运行容器构建/部署/恢复，不能将文档命令或 npm 测试作为 Docker 运行证据。没有修改机器去使 Docker/网络可用。备份内容验证不替代生产停服恢复演练。
