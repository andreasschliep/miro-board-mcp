/**
 * zod schemas shared by several tools. The SDK turns them into the JSON Schema that
 * clients see in tools/list, and checks every call against them before a handler runs.
 */
import { z } from 'zod';
import { LIMITS } from './limits.ts';

export const documentInput = z
  .string()
  .max(LIMITS.specBytes)
  .describe(
    'The board as Markdown: "# Board name", one "## Heading" per frame; paragraphs become ' +
      'text, bullet lists sticky notes, and ```mermaid blocks (flowchart or wardley-beta) ' +
      'diagrams. The server places everything; write no coordinates. Read board-doc://guide first.',
  );

export const specInput = z
  .string()
  .max(LIMITS.specBytes)
  .describe(
    'Advanced, instead of document: a YAML spec in the generator format with exact ' +
      'coordinates (board-spec://schema). Use it only when the user asks for exact positions.',
  );

/** Every tool that reads a board takes it the same way. */
export const sourceFields = {
  document: documentInput.optional(),
  spec: specInput.optional(),
};

/** Miro board ids are short base64-like strings ending in "="; the pattern keeps them safe in URL paths. */
export const boardIdInput = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_=-]+$/, 'A Miro board id contains letters, digits, "_", "-" and "=".')
  .describe('Id of an existing Miro board (the part after /board/ in its URL).');

export const finding = z.object({
  path: z.string(),
  message: z.string(),
  line: z.number().optional(),
});

export const textFitFinding = z.object({
  frame_id: z.string(),
  element_index: z.number(),
  text: z.string(),
  deficit_px: z.number(),
  line: z.number().optional(),
});

export const layoutFinding = z.object({
  frame_id: z.string(),
  path: z.string(),
  message: z.string(),
  line: z.number().optional(),
});

export const validationReport = z.object({
  valid: z.boolean(),
  errors: z.array(finding),
  warnings: z.array(finding),
  text_fit: z.array(textFitFinding),
  layout: z.array(layoutFinding),
  summary: z.object({ frames: z.number(), spec_elements: z.number() }),
});

export const plannedFrame = z.object({
  order: z.number(),
  id: z.string(),
  title: z.string(),
  phase: z.string().optional(),
  elements: z.number(),
  /** Where the frame goes: centre and size in board units (finding from run 2). */
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const planTotals = z.object({
  frames: z.number(),
  elements: z.number(),
  connectors: z.number(),
  api_calls: z.number(),
});
