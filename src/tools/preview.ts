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
import {
  finding,
  layoutFinding,
  plannedFrame,
  planTotals,
  sourceFields,
  textFitFinding,
} from '../schemas.ts';
import { checkSource, type SourceInput } from '../source.ts';
import { SpecError } from '../spec.ts';
import { layoutLines } from './validate.ts';

export const previewOutput = z.object({
  board_name: z.string(),
  frames: z.array(plannedFrame),
  totals: planTotals,
  estimated_seconds: z.number(),
  spec_hash: z.string(),
  warnings: z.array(finding),
  text_fit: z.array(textFitFinding),
  layout: z.array(layoutFinding),
});

export async function previewBoard(input: SourceInput, deps: ServerDeps): Promise<CallToolResult> {
  let checked;
  try {
    checked = await checkSource(input, { allowedUrlHosts: deps.config.allowedUrlHosts });
  } catch (error) {
    if (error instanceof SpecError)
      return domainError(error.message, error.hint, { code: error.code });
    throw error;
  }
  const { report, board } = checked;
  if (!report.valid || !board) {
    return domainError(
      `The board is not valid (${report.errors.length} errors).`,
      'Call validate_board, fix the errors, then preview again.',
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

  // The generator adds a title bar to every frame unless the board turns it off; it is
  // counted as an element here, which is why a frame has one more than its content.
  const style = (board.style ?? {}) as { headerBar?: boolean };
  const titleBars =
    style.headerBar === false ? 0 : board.frames.filter((f) => f.headerBar !== false).length;
  const lines = plan.frames.map(
    (f) =>
      `${f.order}. ${f.title}${f.phase ? ` [${f.phase}]` : ''}: ${f.elements} elements` +
      `${titleBars > 0 ? ' incl. title bar' : ''}, ${f.width} x ${f.height} at (${f.x}, ${f.y})`,
  );
  const text =
    `Preview of "${plan.board_name}": ${plan.totals.frames} frames, ${plan.totals.elements} elements ` +
    `(incl. ${titleBars} title bars), ` +
    `${plan.totals.connectors} connectors, ${plan.totals.api_calls} Miro API calls ` +
    `(about ${plan.estimated_seconds} s).\n${lines.join('\n')}\n` +
    (report.layout.length > 0
      ? `Layout warnings (${report.layout.length}); fix them before building:\n${layoutLines(report)}\n`
      : '') +
    `spec_hash: ${plan.spec_hash}\n` +
    'Show this list to the user. Only after the user confirms, call build_board with ' +
    'dry_run: false and confirm_hash set to spec_hash.';
  return success(text, {
    ...plan,
    warnings: report.warnings,
    text_fit: report.text_fit,
    layout: report.layout,
  });
}

export function registerPreviewBoard(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'preview_board',
    {
      title: 'Preview a board',
      description:
        'Dry run for a valid board (same document as validate_board), without contacting Miro: ' +
        'the frames build_board would create, in build order with element counts, position and ' +
        'size, the number of Miro API calls, an estimated duration and spec_hash. Show the frame ' +
        'list to the user and ask for confirmation before calling build_board; pass spec_hash ' +
        'as confirm_hash.',
      inputSchema: z.object(sourceFields),
      outputSchema: previewOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => previewBoard(input, deps),
  );
}
