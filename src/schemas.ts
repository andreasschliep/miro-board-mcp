/**
 * zod schemas shared by several tools. The SDK turns them into the JSON Schema that
 * clients see in tools/list, and checks every call against them before a handler runs.
 */
import { z } from 'zod';
import { LIMITS } from './limits.ts';

export const specInput = z
  .string()
  .max(LIMITS.specBytes)
  .describe(
    'Board description as YAML text. Read the resource board-spec://schema first; ' +
      'board-spec://example shows a complete spec.',
  );

/** Miro board ids are short base64-like strings ending in "="; the pattern keeps them safe in URL paths. */
export const boardIdInput = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_=-]+$/, 'A Miro board id contains letters, digits, "_", "-" and "=".')
  .describe('Id of an existing Miro board (the part after /board/ in its URL).');

export const finding = z.object({ path: z.string(), message: z.string() });

export const textFitFinding = z.object({
  frame_id: z.string(),
  element_index: z.number(),
  text: z.string(),
  deficit_px: z.number(),
});

export const validationReport = z.object({
  valid: z.boolean(),
  errors: z.array(finding),
  warnings: z.array(finding),
  text_fit: z.array(textFitFinding),
  summary: z.object({ frames: z.number(), spec_elements: z.number() }),
});

export const plannedFrame = z.object({
  order: z.number(),
  id: z.string(),
  title: z.string(),
  phase: z.string().optional(),
  elements: z.number(),
});

export const planTotals = z.object({
  frames: z.number(),
  elements: z.number(),
  connectors: z.number(),
  api_calls: z.number(),
});
