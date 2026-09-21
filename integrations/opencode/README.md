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

两个 `.mjs` 与 `.tsx` 必须放在同一目录，入口通过相对路径导入 `./unread-core.mjs`。

## 安装

1. 把本目录的 `team-mailbox-unread.tsx` 和 `unread-core.mjs` 复制到 OpenCode 的插件目录：

   - 全局：`~/.config/opencode/plugins/`（Windows：`%USERPROFILE%\.config\opencode\plugins\`）
   - 或项目级：`<项目目录>/.opencode/plugins/`

2. 在同级配置目录的 `tui.json` 里声明该插件。TUI 插件**不会**被自动扫描到（自动发现只匹配 `*.ts` / `*.js`，且 TUI 插件列表只读 `tui.json`），必须显式列出：

   `~/.config/opencode/tui.json`

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": ["./plugins/team-mailbox-unread.tsx"]
   }
   ```

   路径相对于该 `tui.json` 所在目录。若文件已存在，只需往 `plugin` 数组里追加一项。

3. 配置环境变量后重启 OpenCode。

不装这个插件不影响消息收发，只是没有未读提醒。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `MSG_SERVER_URL` | 是 | 无 | 中心服务地址，例如 `http://<中心地址>:8787`。**未配置或不是合法的 http/https URL 时，插件不渲染任何内容，也不报错。** |
| `MSG_UNREAD_POLL_MS` | 否 | `30000` | 轮询间隔（毫秒）。**最低 10000**，低于此值按 10000 处理；非法值回落到 30000。 |

变量必须对启动 OpenCode 的那个进程可见（插件运行在 TUI 进程内，与 MCP bridge 是不同进程，不共享 MCP 配置里的环境变量）。

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
