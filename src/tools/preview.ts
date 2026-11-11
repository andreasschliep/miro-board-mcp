/**
 * preview_board: what build_board would do, without contacting Miro.
 *
 * Runs the real builder against the generator's dry-run transport (src/plan.ts) and
 * returns spec_hash, the fingerprint build_board later requires as confirm_hash.
 */
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from '../deps.ts';
import { LIMITS } from '../limits.ts';
import { planBuild } from '../plan.ts';
import { domainError, success } from '../results.ts';
import { finding, plannedFrame, planTotals, specInput, textFitFinding } from '../schemas.ts';
import { checkSpec, SpecError } from '../spec.ts';

export const previewOutput = z.object({
  board_name: z.string(),
  frames: z.array(plannedFrame),
  totals: planTotals,
  estimated_seconds: z.number(),
  spec_hash: z.string(),
  warnings: z.array(finding),
  text_fit: z.array(textFitFinding),
});

export async function previewBoard(spec: string, deps: ServerDeps): Promise<CallToolResult> {
  let checked;
  try {
    checked = checkSpec(spec, { allowedUrlHosts: deps.config.allowedUrlHosts });
  } catch (error) {
    if (error instanceof SpecError)
      return domainError(error.message, error.hint, { code: error.code });
    throw error;
  }
  const { report, board } = checked;
  if (!report.valid || !board) {
    return domainError(
      `The spec is not valid (${report.errors.length} errors).`,
      'Call validate_board_spec, fix the errors, then preview again.',
      { validation: report },
    );
  }

  const plan = await planBuild(board);
  if (plan.totals.api_calls > LIMITS.apiCalls) {
    return domainError(
      `The board needs ${plan.totals.api_calls} Miro API calls; the limit is ${LIMITS.apiCalls}.`,
      'Split the workshop into smaller boards.',
      { totals: plan.totals },
    );
  }

  const lines = plan.frames.map(
    (f) => `${f.order}. ${f.title}${f.phase ? ` [${f.phase}]` : ''}: ${f.elements} elements`,
  );
  const text =
    `Preview of "${plan.board_name}": ${plan.totals.frames} frames, ${plan.totals.elements} elements, ` +
    `${plan.totals.connectors} connectors, ${plan.totals.api_calls} Miro API calls ` +
    `(about ${plan.estimated_seconds} s).\n${lines.join('\n')}\n` +
    `spec_hash: ${plan.spec_hash}\n` +
    'Show this list to the user. Only after the user confirms, call build_board with ' +
    'dry_run: false and confirm_hash set to spec_hash.';
  return success(text, { ...plan, warnings: report.warnings, text_fit: report.text_fit });
}

export function registerPreviewBoard(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'preview_board',
    {
      title: 'Preview a board',
      description:
        'Dry run for a valid spec, without contacting Miro: the frames build_board would create, ' +
        'in build order with element counts, the number of Miro API calls, an estimated duration ' +
        'and spec_hash. Show the frame list to the user and ask for confirmation before calling ' +
        'build_board; pass spec_hash as confirm_hash.',
      inputSchema: z.object({ spec: specInput }),
      outputSchema: previewOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ spec }) => previewBoard(spec, deps),
  );
}
