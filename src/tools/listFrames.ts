/**
 * list_frames: check a result on Miro.
 *
 * Returns frame titles and geometry only, never element content (data minimisation,
 * threat T4), and only for boards the server may touch.
 */
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { boardUrl, isBoardAllowed, type ServerDeps } from '../deps.ts';
import { domainError, miroError, success } from '../results.ts';
import { boardIdInput } from '../schemas.ts';

/** Enough for any real board; stops a runaway paging loop. */
const MAX_PAGES = 10;

const frameInfo = z.object({
  id: z.string(),
  title: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export const listFramesOutput = z.object({
  board_id: z.string(),
  board_url: z.string(),
  count: z.number(),
  truncated: z.boolean(),
  frames: z.array(frameInfo),
});

interface MiroItemPage {
  data?: Array<{
    id?: string;
    data?: { title?: string };
    position?: { x?: number; y?: number };
    geometry?: { width?: number; height?: number };
  }>;
  cursor?: string | null;
}

export async function listFrames(boardId: string, deps: ServerDeps): Promise<CallToolResult> {
  if (!isBoardAllowed(deps, boardId)) {
    return domainError(
      `Board ${boardId} is not allowed for this server.`,
      'Only boards on MIRO_MCP_ALLOWED_BOARD_IDS or boards built by this server can be listed.',
    );
  }
  const token = deps.config.token;
  if (!token) {
    return domainError(
      'MIRO_ACCESS_TOKEN is not set for this MCP server.',
      'Ask the user to configure the token (see .env.example).',
    );
  }

  const transport = deps.createTransport(token);
  const frames: z.infer<typeof frameInfo>[] = [];
  let cursor: string | null | undefined = null;
  let pages = 0;
  try {
    do {
      const query = `type=frame&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = (await transport.request(
        'GET',
        `/boards/${encodeURIComponent(boardId)}/items?${query}`,
      )) as MiroItemPage | null;
      for (const item of page?.data ?? []) {
        frames.push({
          id: String(item.id ?? ''),
          title: item.data?.title ?? '',
          ...(item.position?.x !== undefined ? { x: item.position.x } : {}),
          ...(item.position?.y !== undefined ? { y: item.position.y } : {}),
          ...(item.geometry?.width !== undefined ? { width: item.geometry.width } : {}),
          ...(item.geometry?.height !== undefined ? { height: item.geometry.height } : {}),
        });
      }
      cursor = page?.cursor;
      pages++;
    } while (cursor && pages < MAX_PAGES);
  } catch (error) {
    return miroError(error, `Listing the frames of board ${boardId}`);
  }

  const truncated = Boolean(cursor);
  const lines = frames.map((f, i) => `${i + 1}. ${f.title || '(untitled)'}`);
  return success(
    `${frames.length} frames on ${boardUrl(boardId)}${truncated ? ' (first pages only)' : ''}:\n${lines.join('\n')}`,
    { board_id: boardId, board_url: boardUrl(boardId), count: frames.length, truncated, frames },
  );
}

export function registerListFrames(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'list_frames',
    {
      title: 'List the frames of a board',
      description:
        'List the frames on a Miro board (titles and positions, no content) to check what ' +
        'build_board created. Works for boards built by this server and for allowlisted boards.',
      inputSchema: z.object({ board_id: boardIdInput }),
      outputSchema: listFramesOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ({ board_id }) => listFrames(board_id, deps),
  );
}
