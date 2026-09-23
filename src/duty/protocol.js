import { createHash } from 'node:crypto';

function invalid(detail, code = 'WORK_PROTOCOL_INVALID') {
  const error = new Error(detail);
  error.code = code;
  throw error;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const present = value => typeof value === 'string' && value.trim().length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === 'string' && /^(?:[\da-fA-F]{40}|[\da-fA-F]{64})$/.test(value);
const required = (condition, field) => { if (!condition) invalid(`Invalid or missing ${field}`); };
const strings = (value, field, allowEmpty = false) => {
  required(Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(present), field);
};
const keys = (value, field, allowed) => {
  required(object(value), field);
  for (const key of Object.keys(value)) required(allowed.includes(key), `${field}.${key}`);
};
const relatedFile = value => {
  if (!present(value) || /[\x00-\x1f\x7f]/.test(value)) return false;
  // Normalize separators before checking segments; drive letters and UNC roots are never relative.
  const normalized = value.replace(/\\/g, '/');
  return !normalized.startsWith('/') && !/^[a-zA-Z]:/.test(normalized)
    && !normalized.split('/').some(segment => segment === '..' || segment === '' || segment === '.');
};

// Validate the exact mailbox projection before serializing. In particular, never
// let JSON.stringify turn an undefined array member into null.
function projection(message, content = false) {
  required(object(message), 'message');
  required(positive(message.id), 'id');
  for (const key of ['from', 'to', 'project', 'title', 'text']) required(present(message[key]), key);
  required(Object.hasOwn(message, 'attachment'), 'attachment');
  let attachment = null;
  if (message.attachment !== null) {
    const file = message.attachment;
    required(object(file), 'attachment');
    required(positive(file.id), 'attachment.id');
    required(present(file.name), 'attachment.name');
    required(Number.isSafeInteger(file.size) && file.size > 0, 'attachment.size');
    required(file.mime === null || present(file.mime), 'attachment.mime');
    required(typeof file.sha256 === 'string' && /^[\da-fA-F]{64}$/.test(file.sha256), 'attachment.sha256');
    attachment = content
      ? [file.name, file.size, file.mime, file.sha256]
      : [file.id, file.name, file.size, file.mime, file.sha256];
  }
  return content
    ? ['duty-content-v1', message.from, message.to, message.project, message.title, message.text, attachment]
    : ['duty-envelope-v1', message.id, message.from, message.to, message.project, message.title, message.text, attachment];
}

const digest = projection => createHash('sha256').update(JSON.stringify(projection), 'utf8').digest('hex');
export function envelopeDigest(message) { return digest(projection(message)); }
export function contentDigest(message) { return digest(projection(message, true)); }

export function parseWorkOrder(message, { sender = '洪伟填', project = 'tuantuan-rent', role } = {}) {
  projection(message);
  required(present(sender) && present(project) && (role === undefined || ['FIX', 'QA'].includes(role)), 'intake scope');
  if (message.from !== sender || message.project !== project) invalid('Sender or project outside intake scope', 'SCOPE_DENIED');
  const title = /^\[WORK:v1\]\[(FIX|QA)\]\[(TEST|BUGFIX|TEST_FIX)\]\[([^\[\]\r\n]+)\] (\S[^\r\n]*)$/.exec(message.title);
  required(title && title[3].trim() === title[3] && title[4].trim() === title[4], 'WORK title');
  const [, target, mode, ticket] = title;
  required(target !== 'QA' || mode === 'TEST', 'QA mode');
  if (role !== undefined && target !== role) invalid('Role outside intake scope', 'SCOPE_DENIED');

  // Exactly one JSON fence; explanatory prose may follow the closing fence.
  const fence = /^\s*```json[ \t]*\r?\n([\s\S]*?)\r?\n```(?:[ \t]*\r?\n[\s\S]*)?$/.exec(message.text);
  required(fence && (message.text.match(/```/g) ?? []).length === 2, 'single fenced JSON block');
  let work;
  try { work = JSON.parse(fence[1]); } catch { invalid('Malformed WORK JSON'); }
  required(object(work), 'WORK object');
  required(work.schema === 'on-duty.work.v1', 'schema');
  required(work.ticket_id === ticket && work.target === target && work.mode === mode, 'title/body identity');
  required(work.project === message.project && work.project === project, 'project identity');
  required(positive(work.revision), 'revision');
   required(present(work.summary), 'summary');
   keys(work, 'WORK', ['schema', 'ticket_id', 'revision', 'project', 'target', 'mode', 'summary', 'code', 'bug', 'requirements', 'environment', 'constraints', 'references', 'previous_report_id']);
   if (Object.hasOwn(work, 'previous_report_id')) required(present(work.previous_report_id) || positive(work.previous_report_id), 'previous_report_id');
   if (Object.hasOwn(work, 'references')) {
     keys(work.references, 'references', ['message_ids']);
     if (Object.hasOwn(work.references, 'message_ids')) required(Array.isArray(work.references.message_ids) && work.references.message_ids.every(positive), 'references.message_ids');
   }
   keys(work.code, 'code', ['head_commit', 'base_commit', 'base_omission_reason', 'related_files', 'dirty_scope']);
   required(object(work.code) && sha(work.code.head_commit), 'code.head_commit');
   if (Object.hasOwn(work.code, 'base_commit')) required(sha(work.code.base_commit), 'code.base_commit');
   if (Object.hasOwn(work.code, 'base_omission_reason')) required(present(work.code.base_omission_reason), 'code.base_omission_reason');
  if (mode === 'BUGFIX') {
    required(sha(work.code.base_commit) || present(work.code.base_omission_reason), 'code baseline or omission reason');
  } else required(sha(work.code.base_commit), 'code.base_commit');
   strings(work.code.related_files, 'code.related_files', true);
   required(work.code.related_files.every(relatedFile), 'code.related_files repository-relative paths');
   required(present(work.code.dirty_scope), 'code.dirty_scope');
   keys(work.requirements, 'requirements', ['expected', 'acceptance', 'documents', 'must_verify']);
   required(object(work.requirements) && present(work.requirements.expected), 'requirements.expected');
   required(Array.isArray(work.requirements.acceptance) && work.requirements.acceptance.length > 0 && work.requirements.acceptance.every(item => object(item) && present(item.id) && present(item.statement)), 'requirements.acceptance');
   for (const item of work.requirements.acceptance) keys(item, 'requirements.acceptance item', ['id', 'statement']);
   required(Array.isArray(work.requirements.documents) && work.requirements.documents.every(item => object(item) && present(item.ref) && present(item.version) && present(item.section)), 'requirements.documents');
   for (const item of work.requirements.documents) keys(item, 'requirements.documents item', ['ref', 'version', 'section']);
   strings(work.requirements.must_verify, 'requirements.must_verify');
   keys(work.environment, 'environment', ['target', 'roles', 'profile', 'account_ref', 'data_refs', 'cleanup']);
   required(object(work.environment) && present(work.environment.target), 'environment.target');
   for (const field of ['profile', 'account_ref']) if (Object.hasOwn(work.environment, field)) required(present(work.environment[field]), `environment.${field}`);
  strings(work.environment.roles, 'environment.roles');
  strings(work.environment.data_refs, 'environment.data_refs');
  required(present(work.environment.cleanup), 'environment.cleanup');
   keys(work.constraints, 'constraints', ['scope', 'out_of_scope', 'fallback', 'high_risk', 'allow_commit', 'allow_push']);
   required(present(work.constraints.scope) && present(work.constraints.fallback), 'constraints.scope/fallback');
  strings(work.constraints.out_of_scope, 'constraints.out_of_scope', true);
  strings(work.constraints.high_risk, 'constraints.high_risk', true);
   for (const flag of ['allow_commit', 'allow_push']) {
     required(!Object.hasOwn(work.constraints, flag) || typeof work.constraints[flag] === 'boolean', `constraints.${flag}`);
     required(work.constraints[flag] !== true, `constraints.${flag}: local duty v1 does not accept commit/push authority`);
   }
   if (mode === 'BUGFIX') {
     keys(work.bug, 'bug', ['actual', 'expected', 'reproduction_steps', 'unstable_reproduction_reason']);
     required(object(work.bug) && present(work.bug.actual) && present(work.bug.expected), 'bug.actual/expected');
     if (Object.hasOwn(work.bug, 'reproduction_steps')) strings(work.bug.reproduction_steps, 'bug.reproduction_steps');
     if (Object.hasOwn(work.bug, 'unstable_reproduction_reason')) required(present(work.bug.unstable_reproduction_reason), 'bug.unstable_reproduction_reason');
     required((Array.isArray(work.bug.reproduction_steps) && work.bug.reproduction_steps.length > 0 && work.bug.reproduction_steps.every(present)) || present(work.bug.unstable_reproduction_reason), 'bug reproduction');
   } else if (Object.hasOwn(work, 'bug')) {
     required(mode === 'TEST_FIX', 'bug only allowed for BUGFIX or TEST_FIX');
     keys(work.bug, 'bug', ['actual', 'expected', 'reproduction_steps', 'unstable_reproduction_reason']);
     required(present(work.bug.actual) && present(work.bug.expected), 'bug.actual/expected');
     if (Object.hasOwn(work.bug, 'reproduction_steps')) strings(work.bug.reproduction_steps, 'bug.reproduction_steps');
     if (Object.hasOwn(work.bug, 'unstable_reproduction_reason')) required(present(work.bug.unstable_reproduction_reason), 'bug.unstable_reproduction_reason');
     required(Object.hasOwn(work.bug, 'reproduction_steps') || present(work.bug.unstable_reproduction_reason), 'bug reproduction');
   }
  return work;
}
