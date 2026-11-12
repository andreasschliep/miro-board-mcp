import { HttpTransport, type Logger, type Transport } from 'miro-board-builder';
import { configFromEnv, type ServerConfig } from './config.ts';
import { LIMITS } from './limits.ts';
import { stderrLogger } from './logger.ts';

/** A Miro transport; the HTTP one also counts requests and retries. */
export type MiroTransport = Transport & { stats?: { requests: number; retries: number } };

/**
 * Everything the tools need from the outside world. Tests replace the transport
 * factory with one that talks to a mocked fetch, so no test touches Miro.
 */
export interface ServerDeps {
  config: ServerConfig;
  logger: Logger;
  createTransport: (token: string) => MiroTransport;
  /** Process-local state: boards created here, and how many builds ran. */
  state: { createdBoards: Set<string>; buildsStarted: number };
  buildTimeoutMs: number;
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): ServerDeps {
  return {
    config: configFromEnv(env),
    logger: stderrLogger(),
    createTransport: (token) => new HttpTransport({ accessToken: token }),
    state: { createdBoards: new Set(), buildsStarted: 0 },
    buildTimeoutMs: LIMITS.buildMs,
  };
}

/** Boards the server may touch: the allowlist plus boards it created itself. */
export function isBoardAllowed(deps: ServerDeps, boardId: string): boolean {
  return deps.config.allowedBoardIds.has(boardId) || deps.state.createdBoards.has(boardId);
}

/** Board ids only contain URL-safe characters (see boardIdInput); encode anything else. */
export function boardUrl(boardId: string): string {
  const id = /^[A-Za-z0-9_=-]+$/.test(boardId) ? boardId : encodeURIComponent(boardId);
  return `https://miro.com/app/board/${id}/`;
}
