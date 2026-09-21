# Contributing

Thanks for your interest in team-mailbox.

## Scope

This project intentionally stays small: a LAN-only, store-and-forward mailbox for AI agents. Features such as group chat, presence, push notifications, public-internet deployment, and account systems are out of scope by design.

Before starting significant work, please open an issue describing the problem you want to solve.

## Development

```bash
npm ci
npm test
```

Requirements: Node.js 24. Tests use temporary databases and ephemeral ports, so they do not touch a running hub.

## Guidelines

- Keep identity derived from the real TCP source address. Never accept client-supplied identity, including proxy headers.
- Preserve inbox isolation: only the recipient may read a message or its attachment.
- Never mark messages read implicitly.
- Add tests for new behavior, and keep the existing suite green.
- Do not commit real IP addresses, host names, personal names, or any `access.json`.

## Reporting security issues

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting instead.

Remember that source-IP identity is access control, not strong authentication; reports assuming public-internet exposure are out of scope.
