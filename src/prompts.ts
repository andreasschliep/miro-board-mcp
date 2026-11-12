/**
 * Prompt template workshop_to_board: a reusable instruction a user can pick in the
 * client. It encodes the safe order: schema, spec, validate, preview, confirm, build.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const workshopArgs = z.object({
  topic: z.string().min(1).describe('Topic of the workshop or talk.'),
  duration_minutes: z
    .string()
    .regex(/^\d{1,3}$/, 'Minutes as a number, e.g. 90.')
    .describe('Length in minutes.'),
  participants: z
    .string()
    .regex(/^\d{1,4}$/, 'A number, e.g. 12.')
    .optional()
    .describe('Number of participants (optional).'),
  learning_objectives: z
    .string()
    .optional()
    .describe('Learning objectives, one per line (optional; the agent proposes some if missing).'),
});

export function workshopPrompt(args: z.infer<typeof workshopArgs>): string {
  return [
    `Create a Miro board for a ${args.duration_minutes}-minute workshop on "${args.topic}"` +
      (args.participants ? ` for ${args.participants} participants.` : '.'),
    '',
    ...(args.learning_objectives
      ? ['Learning objectives:', args.learning_objectives]
      : ['Propose three learning objectives and show them to me with the preview.']),
    '',
    'Work in this order:',
    '1. Read the resources board-spec://schema and board-spec://example.',
    '2. Write a board spec in YAML: one frame per agenda block, in session order, with ' +
      'short texts that fit their shapes. Use invented examples only, no real people, ' +
      'customers or company names.',
    '3. Call validate_board_spec and fix the spec until it is valid and has no layout warnings. ' +
      'Coordinates are offsets from the frame centre; for a line, toX/toY are distances from x/y. ' +
      'layout.frameSpacing and rowSpacing are distances between frame centres, not gaps.',
    '4. Call preview_board and show me the frame list with element counts and the estimated duration.',
    '5. Ask me whether to build. Do not continue without my explicit yes.',
    '6. After my yes, call build_board with target { new_board_name }, dry_run: false and ' +
      'confirm_hash set to the spec_hash from the preview. Then give me the board URL.',
  ].join('\n');
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'workshop_to_board',
    {
      title: 'Workshop to board',
      description:
        'Turn a workshop idea into a Miro board: write a spec, validate it, show a preview, ' +
        'and build only after the user confirms.',
      argsSchema: workshopArgs,
    },
    (args) => ({
      messages: [
        { role: 'user' as const, content: { type: 'text' as const, text: workshopPrompt(args) } },
      ],
    }),
  );
}
