/**
 * Dry run of a build: the real builder against the generator's DryRunTransport,
 * which records every Miro call and sends nothing. The preview therefore shows
 * exactly what build_board would do, not a second interpretation of the spec.
 */
import {
  BoardBuilder,
  DryRunTransport,
  MiroClient,
  type FrameProtocolEntry,
  type NormalizedBoard,
} from 'miro-board-builder';
import { estimateSeconds } from './limits.ts';
import { silentLogger } from './logger.ts';
import { specHash } from './spec.ts';

export interface PlannedFrame {
  order: number;
  id: string;
  title: string;
  phase?: string;
  elements: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BuildPlan {
  board_name: string;
  frames: PlannedFrame[];
  totals: { frames: number; elements: number; connectors: number; api_calls: number };
  estimated_seconds: number;
  spec_hash: string;
}

export async function planBuild(board: NormalizedBoard): Promise<BuildPlan> {
  const transport = new DryRunTransport();
  const entries: FrameProtocolEntry[] = [];
  const builder = new BoardBuilder(new MiroClient(transport, { logger: silentLogger }), {
    protocol: { record: (entry) => entries.push(entry) },
    logger: silentLogger,
  });
  const result = await builder.build('preview', board, { dryRun: true });

  const byId = new Map(board.frames.map((frame) => [frame.id, frame]));
  const frames = entries.map((entry, index) => {
    const frame = byId.get(entry.frameId);
    return {
      order: index + 1,
      id: entry.frameId,
      title: entry.title,
      ...(frame?.phase ? { phase: frame.phase } : {}),
      elements: entry.elements,
      x: frame?.x ?? 0,
      y: frame?.y ?? 0,
      width: frame?.width ?? 0,
      height: frame?.height ?? 0,
    };
  });

  return {
    board_name: board.name,
    frames,
    totals: {
      frames: result.framesCreated,
      elements: result.elementsCreated,
      connectors: result.connectorsCreated,
      api_calls: transport.calls.length,
    },
    estimated_seconds: estimateSeconds(transport.calls.length),
    spec_hash: specHash(board),
  };
}
