---
description: 查看消息、读消息、查看某人的消息或阅读工单消息；浏览用原生选项，明确ID直接阅读，先收附件再读正文
---

Load the `team-mailbox-read` skill through the skill tool, then follow it for this
explicit message-reading request. User filters or intent: $ARGUMENTS

If the skill is missing, explain that its folder must be installed in the same
OpenCode scope's skills/ directory and stop. Do not improvise a Markdown inbox list.
Reading TEST/BUGFIX/TEST_FIX/RESULT work-order messages belongs to team-mailbox-read;
do not route to dispatch merely because of TEST keywords.
Browsing multiple messages requires native question, not an assistant Markdown
candidate list or table, MCP elicitation or submit prompt. If question is unavailable,
explain the limitation and ask which alternative the user wants; never silently downgrade.
An explicit message ID with direct-read intent needs no redundant selection; follow
the skill's metadata lookup and attachment-before-body workflow for that exact ID.
Raw tool JSON may remain visible in host previews/details; do not promise to hide it.
These are Agent instructions, not runtime enforcement. Do not
install files, set MSG_DOWNLOAD_DIR, send messages or change configuration here.
