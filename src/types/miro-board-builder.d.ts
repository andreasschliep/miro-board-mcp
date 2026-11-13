/**
 * Typed boundary to miro-board-builder (JavaScript, CommonJS).
 *
 * Declares only the part of the generator this server uses (design decision D12).
 * If the generator ships its own types one day, delete this file.
 */
declare module 'miro-board-builder' {
  export interface Logger {
    log(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  }

  /** YAML as loaded, before defaults are applied. */
  export type RawBoard = Record<string, unknown>;

  export interface ElementSpec {
    type: string;
    ref?: string;
    url?: string;
    content?: string;
    items?: ElementSpec[];
    [key: string]: unknown;
  }

  export interface FrameSpec {
    id: string;
    title: string;
    phase?: string;
    template?: string;
    elements?: ElementSpec[];
    x: number;
    y: number;
    width: number;
    height: number;
    [key: string]: unknown;
  }

  /** Board after BoardParser.normalize: defaults applied, repeats expanded. */
  export interface NormalizedBoard {
    name: string;
    frames: FrameSpec[];
    phases: Record<string, unknown>;
    [key: string]: unknown;
  }

  export class BoardParser {
    constructor(options?: { basePath?: string; allowInclude?: boolean });
    loadString(content: string): RawBoard;
    normalize(raw: RawBoard): NormalizedBoard;
  }

  export interface TextFitIssue {
    frameId: string;
    index: number;
    text: string;
    width: number;
    height: number;
    fontSize: number;
    requiredHeight: number;
    deficit: number;
  }

  export interface ValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
    textFit: TextFitIssue[];
  }

  export function validateBoard(raw: RawBoard, board: NormalizedBoard): ValidationResult;

  /** Height a text needs at a given width, with the same heuristic as the text-fit check. */
  export function estimateRequiredHeight(
    html: string,
    options: { fontSize?: number; width: number },
  ): number;

  export interface Transport {
    request(method: string, path: string, body?: unknown): Promise<unknown>;
  }

  export interface PlannedCall {
    seq: number;
    method: string;
    path: string;
    body?: unknown;
  }

  export class DryRunTransport implements Transport {
    calls: PlannedCall[];
    request(method: string, path: string, body?: unknown): Promise<unknown>;
  }

  export interface HttpTransportOptions {
    accessToken: string;
    baseUrl?: string;
    timeoutMs?: number;
    minIntervalMs?: number;
    maxRetries?: number;
    backoffBaseMs?: number;
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
    now?: () => number;
  }

  export class HttpTransport implements Transport {
    constructor(options: HttpTransportOptions);
    stats: { requests: number; retries: number };
    request(method: string, path: string, body?: unknown): Promise<unknown>;
  }

  export class MiroApiError extends Error {
    status: number | null;
    body: string | null;
    method: string | null;
    path: string | null;
  }

  export class MiroClient {
    constructor(transport: Transport, options?: { logger?: Logger });
    createBoard(
      name: string,
      options?: { teamId?: string | null; description?: string },
    ): Promise<{ id: string } | null>;
  }

  export const MAX_BOARD_NAME_LENGTH: number;

  export interface FrameProtocolEntry {
    boardId: string;
    frameId: string;
    title: string;
    dryRun: boolean;
    miroId: string | null;
    elements: number;
    errors: number;
    status: 'created' | 'partial' | 'failed';
    error?: string;
  }

  /** Anything with record() can receive the frame protocol. */
  export interface ProtocolSink {
    record(entry: FrameProtocolEntry): unknown;
  }

  export interface BuildResult {
    framesCreated: number;
    elementsCreated: number;
    connectorsCreated: number;
    errors: number;
    aborted: boolean;
    abortReason: string | null;
  }

  export class BoardBuilder {
    constructor(
      miro: MiroClient,
      options?: { protocol?: ProtocolSink | null; logger?: Logger; settleAfterClearMs?: number },
    );
    build(
      boardId: string,
      board: NormalizedBoard,
      options?: { dryRun?: boolean; signal?: AbortSignal },
    ): Promise<BuildResult>;
  }

  export const FATAL_STATUSES: Set<number>;
}
