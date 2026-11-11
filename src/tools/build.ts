/**
 * build_board: the only tool that writes to Miro.
 *
 * Guards, in the order they run:
 * 1. the spec is valid and within the limits (same checks as validate/preview)
 * 2. the target is a new board, or an existing board on the allowlist / created here
 * 3. a token is configured
 * 4. dry_run defaults to true: without an explicit false nothing is written
 * 5. confirm_hash must equal the hash of this spec, i.e. what preview_board showed
 * 6. at most LIMITS.buildsPerProcess real builds per server process
 * During the build: cancellation by the client and a wall-clock limit stop it between
 * frames; 401/403/404 stop it at once (generator 1.1.0). What exists is always returned.
 *
 * Not idempotent: a second call adds a second copy (see NOT_IDEMPOTENT).
 */
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import {
  BoardBuilder,
  MiroClient,
  type FrameProtocolEntry,
  type NormalizedBoard,
} from 'miro-board-builder';
import { z } from 'zod';
import { boardUrl, isBoardAllowed, type ServerDeps } from '../deps.ts';
import { LIMITS } from '../limits.ts';
import { collectingLogger } from '../logger.ts';
import { planBuild, type BuildPlan } from '../plan.ts';
import { domainError, hintForStatus, miroError, success } from '../results.ts';
import { boardIdInput, plannedFrame, planTotals, specInput } from '../schemas.ts';
import { checkSpec, SpecError } from '../spec.ts';

const NOT_IDEMPOTENT =
  'build_board is not idempotent: calling it again with new_board_name creates another board; ' +
  'calling it again with board_id adds a second copy of every frame.';

export const buildInput = z.object({
  spec: specInput,
  target: z
    .union([
      z
        .object({
          new_board_name: z
            .string()
            .min(1)
            .max(60)
            .describe('Name of a new board (Miro allows at most 60 characters).'),
        })
        .strict(),
      z.object({ board_id: boardIdInput }).strict(),
    ])
    .describe('Either { new_board_name } or { board_id } of an allowed existing board.'),
  dry_run: z
    .boolean()
    .default(true)
    .describe('true (default): check everything, write nothing. false: build the board.'),
  confirm_hash: z
    .string()
    .optional()
    .describe('Required when dry_run is false: the spec_hash from preview_board for this spec.'),
});

export type BuildInput = z.infer<typeof buildInput>;

const frameOutcome = z.object({
  frame_id: z.string(),
  title: z.string(),
  miro_id: z.string().nullable(),
  elements: z.number(),
  errors: z.number(),
  status: z.string(),
  error: z.string().optional(),
});

/** One object schema for both modes; fields that do not apply are null. */
export const buildOutput = z.object({
  dry_run: z.boolean(),
  target: z.string(),
  board_id: z.string().nullable(),
  board_url: z.string().nullable(),
  created_board: z.boolean(),
  spec_hash: z.string(),
  totals: planTotals,
  estimated_seconds: z.number(),
  planned_frames: z.array(plannedFrame).nullable(),
  frames: z.array(frameOutcome).nullable(),
  failures: z.array(z.string()),
  aborted: z.boolean(),
  abort_reason: z.string().nullable(),
  retries: z.number(),
  note: z.string(),
});

type BuildOutput = z.infer<typeof buildOutput>;

export interface BuildHooks {
  /** Cancellation from the client. */
  signal?: AbortSignal;
  /** Called after every frame (progress notifications). */
  onFrame?: (done: number, total: number, title: string) => void;
}

