import { z } from 'zod';
import { CONFIG } from './config.js';

export const memberNameRegex = /^[\p{L}\p{N}_-]{1,32}$/u;

export const memberNameSchema = z
  .string({ required_error: 'Member name is required' })
  .trim()
  .min(1, 'Member name must be at least 1 character')
  .max(CONFIG.maxNameChars, `Member name cannot exceed ${CONFIG.maxNameChars} characters`)
  .regex(memberNameRegex, 'Member name must contain only Unicode letters, digits, underscore (_), or hyphen (-)');

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Display name cannot be empty')
  .max(CONFIG.maxDisplayNameChars, `Display name cannot exceed ${CONFIG.maxDisplayNameChars} characters`);

// Path separators and control characters are removed so a sender can never
// steer where the recipient's bridge writes the file. Over-long names are
// rejected rather than truncated: silently renaming a file is worse than a
// clear 400, and truncation could also collide with an existing local file.
export function sanitizeAttachmentName(raw) {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim();
  if (cleaned.length === 0) return null;
  if (cleaned === '.' || cleaned === '..') return null;
  return cleaned;
}

const base64Schema = z
  .string({ required_error: 'attachment.data_base64 is required' })
  .min(1, 'attachment.data_base64 cannot be empty')
  .refine((value) => /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0,
    'attachment.data_base64 must be standard base64');

export const attachmentSchema = z.object({
  name: z
    .string({ required_error: 'attachment.name is required' })
    .min(1, 'attachment.name cannot be empty')
    .max(CONFIG.maxAttachmentNameChars,
      `attachment.name cannot exceed ${CONFIG.maxAttachmentNameChars} characters`)
    .transform(sanitizeAttachmentName)
    .refine((value) => value !== null,
      'attachment.name must contain characters other than path separators or control characters'),
  mime: z
    .string()
    .trim()
    .max(CONFIG.maxAttachmentMimeChars,
      `attachment.mime cannot exceed ${CONFIG.maxAttachmentMimeChars} characters`)
    .optional()
    .nullable(),
  data_base64: base64Schema,
  sha256: z
    .string({ required_error: 'attachment.sha256 is required' })
    .regex(/^[0-9a-fA-F]{64}$/, 'attachment.sha256 must be 64 hexadecimal characters')
    .transform((value) => value.toLowerCase()),
}).strict();

export const sendMessageSchema = z.object({
  to: memberNameSchema,
  title: z
    .string()
    .trim()
    .max(CONFIG.maxTitleChars, `Title cannot exceed ${CONFIG.maxTitleChars} characters`)
    .optional()
    .nullable(),
  // Optional only when an attachment is present; the object-level refinement below
  // keeps the old "text is required" contract for plain text messages.
  text: z
    .string()
    .min(1, 'Message text cannot be empty')
    .max(CONFIG.maxTextChars, `Message text cannot exceed ${CONFIG.maxTextChars} characters`)
    .optional()
    .nullable(),
  attachment: attachmentSchema.optional().nullable(),
  project: z
    .string()
    .trim()
    .max(CONFIG.maxProjectChars, `Project cannot exceed ${CONFIG.maxProjectChars} characters`)
    .optional()
    .nullable(),
}).refine((value) => (value.text != null && value.text !== '') || value.attachment != null,
  { message: 'Message text is required when no attachment is provided', path: ['text'] });

export const attachmentTextQuerySchema = z.object({
  offset: z.coerce.number().int().nonnegative('offset must be non-negative').default(0),
  limit: z
    .coerce
    .number()
    .int()
    .min(1)
    .max(CONFIG.maxReadChunkLimit)
    .default(CONFIG.defaultReadChunkLimit),
});

export const getMsgQuerySchema = z.object({
  from: memberNameSchema.optional(),
  unread_only: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .optional()
    .transform((val) => val === true || val === 'true' || val === '1'),
  project: z
    .string()
    .trim()
    .max(CONFIG.maxProjectChars)
    .optional(),
  cursor: z
    .coerce
    .number()
    .int()
    .nonnegative('cursor must be non-negative')
    .optional(),
  limit: z
    .coerce
    .number()
    .int()
    .min(1)
    .max(CONFIG.maxPageLimit)
    .default(CONFIG.defaultPageLimit),
});

export const readMessageQuerySchema = z.object({
  id: z.coerce.number().int().positive('id must be a positive integer'),
  offset: z.coerce.number().int().nonnegative('offset must be non-negative').default(0),
  limit: z
    .coerce
    .number()
    .int()
    .min(1)
    .max(CONFIG.maxReadChunkLimit)
    .default(CONFIG.defaultReadChunkLimit),
});

export const markReadSchema = z.object({
  ids: z
    .array(z.number().int().positive('IDs must be positive integers'))
    .min(1, 'At least one ID must be provided')
    .max(100, 'Cannot mark more than 100 messages at once'),
});
