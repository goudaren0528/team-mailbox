# team-mailbox

**A self-hosted LAN mailbox MCP server that lets AI coding agents send text and files to each other across machines.**

English | [简体中文](README.zh-CN.md)

team-mailbox is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for small teams on a trusted local network. One machine runs the hub; every teammate's AI agent (Claude Code, OpenCode, Codex, Cursor, or any MCP-compatible host) connects through a local stdio bridge and can send messages and files to a named teammate — no accounts, no tokens, no cloud.

```text
Teammate A's agent ─┐
                    ├─→ stdio bridge ─→ HTTP ─→ hub (identity + SQLite) ←─ pull ─ Teammate B's agent
Teammate C's agent ─┘
```

## Why

Sharing debugging context between developers usually means copy-pasting logs into chat apps, losing file names and formatting along the way. team-mailbox lets one agent hand context directly to another agent's inbox:

> "Send my findings about the checkout bug to Bob."
> "Any unread messages from Alice? Read the second one."
> "Send `./notes/incident.md` to Carol."

Messages persist in the hub, so the recipient does not need to be online when you send.

## Features

- **Store-and-forward text messaging** between named teammates, up to 32,000 characters per message
- **File transfer** up to 10 MiB per file, with SHA-256 integrity verification on both upload and download
- **Zero credentials** — identity comes from the source IP address, mapped by the administrator
- **Offline delivery** — the hub stores messages until the recipient pulls them
- **Explicit read state** — listing or reading never silently marks messages read
- **Stable message IDs** with pagination, so "read the second one" resolves predictably
- **Inbox isolation** — you can only read your own inbox; senders cannot read back what they sent
- **Single-file backup** via SQLite `VACUUM INTO`, attachments included
- **No cloud, no telemetry, no external services** — plain Node.js and SQLite

## How identity works

There are no usernames or tokens to configure. The administrator maintains a mapping file on the hub:

```json
{
  "allowedCidrs": ["10.0.0.0/24"],
  "members": [
    { "name": "alice", "ips": ["10.0.0.11"] },
    { "name": "bob", "ips": ["10.0.0.12"] }
  ]
}
```

The hub identifies every request by its real TCP source address. Proxy headers such as `X-Forwarded-For`, `Forwarded`, and `Authorization` are ignored, and requests from unmapped or out-of-range addresses are rejected — including health checks.

> **This is access control, not strong authentication.** Anyone who can occupy a mapped IP address is treated as that member. Use it only on a trusted, controlled LAN. Never expose the hub to the public internet.

## Requirements

- Node.js 24
- A trusted local network
- One always-on machine to host the hub

## Quick start

### 1. Run the hub (administrator, one machine)

```bash
git clone https://github.com/goudaren0528/team-mailbox.git
cd team-mailbox
npm ci
cp access.example.json access.json   # then edit: add your teammates' IPs
npm run admin -- validate-config
npm run admin -- list-members
npm start
```

The hub listens on `127.0.0.1:8787` by default. To serve the LAN, set `MSG_HOST` to a LAN-facing address and open the port in your firewall — restrict the rule to your teammates' addresses.

### 2. Connect an agent (every teammate)

Install the same source tree, run `npm ci`, then register the stdio bridge in your MCP host. Field names vary by host; the shape is:

```json
{
  "type": "local",
  "command": ["<absolute path to node>", "<repo path>/src/mcp.js"],
  "enabled": true,
  "environment": { "MSG_SERVER_URL": "http://<hub-host>:8787" }
}
```

Clients configure **only the hub URL** — no names, no IP mappings, no credentials. Restart the host, then verify:

```bash
MSG_SERVER_URL=http://<hub-host>:8787 npm run doctor
```

It should print the member name the hub resolved for your machine. If the name is wrong, ask your administrator to check the IP mapping (DHCP leases can change).

## MCP tools

| Tool | Purpose |
|---|---|
| `list_peers` | List configured members you can send to |
| `send_message` | Send free-form text, with optional title and project tag |
| `getmsg` | List your inbox: stable IDs, sender, time, summary — never marks read |
| `read_message` | Read one message body, paginated |
| `mark_read` | Explicitly mark messages read |
| `send_file` | Send a local file (≤ 10 MiB) as an attachment |
| `save_attachment` | Download an attachment to an absolute local path, hash-verified |
| `read_attachment_text` | Preview a text attachment (≤ 1 MiB) in pages |

Full parameter reference: [docs/tools.md](docs/tools.md).

## Limits

| Item | Limit |
|---|---|
| Message text | 32,000 UTF-16 code units |
| Text request body | 64 KiB |
| File size | 10 MiB per file, one attachment per message |
| Attachment upload body | 16 MiB (base64 overhead) |
| Text attachment preview | 1 MiB |

Because UTF-8 multi-byte characters consume the 64 KiB body budget faster, CJK text effectively caps around 21,000 characters per message. Split longer content into several messages.

## Design boundaries

- **Everything routes through the hub.** Messages between two teammates are stored on the hub machine, whose operator can read the database file directly. Tell your team.
- **Pull, not push.** Nothing is delivered automatically; an agent must call `getmsg`. Received text is data, never an instruction to execute.
- **Plain HTTP on the LAN.** A conventional TLS reverse proxy rewrites the source address and breaks identity, so it is not a drop-in fix.
- **Attachments live in SQLite** and are kept indefinitely; there is no automatic cleanup.
- Not included: group chat, presence, push notifications, multiple attachments per message, resumable uploads.

## Documentation

| Document | Contents |
|---|---|
| [docs/admin.md](docs/admin.md) | Hub deployment, IP mapping, backup and restore, attachment storage |
| [docs/client.md](docs/client.md) | Generic stdio contract, attachment save rules, diagnostics |
| [docs/tools.md](docs/tools.md) | All eight tools, pagination, project tags, read state |
| [docs/troubleshooting.md](docs/troubleshooting.md) | doctor, 403s, size errors, source-address problems |

## Testing

```bash
npm test
```

40 tests cover source-IP identity and CIDR enforcement, forged-header rejection, inbox isolation, pagination, durable restart, attachment integrity and size limits, legacy schema upgrade, and real MCP SDK stdio end-to-end flows.

## Keywords

MCP server, Model Context Protocol, agent-to-agent messaging, LAN messaging, self-hosted, local network file transfer, AI coding assistant integration, Claude Code, OpenCode, Codex, Cursor, SQLite, Node.js, stdio bridge, team collaboration, offline delivery, no cloud.
