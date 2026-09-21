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

export const sendMessageSchema = z.object({
  to: memberNameSchema,
  title: z
    .string()
    .trim()
    .max(CONFIG.maxTitleChars, `Title cannot exceed ${CONFIG.maxTitleChars} characters`)
    .optional()
    .nullable(),
  text: z
    .string({ required_error: 'Message text is required' })
    .min(1, 'Message text cannot be empty')
    .max(CONFIG.maxTextChars, `Message text cannot exceed ${CONFIG.maxTextChars} characters`),
  project: z
    .string()
    .trim()
    .max(CONFIG.maxProjectChars, `Project cannot exceed ${CONFIG.maxProjectChars} characters`)
    .optional()
    .nullable(),
  reply_to: z
    .number()
    .int('reply_to must be an integer')
    .positive('reply_to must be a positive message ID')
    .optional()
    .nullable(),
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
