/**
 * Test doubles. No test talks to Miro: the generator's real HttpTransport runs
 * against a fake fetch, so throttling, retries and error mapping are exercised too.
 */
import { HttpTransport } from 'miro-board-builder';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ServerDeps } from '../src/deps.ts';
import { silentLogger } from '../src/logger.ts';

export interface FakeCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

export interface FakeReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Wait before answering (timeouts). */
  delayMs?: number;
}

/** Decide the reply per call; undefined means "201 with a new id". */
export type Responder = (call: FakeCall, index: number) => FakeReply | undefined;

export function fakeMiro(responder: Responder = () => undefined) {
  const calls: FakeCall[] = [];
  const sleeps: number[] = [];
  let nextId = 0;

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call: FakeCall = {
      method: init?.method ?? 'GET',
      path: String(url).replace('https://api.miro.com/v2', ''),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    const reply = responder(call, calls.length) ?? {
      status: 201,
      body: { id: `item-${++nextId}` },
    };
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    const body = reply.body === undefined ? null : JSON.stringify(reply.body);
    return new Response(body, { status: reply.status, headers: reply.headers ?? {} });
  }) as typeof fetch;

  const createTransport = (token: string) =>
    new HttpTransport({
      accessToken: token,
      fetchImpl,
      minIntervalMs: 0,
      backoffBaseMs: 1,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });

  /** Calls that write something. */
  const writes = () => calls.filter((c) => c.method !== 'GET');
  return { calls, sleeps, writes, createTransport };
}

export function testDeps(
  options: {
    token?: string | null;
    allowedBoardIds?: string[];
    allowedUrlHosts?: string[];
    miro?: ReturnType<typeof fakeMiro>;
    buildTimeoutMs?: number;
  } = {},
): ServerDeps {
  const miro = options.miro ?? fakeMiro();
  return {
    config: {
      token: options.token === null ? undefined : (options.token ?? 'test-token'),
      teamId: undefined,
      allowedBoardIds: new Set(options.allowedBoardIds ?? []),
      allowedUrlHosts: new Set(options.allowedUrlHosts ?? []),
    },
    logger: silentLogger,
    createTransport: miro.createTransport,
    state: { createdBoards: new Set(), buildsStarted: 0 },
    buildTimeoutMs: options.buildTimeoutMs ?? 60_000,
  };
}

export function text(result: CallToolResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

export function data<T = Record<string, unknown>>(result: CallToolResult): T {
  return result.structuredContent as T;
}

/** Three frames, one connector between frame b and c. */
export const VALID_SPEC = `
name: Test Board
frames:
  - id: a
    title: First
    elements:
      - { type: sticky, content: one }
  - id: b
    title: Second
    elements:
      - { type: shape, ref: left, content: L, width: 200, height: 100 }
  - id: c
    title: Third
    elements:
      - { type: shape, ref: right, content: R, width: 200, height: 100 }
      - { type: connector, from: left, to: right }
`;
