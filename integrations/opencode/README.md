# OpenCode 侧栏未读提醒插件

在 OpenCode TUI 的右侧栏常驻显示 team-mailbox 的未读消息概况。

```
未读消息
甲  1 条
乙  2 条 · 1 附件
```

只显示发件人、条数、附件数，不显示标题和正文。无未读时整个区块不渲染、不占位。

## 文件

| 文件 | 作用 |
|---|---|
| `team-mailbox-unread.tsx` | 插件入口，注册 `sidebar_content` slot 并轮询 |
| `unread-core.mjs` | 纯逻辑：响应校验、格式化、行数截断、轮询间隔下限 |
| `unread-core.test.mjs` | `node --test` 自测，只覆盖纯逻辑 |

安装用的 `team-mailbox-unread.tsx` 与 `unread-core.mjs` 必须放在同一目录，入口通过相对路径导入 `./unread-core.mjs`；不必安装测试文件。

## 安装

1. 把本目录的 `team-mailbox-unread.tsx` 和 `unread-core.mjs` 复制到 OpenCode 的插件目录：

   - 全局：`~/.config/opencode/plugins/`（Windows：`%USERPROFILE%\.config\opencode\plugins\`）
   - 或项目级：`<项目目录>/.opencode/plugins/`

2. 在同级配置目录的 `tui.json` 里声明该插件。TUI 插件**不会**被自动扫描到（自动发现只匹配 `*.ts` / `*.js`，且 TUI 插件列表只读 `tui.json`），必须显式列出：

   `~/.config/opencode/tui.json`

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": [["./plugins/team-mailbox-unread.tsx", {"serverUrl": "http://<central-host>:8787", "pollMs": 30000}]]
   }
   ```

   路径相对于该 `tui.json` 所在目录。先备份已有文件；将已有 team-mailbox 项改成上述 tuple，缺少才新增，保留其他插件和配置，不追加重复项。

3. 将 `serverUrl` 替换为管理员提供的共享中心 HTTP(S) 地址，不是本机 localhost（除非自己就是中心），也不是 Node 或 bridge 路径。无需永久环境变量。完全退出并重启 OpenCode，进入会话并展开侧栏；中心可达且有未读时至多约 30 秒显示，`total: 0` 不显示。可用 `get_unread_summary` 核对条数，用同一中心地址运行 `npm run doctor` 检查连通性和身份。

不装这个插件不影响消息收发，只是没有未读提醒。

## 已安装用户更新

在自己的仓库检查 `git status` 后运行 `git pull --ff-only`，有本地冲突或无法快进就停止处理，不强制覆盖。必须从更新后的仓库重新复制覆盖上述两个安装文件，单独 pull 不会更新已安装副本。先备份 `tui.json`，按安装步骤更新已有 tuple 项并保留其他插件，再完全退出重启。依赖未变，无需重新 `npm ci`、安装或切换 Node。可直接转发[主 README 的更新提示词](../../README.zh-CN.md)。

## 配置优先级与环境变量回退

`tui.json` 的 `[路径, options]` 中，`serverUrl`、`pollMs` 分别优先于对应环境变量；只有该键缺省时才回退。显式非法选项会停用本插件，不会回退到另一个中心。`serverUrl` 仅接受无凭据、无 query/hash 的 HTTP(S) URL，HTTP 重定向禁止跟随。`pollMs` 必须为有限正数，最低 10000 毫秒并向下取整；缺省且无环境配置时为 30000。

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `MSG_SERVER_URL` | 仅未提供 `serverUrl` 时需要 | 无 | 管理员提供的中心 HTTP(S) 地址；未配置或非法时不渲染。 |
| `MSG_UNREAD_POLL_MS` | 否 | `30000` | 轮询间隔（毫秒）。**最低 10000**，低于此值按 10000 处理；非法值回落到 30000。 |

变量必须对启动 OpenCode 的那个进程可见。`MCP.environment` 只传给 MCP 子进程，不会回传给 TUI；推荐直接使用上面的 tuple 配置。

## 官方固定版本证据

核对版本：`v1.18.31`，commit `014614d35b397775e5d397a490fc72368c894ec2`：

- [TUI schema](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/tui/src/config/index.tsx)：`PluginSpec` 是字符串或 `[Schema.String, PluginOptions]`，`Info.plugin` 为其数组。
- [TUI 配置入口](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/config/tui.ts)：以 `TuiConfig.Info` 验证配置并解析插件路径。
- [路径与 options](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/config/plugin.ts)：`resolvePluginSpec` 保留 tuple 第二项，`pluginOptions` 返回它。
- [TUI runtime](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/plugin/tui/runtime.ts)：执行 `plugin.plugin(api, plugin.load.options, plugin.meta)`。本插件保留 `default { id, tui }` 导出。

实际确认：用户已在 OpenCode **1.18.31** 上确认修复后侧栏正常显示。纯逻辑测试不替代终端验证，也不保证所有未来版本；新安装可按上述步骤核对，不要通过发送或标读消息制造验证数据。

## 行为说明

- 数据来源是中心服务的 `GET /api/unread-summary`，无参数，身份由来源 IP 判定。
- 发件人顺序由服务端按最新未读时间倒序给出，插件原样渲染，不重新排序。
- 最多渲染 10 行发件人；超出部分直接不显示，**不显示「还有 N 个」之类的截断提示**。
- 每次请求 5 秒超时。请求失败、超时、HTTP 非 2xx、JSON 解析失败、字段缺失或类型不符，一律静默跳过本轮并保留上一次成功结果；连续失败不会抛异常、不会阻塞 OpenCode。
- 轮询定时器在侧栏卸载和插件销毁时清理。

## 稳定性声明

侧栏的 `sidebar_content` slot 是 **OpenCode 源码级接口，不在官方插件文档中，属于非承诺稳定接口**。OpenCode 升级后该接口可能变更或消失，插件随之失效。

失效时的表现：**侧栏不显示未读区块**。插件的 slot 注册整体包在 try/catch 中，注册失败只打印一条日志，不影响 OpenCode 启动，也不影响 team-mailbox 的消息收发和 MCP 工具。

## 自测

```bash
cd <仓库路径>/integrations/opencode
node --test
```

覆盖：正常多发件人、无未读、超过 10 个发件人、附件为 0、字段缺失与类型错误、轮询间隔下限与回落、各类请求失败后的降级与保留旧值。

自测只覆盖 `unread-core.mjs` 的纯逻辑。**实际的 slot 渲染和 OpenCode 加载需要在装有 OpenCode TUI 的机器上人工验证。**
