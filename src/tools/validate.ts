/**
 * validate_board_spec: check a spec, change nothing.
 *
 * An invalid spec is the normal answer of a validator, so it comes back as
 * valid: false without isError (design decision D3). isError is reserved for a spec
 * that cannot be read at all: empty, too large, not YAML, !include, alias bomb.
 */
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from '../deps.ts';
import { domainError, success } from '../results.ts';
import { specInput, validationReport } from '../schemas.ts';
import { checkSpec, SpecError, type ValidationReport } from '../spec.ts';

export function validateBoardSpec(spec: string, deps: ServerDeps): CallToolResult {
  try {
    const { report } = checkSpec(spec, { allowedUrlHosts: deps.config.allowedUrlHosts });
    return success(describe(report), { ...report });
  } catch (error) {
    if (error instanceof SpecError)
      return domainError(error.message, error.hint, { code: error.code });
    throw error;
  }
}

function describe(report: ValidationReport): string {
  const { frames, spec_elements } = report.summary;
  if (report.valid) {
    const summary =
      `Valid: ${frames} frames, ${spec_elements} elements in the spec, ` +
      `${report.warnings.length} warnings, ${report.text_fit.length} text-fit warnings, ` +
      `${report.layout.length} layout warnings.`;
    if (report.layout.length === 0) return `${summary} Next: preview_board.`;
    return `${summary}\n${layoutLines(report)}\nFix the layout warnings, then validate again.`;
  }
  const first = report.errors
    .slice(0, 5)
    .map((e) => `- ${e.path}: ${e.message}`)
    .join('\n');
  return (
    `Invalid: ${report.errors.length} errors.\n${first}\n` +
    'Fix the spec and call validate_board_spec again. The schema is in board-spec://schema.'
  );
}

/** The first layout warnings as text lines (shared with preview_board). */
export function layoutLines(report: ValidationReport, max = 8): string {
  const lines = report.layout.slice(0, max).map((l) => `- ${l.path} (${l.frame_id}): ${l.message}`);
  if (report.layout.length > max) lines.push(`- ... ${report.layout.length - max} more`);
  return lines.join('\n');
}

export function registerValidateBoardSpec(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'validate_board_spec',
    {
      title: 'Validate a board spec',
      description:
        'Check a Miro board description (YAML) without building anything. Returns errors with a ' +
        'JSON path, warnings, texts that will not fit their shape, and layout warnings for ' +
        'elements outside their frame or on the title bar. Coordinates are offsets from the ' +
        'frame centre; for a line, toX/toY are distances from x/y. Read the resource ' +
        'board-spec://schema before writing a spec. An invalid spec is a normal answer here ' +
        '(valid: false); fix errors and layout warnings and call this tool again.',
      inputSchema: z.object({ spec: specInput }),
      outputSchema: validationReport,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ spec }) => validateBoardSpec(spec, deps),
  );
}
