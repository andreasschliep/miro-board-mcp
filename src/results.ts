/**
 * Tool results. Two kinds, deliberately different (design section 6):
 *
 * - success: the tool did its job. Text for people, structuredContent for programs.
 * - domain error: the tool understood the request but could not do the job (invalid
 *   spec, missing token, Miro said 401). isError: true plus a hint, so the model can
 *   correct itself. Protocol errors (unknown tool, malformed request) never get here;
 *   the SDK answers those with JSON-RPC errors.
 *
 * A domain error carries no structuredContent. Some clients (the MCP Inspector, for
 * one) validate structuredContent against the tool's outputSchema even when isError is
 * true, so an error object of a different shape would be rejected on the client side.
 * Details go into the text instead. Partial build results are the exception: they
 * conform to the output schema and keep their structured form (tools/build.ts).
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { MiroApiError } from 'miro-board-builder';

export function success(text: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: data };
}

export function domainError(
  message: string,
  hint: string,
  details?: Record<string, unknown>,
): CallToolResult {
  const detailText = details ? `\nDetails: ${JSON.stringify(details)}` : '';
  return {
    isError: true,
    content: [{ type: 'text', text: `${message}\nHint: ${hint}${detailText}` }],
  };
}

/** What to tell the agent for a Miro status code. */
export function hintForStatus(status: number | null | undefined): string {
  switch (status) {
    case 401:
      return 'The Miro token is missing, invalid or expired. Ask the user to renew MIRO_ACCESS_TOKEN; retrying will not help.';
    case 403:
      return 'The token may not do this: it needs boards:read and boards:write, and access to this board. Ask the user.';
    case 404:
      return 'The board does not exist or the token cannot see it. Check the board id with the user.';
    case 429:
      return 'Miro rate limit. Wait a minute before trying again.';
    default:
      return 'Miro did not accept the request. Tell the user what failed instead of retrying in a loop.';
  }
}

/** Maps an error from a Miro call to a domain error result. */
export function miroError(error: unknown, action: string): CallToolResult {
  if (error instanceof MiroApiError) {
    return domainError(`${action} failed: ${error.message}`, hintForStatus(error.status), {
      status: error.status,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return domainError(`${action} failed: ${message}`, hintForStatus(null));
}
