/**
 * validate_board: check a board, change nothing.
 *
 * An invalid board is the normal answer of a validator, so it comes back as
 * valid: false without isError (design decision D3). isError is reserved for input
 * that cannot be read at all: empty, too large, not YAML, !include, alias bomb.
 */
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { policyFrom } from '../config.ts';
import type { ServerDeps } from '../deps.ts';
import { domainError, success } from '../results.ts';
import { sourceFields, validationReport } from '../schemas.ts';
import { checkSource, type SourceInput } from '../source.ts';
import type { NormalizedBoard } from 'miro-board-builder';
import { SpecError, type ValidationReport } from '../spec.ts';

export async function validateBoard(input: SourceInput, deps: ServerDeps): Promise<CallToolResult> {
  try {
    const { report, board } = await checkSource(input, policyFrom(deps.config));
    return success(describe(report, input.spec !== undefined, board), { ...report });
  } catch (error) {
    if (error instanceof SpecError)
      return domainError(error.message, error.hint, { code: error.code });
    throw error;
  }
}

function describe(
  report: ValidationReport,
  isSpec: boolean,
  board: NormalizedBoard | null,
): string {
  const { frames, spec_elements } = report.summary;
  const warnings = report.warnings.length
    ? `\n${report.warnings
        .slice(0, 8)
        .map((w) => `- ${w.path}: ${w.message}`)
        .join('\n')}`
    : '';
  if (report.valid) {
    const summary =
      `Valid: ${frames} frames, ${spec_elements} elements and connectors ` +
      ((board?.style as { headerBar?: boolean } | undefined)?.headerBar === false
        ? ''
        : '(the title bar of each frame is added later and not counted)') +
      ', ' +
      `${report.warnings.length} warnings, ${report.text_fit.length} text-fit warnings, ` +
      `${report.layout.length} layout warnings.${warnings}`;
    if (report.layout.length === 0) return `${summary}\nNext: preview_board.`;
    return `${summary}\n${layoutLines(report)}\nFix the layout warnings, then validate again.`;
  }
  const first = report.errors
    .slice(0, 5)
    .map((e) => `- ${e.path}: ${e.message}`)
    .join('\n');
  return (
    `Invalid: ${report.errors.length} errors.\n${first}\n` +
    (isSpec
      ? 'Fix the spec and call validate_board again. The schema is in board-spec://schema.'
      : 'Fix the document and call validate_board again. The format is in board-doc://guide.')
  );
}

/** The first layout warnings as text lines (shared with preview_board). */
export function layoutLines(report: ValidationReport, max = 8): string {
  const lines = report.layout
    .slice(0, max)
    .map((l) => `- ${l.line ? `line ${l.line}` : l.path} (${l.frame_id}): ${l.message}`);
  if (report.layout.length > max) lines.push(`- ... ${report.layout.length - max} more`);
  return lines.join('\n');
}

export function registerValidateBoard(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'validate_board',
    {
      title: 'Validate a board',
      description:
        'Check a board without building anything. Pass it as document: Markdown with one ' +
        '"## Heading" per frame, paragraphs, bullet lists and ```mermaid blocks (flowchart or ' +
        'wardley-beta); read board-doc://guide first. Returns errors and warnings with their ' +
        'Markdown line, texts that will not fit their shape, and layout warnings. An invalid ' +
        'board is a normal answer here (valid: false); fix the errors and call this tool again.',
      inputSchema: z.object(sourceFields),
      outputSchema: validationReport,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => validateBoard(input, deps),
  );
}
