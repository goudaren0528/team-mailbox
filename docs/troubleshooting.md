# doctor 与排障

## doctor 的实际契约

```powershell
# 默认远端 health 与服务识别的当前成员；不打开本地 DB
npm run doctor
npm run doctor -- --server-url 'http://192.168.50.10:8787'

# 管理员显式检查既有 DB，只读；不发网络请求
npm run doctor -- --db-path '<仓库路径>\data\msg.sqlite' --skip-server

# 使用 MSG_DB_PATH（或默认 data/msg.sqlite）显式检查 DB，并检查远端
npm run doctor -- --check-db
npm run doctor -- --help
```

输出 Scope 明确 remote/DB 范围。要求 Node 24；成功退出 0，失败退出 1。未知参数、缺参数值、没有选中任何检查均失败。旧 `--skip-db` 不是新接口，默认已不检查 DB。

远端检查严格验证 HTTP 成功、JSON、`service: team-mailbox`、`status: ok`、ISO 时间和 member 对象；输出中心识别的成员名。3 秒超时，拒绝跳转。URL 校验/前缀拼接与 bridge 共用，拒绝非 HTTP(S)、userinfo、query、hash。

DB 检查仅在 `--db-path` 或 `--check-db` 显式指定时执行，以 `readOnly: true` 打开**既有文件**，不 mkdir、不初始化/迁移 DB。缺库、损坏、缺 members/messages 或必需列、外键问题均失败，finally 关闭连接。SQLite 只读连接仍受文件权限、WAL/SHM 状态和锁约束，不代表能检查任意被占用或不完整复制的数据库。

通过只是所选检查通过，不是完整收发或部署安全验收。默认 health 不写消息/成员数据，不会证明备份可恢复或宿主 stdio 配置正确。

## 403：为什么连 health 都被拒绝？

服务必须同时确认真实来源 IP 在 CIDR 白名单内并映射到成员。HTTP 头中的 Forwarded、X-Forwarded-For、Authorization 或客户端名字不能补身份。让管理员检查 JSON、当前来源和重启情况，不扩大到不必要的网段。

## doctor 显示的成员不对？

检查 DHCP 地址变化、共享 IP、NAT、VPN 或代理。中心只看到 socket 对端；代理可能令全部同事变成同一地址。不要把代理地址绑定到某个人并宣称已区分同事。优先直接 Node 和固定 IP/DHCP 保留；同一 IP 的不同进程/用户无法区分。

## 配置导致启动失败？

`MSG_ACCESS_CONFIG` 默认当前目录的 `access.json`。文件缺失、JSON 错误、空 CIDR/成员列表、非法 CIDR/IP、空 ips、重复 name、规范化后重复 IP、成员 IP 超范围都会启动失败，且在打开 DB 前校验。IP 仅支持无 zone 的标准字面量，不接受 `127.1`、八进制 IPv4、主机名或 `fe80::1%网卡`。

IPv4-mapped IPv6 会按 IPv4 匹配；mapped CIDR 前缀至少 /96，例如 `/120` 对应 IPv4 `/24`。IPv6 `::/0` 不会隐式放行规范化后的 IPv4，应另列 IPv4 CIDR。

## 本机能访问，LAN 同事不能？

默认 `MSG_HOST=127.0.0.1`；需要管理员明确选择 LAN 监听地址并配置限定来源的防火墙。成员 URL 不能填自己机器的 localhost，也不能填 `0.0.0.0`。Compose 默认发布到宿主 loopback；即使开放端口，仍不能保证保留来源。

## `.env` 或宿主配置为什么没生效？

程序不自动加载 `.env`。使用进程环境或脚本前的 `node --env-file=绝对路径`。GUI 宿主未必继承终端环境，须按其配置规范传入并重启 bridge。Compose 固定 environment 也不会因为宿主 `.env` 中有同名字段就改变。

## 改名、删除映射、重新分配 IP 的后果？

配置重启后生效，删除映射取消该来源访问及该成员新收件资格，历史消息不删。成员名是历史收件箱标识：改名相当于另一身份；重新添加同名会重新获得其历史。不要把旧名字或仍被使用的 IP 分给另一人而忽略历史数据。

## 消息和工具问题

- 发送成功表示中心保存，不表示对方在线/已读；接收方之后可主动查询。
- 超时后发送可能已入库，重发可能重复；没有幂等键。bridge 10 秒超时且拒绝跳转。
- 列表/读取都不自动已读，只有 mark_read 改状态，且同一成员所有 IP 共享状态。
- 无发件箱读取工具；只有收件人能读正文。第三人读/引用回复会失败，回复必须发给原会话对方。
- 多消息用已展示的实际 id 选择，不要刷新后按序号替代。列表按 id 升序分页；正文按 UTF-16 offset 分段。
- 超过 32000 码元或整体 JSON 64 KiB 时拒绝；中文可能先触发字节上限。见[工具说明](tools.md)。

## 备份失败或恢复后消息缺失？

实际在线备份为 `VACUUM INTO`，目标必须不存在。核对路径、空间、权限及写入锁。不能热复制主 DB 冒充一致备份。恢复须停服，隔离旧主库及存在的 WAL/SHM，再恢复独立备份；access.json 要单独备份和核对。见[管理员手册](admin.md)。