export async function buildBoard(
  input: BuildInput,
  deps: ServerDeps,
  hooks: BuildHooks = {},
): Promise<CallToolResult> {
  // 1. Spec
  let board: NormalizedBoard;
  let plan: BuildPlan;
  try {
    const checked = checkSpec(input.spec, { allowedUrlHosts: deps.config.allowedUrlHosts });
    if (!checked.report.valid || !checked.board) {
      return domainError(
        `The spec is not valid (${checked.report.errors.length} errors).`,
        'Call validate_board_spec, fix the errors, then preview_board.',
        { validation: checked.report },
      );
    }
    board = checked.board;
    plan = await planBuild(board);
  } catch (error) {
    if (error instanceof SpecError)
      return domainError(error.message, error.hint, { code: error.code });
    throw error;
  }
  const isNew = 'new_board_name' in input.target;
  const apiCalls = plan.totals.api_calls + (isNew ? 1 : 0);
  if (apiCalls > LIMITS.apiCalls) {
    return domainError(
      `The board needs ${apiCalls} Miro API calls; the limit is ${LIMITS.apiCalls}.`,
      'Split the workshop into smaller boards.',
    );
  }

  // 2. Target
  const targetText =
    'new_board_name' in input.target
      ? `new board "${input.target.new_board_name}"`
      : `existing board ${input.target.board_id}`;
  if ('board_id' in input.target && !isBoardAllowed(deps, input.target.board_id)) {
    return domainError(
      `Board ${input.target.board_id} is not allowed for this server.`,
      'Build on a new board (target: { new_board_name }), or ask the user to add the board id ' +
        'to MIRO_MCP_ALLOWED_BOARD_IDS.',
    );
  }

  // 3. Token
  const token = deps.config.token;
  if (!token) {
    return domainError(
      'MIRO_ACCESS_TOKEN is not set for this MCP server.',
      'Ask the user to configure the token (see .env.example). validate_board_spec and ' +
        'preview_board work without it.',
    );
  }
  const transport = deps.createTransport(token);

  // 4. Dry run (default): check the target, write nothing.
  if (input.dry_run) {
    if ('board_id' in input.target) {
      try {
        await transport.request('GET', `/boards/${encodeURIComponent(input.target.board_id)}`);
      } catch (error) {
        return miroError(error, `Reading board ${input.target.board_id}`);
      }
    }
    return success(
      `Dry run: would build ${plan.totals.frames} frames (${apiCalls} API calls, about ` +
        `${plan.estimated_seconds} s) on the ${targetText}. Nothing was written.\n` +
        `To build, after the user has confirmed the preview: dry_run: false, confirm_hash: ${plan.spec_hash}`,
      output({
        dry_run: true,
        target: targetText,
        board_id: 'board_id' in input.target ? input.target.board_id : null,
        spec_hash: plan.spec_hash,
        totals: { ...plan.totals, api_calls: apiCalls },
        estimated_seconds: plan.estimated_seconds,
        planned_frames: plan.frames,
      }),
    );
  }

  // 5. Confirmation hash. The expected value is not echoed: the way to get it is a preview.
  if (input.confirm_hash !== plan.spec_hash) {
    return domainError(
      input.confirm_hash
        ? 'confirm_hash does not match this spec; the spec changed after the preview.'
        : 'confirm_hash is missing.',
      'Call preview_board with exactly this spec, show the result to the user, and after the ' +
        'user confirms, call build_board with its spec_hash as confirm_hash.',
    );
  }

  // 6. Builds per process
  if (deps.state.buildsStarted >= LIMITS.buildsPerProcess) {
    return domainError(
      `This server process has already run ${LIMITS.buildsPerProcess} builds.`,
      'Ask the user to restart the MCP server if more boards are really wanted.',
    );
  }
  deps.state.buildsStarted++;

  return runBuild(input, board, plan, deps, transport, hooks, targetText, apiCalls);
}

