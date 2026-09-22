import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SKILL = 'integrations/opencode/skills/team-mailbox-read/SKILL.md';
const COMMAND = 'integrations/opencode/commands/team-mailbox-read.md';
const MCP = 'src/mcp.js';
const normalized = text => text.replace(/\s+/g, ' ');

test('single unread shortcut is wired into skill, command and tool descriptions', () => {
  const skill = normalized(fs.readFileSync(SKILL, 'utf8'));
  const command = normalized(fs.readFileSync(COMMAND, 'utf8'));
  const mcp = fs.readFileSync(MCP, 'utf8');

  // The guidance constant must actually reach tool descriptions, not sit unused.
  assert.match(mcp, /const SINGLE_UNREAD_GUIDANCE = '([^']+)';/);
  for (const name of ['getmsg', 'get_unread_summary']) {
    const registration = mcp.split(`'${name}',`)[1]?.split('mcpServer.tool(')[0];
    assert.ok(registration?.includes('${SINGLE_UNREAD_GUIDANCE}'), `${name}: shared single-unread guidance required`);
  }

  const guidance = mcp.match(/const SINGLE_UNREAD_GUIDANCE = '([^']+)';/)[1];
  for (const phrase of ['unread_only=true', 'cursor omitted or cursor=0', 'messages.length=1', 'hasMore=false',
    'Never apply this shortcut in all mode', 'After cancel, a new request queries again',
    'not runtime enforcement']) {
    assert.ok(guidance.includes(phrase), `guidance: ${phrase}`);
  }

  // Skill and command must state the same preconditions and never weaken them.
  for (const [name, text] of Object.entries({ skill, command })) {
    assert.match(text, /messages\.length=1/, `${name}: exact single-match requirement`);
    assert.match(text, /hasMore=false/, `${name}: completeness requirement`);
    assert.match(text, /unread_only=true/, `${name}: unread-only requirement`);
    assert.match(text, /cursor omitted or cursor=0/, `${name}: fresh-first-page requirement`);
    assert.match(text, /not runtime enforcement|Agent instructions, not runtime enforcement/, `${name}: honest limits`);
  }

  // Explicit safety boundaries that must not regress into silent behaviour.
  for (const phrase of ['No shortcut in all mode', 'never reuse cached uniqueness',
    'Zero matches means no reading/download', 'retry,', 'not a later page']) {
    assert.ok(skill.includes(phrase) || command.includes(phrase), phrase);
  }
  assert.match(skill, /Zero matches means no body read or download/);
  assert.match(skill, /Attachment failure still requires retry \/ explicit skip \/ cancel/);
  assert.match(skill, /Multiple matches or uncertain completeness require native question/);
  assert.match(skill, /All mode never gets this automatic single-result shortcut/);

  // The shortcut must not silently continue reading after an attachment failure.
  assert.match(skill, /never silently continue reading after failure/);
});