async function runBuild(
  input: BuildInput,
  board: NormalizedBoard,
  plan: BuildPlan,
  deps: ServerDeps,
  transport: ReturnType<ServerDeps['createTransport']>,
  hooks: BuildHooks,
  targetText: string,
  apiCalls: number,
): Promise<CallToolResult> {
  const logger = collectingLogger(deps.logger);
  const miro = new MiroClient(transport, { logger });

  let boardId: string;
  let createdBoard = false;
  if ('new_board_name' in input.target) {
    try {
      const created = await miro.createBoard(input.target.new_board_name, {
        teamId: deps.config.teamId ?? null,
      });
      if (!created?.id) throw new Error('Miro returned no board id');
      boardId = created.id;
    } catch (error) {
      return miroError(error, 'Creating the board');
    }
    createdBoard = true;
    deps.state.createdBoards.add(boardId);
  } else {
    boardId = input.target.board_id;
  }

  const frames: FrameProtocolEntry[] = [];
  const total = plan.totals.frames;
  const builder = new BoardBuilder(miro, {
    logger,
    protocol: {
      record: (entry) => {
        frames.push(entry);
        hooks.onFrame?.(frames.length, total, entry.title);
      },
    },
  });

  const timeout = AbortSignal.timeout(deps.buildTimeoutMs);
  const signal = hooks.signal ? AbortSignal.any([hooks.signal, timeout]) : timeout;
  const result = await builder.build(boardId, board, { signal });

  const abortReason =
    result.aborted && timeout.aborted
      ? `stopped after the time limit of ${Math.round(deps.buildTimeoutMs / 60000)} minutes`
      : result.abortReason;
  const data = output({
    dry_run: false,
    target: targetText,
    board_id: boardId,
    board_url: boardUrl(boardId),
    created_board: createdBoard,
    spec_hash: plan.spec_hash,
    totals: {
      frames: result.framesCreated,
      elements: result.elementsCreated,
      connectors: result.connectorsCreated,
      api_calls: transport.stats?.requests ?? apiCalls,
    },
    estimated_seconds: plan.estimated_seconds,
    frames: frames.map((entry) => ({
      frame_id: entry.frameId,
      title: entry.title,
      miro_id: entry.miroId,
      elements: entry.elements,
      errors: entry.errors,
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
    })),
    failures: logger.errors,
    aborted: result.aborted,
    abort_reason: abortReason,
    retries: transport.stats?.retries ?? 0,
  });

  const summary =
    `${result.framesCreated} of ${total} frames, ${result.elementsCreated} elements and ` +
    `${result.connectorsCreated} connectors on ${boardUrl(boardId)}`;
  if (!result.aborted && result.errors === 0) {
    return success(`Built: ${summary}.\n${NOT_IDEMPOTENT}`, data);
  }

  const status = /HTTP (\d{3})/.exec(abortReason ?? '')?.[1];
  const hint = result.aborted
    ? status
      ? hintForStatus(Number(status))
      : `The build was stopped (${abortReason}). What exists is listed in frames. ${NOT_IDEMPOTENT}`
    : `${result.errors} items failed (see failures). Tell the user; do not rebuild the whole board. ${NOT_IDEMPOTENT}`;
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `${result.aborted ? 'Stopped early' : 'Built with errors'}: ${summary}.\nHint: ${hint}`,
      },
    ],
    structuredContent: { ...data, error: { message: abortReason ?? 'Some items failed', hint } },
  };
}

function output(
  fields: Partial<BuildOutput> & Pick<BuildOutput, 'dry_run' | 'target'>,
): BuildOutput {
  return {
    board_id: null,
    board_url: null,
    created_board: false,
    spec_hash: '',
    totals: { frames: 0, elements: 0, connectors: 0, api_calls: 0 },
    estimated_seconds: 0,
    planned_frames: null,
    frames: null,
    failures: [],
    aborted: false,
    abort_reason: null,
    retries: 0,
    note: NOT_IDEMPOTENT,
    ...fields,
  };
}

/** Sends one progress notification per frame if the client asked for progress. */
function progressReporter(ctx: ServerContext): BuildHooks['onFrame'] {
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return undefined;
  return (done, total, title) => {
    ctx.mcpReq
      .notify({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress: done,
          total,
          message: `Frame ${done}/${total}: ${title}`,
        },
      })
      .catch(() => {
        // Progress is a courtesy; a failed notification must not fail the build.
      });
  };
}

export function registerBuildBoard(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'build_board',
    {
      title: 'Build a Miro board',
      description:
        'Build a Miro board from a valid spec. With the default dry_run: true it only checks the ' +
        'spec, the target and the token, and writes nothing. To write, the user must first have ' +
        'seen preview_board and agreed; then call with dry_run: false and confirm_hash set to the ' +
        "preview's spec_hash. Writes to Miro and is not idempotent: a second call adds a second " +
        'copy. Never call it with dry_run: false without the user confirming.',
      inputSchema: buildInput,
      outputSchema: buildOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input, ctx) => {
      const onFrame = progressReporter(ctx);
      return buildBoard(input, deps, {
        signal: ctx.mcpReq.signal,
        ...(onFrame ? { onFrame } : {}),
      });
    },
  );
}
