import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS } from '../src/limits.ts';
import { previewBoard } from '../src/tools/preview.ts';
import { buildBoard, type BuildInput } from '../src/tools/build.ts';
import { data, fakeMiro, testDeps, text, VALID_SPEC } from './helpers.ts';

interface BuildData {
  dry_run: boolean;
  board_id: string | null;
  board_url: string | null;
  created_board: boolean;
  totals: { frames: number; elements: number; connectors: number; api_calls: number };
  frames: Array<{ frame_id: string; status: string; miro_id: string | null }> | null;
  aborted: boolean;
  abort_reason: string | null;
  retries: number;
  error?: { message: string; hint: string };
}

async function hashOf(spec: string): Promise<string> {
  const preview = await previewBoard(spec, testDeps());
  return data<{ spec_hash: string }>(preview).spec_hash;
}

function newBoard(extra: Partial<BuildInput> = {}): BuildInput {
  return { spec: VALID_SPEC, target: { new_board_name: 'Test' }, dry_run: true, ...extra };
}

test('dry run is the default and writes nothing', async () => {
  const miro = fakeMiro();
  const result = await buildBoard(newBoard(), testDeps({ miro }));
  assert.equal(result.isError, undefined);
  assert.equal(data<BuildData>(result).dry_run, true);
  assert.equal(miro.calls.length, 0);
  assert.match(text(result), /Nothing was written/);
});

test('dry run on an allowed existing board reads it once and writes nothing', async () => {
  const miro = fakeMiro((call) =>
    call.method === 'GET' ? { status: 200, body: { id: 'b1' } } : undefined,
  );
  const result = await buildBoard(
    { ...newBoard(), target: { board_id: 'b1' } },
    testDeps({ miro, allowedBoardIds: ['b1'] }),
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    miro.calls.map((c) => `${c.method} ${c.path}`),
    ['GET /boards/b1'],
  );
});

test('a missing or wrong confirm hash writes nothing', async () => {
  const miro = fakeMiro();
  const deps = testDeps({ miro });
  const missing = await buildBoard(newBoard({ dry_run: false }), deps);
  assert.equal(missing.isError, true);
  assert.match(text(missing), /confirm_hash is missing/);

  const wrong = await buildBoard(newBoard({ dry_run: false, confirm_hash: 'sha256:00' }), deps);
  assert.equal(wrong.isError, true);
  assert.match(text(wrong), /spec changed after the preview/);
  assert.equal(miro.calls.length, 0);
  assert.equal(deps.state.buildsStarted, 0);
});

test('a confirmed build creates the board and all frames', async () => {
  const miro = fakeMiro();
  const deps = testDeps({ miro });
  const result = await buildBoard(
    newBoard({ dry_run: false, confirm_hash: await hashOf(VALID_SPEC) }),
    deps,
  );
  assert.equal(result.isError, undefined, text(result));
  const out = data<BuildData>(result);
  assert.equal(out.created_board, true);
  assert.equal(out.board_id, 'item-1');
  assert.equal(out.board_url, 'https://miro.com/app/board/item-1/');
  assert.deepEqual(out.totals, { frames: 3, elements: 6, connectors: 1, api_calls: 11 });
  assert.deepEqual(
    out.frames?.map((f) => f.status),
    ['created', 'created', 'created'],
  );
  assert.equal(miro.calls[0]?.path, '/boards');
  assert.ok(deps.state.createdBoards.has('item-1'));
  assert.match(text(result), /not idempotent/);
});

test('HTTP 401 stops the build at once with a hint about the token', async () => {
  const miro = fakeMiro((call) =>
    call.path.endsWith('/frames') ? { status: 401, body: {} } : undefined,
  );
  const result = await buildBoard(
    newBoard({ dry_run: false, confirm_hash: await hashOf(VALID_SPEC) }),
    testDeps({ miro }),
  );
  assert.equal(result.isError, true);
  const out = data<BuildData>(result);
  assert.equal(out.aborted, true);
  assert.match(out.abort_reason ?? '', /HTTP 401/);
  assert.match(out.error?.hint ?? '', /token/);
  // One board, one frame attempt, nothing after it: 401 is not retried frame by frame.
  assert.equal(miro.calls.filter((c) => c.path.endsWith('/frames')).length, 1);
  assert.deepEqual(
    out.frames?.map((f) => f.status),
    ['failed'],
  );
});

test('HTTP 429 is retried after Retry-After and the build succeeds', async () => {
  let throttled = false;
  const miro = fakeMiro((call) => {
    if (!throttled && call.path.endsWith('/frames')) {
      throttled = true;
      return { status: 429, headers: { 'Retry-After': '2' } };
    }
    return undefined;
  });
  const result = await buildBoard(
    newBoard({ dry_run: false, confirm_hash: await hashOf(VALID_SPEC) }),
    testDeps({ miro }),
  );
  assert.equal(result.isError, undefined, text(result));
  assert.equal(data<BuildData>(result).retries, 1);
  assert.ok(miro.sleeps.includes(2000), 'waited the 2 s Miro asked for');
});

test('a fatal error halfway keeps what exists and reports it', async () => {
  let frames = 0;
  const miro = fakeMiro((call) =>
    call.path.endsWith('/frames') && ++frames === 2 ? { status: 404, body: {} } : undefined,
  );
  const result = await buildBoard(
    newBoard({ dry_run: false, confirm_hash: await hashOf(VALID_SPEC) }),
    testDeps({ miro }),
  );
  assert.equal(result.isError, true);
  const out = data<BuildData>(result);
  assert.equal(out.aborted, true);
  assert.deepEqual(
    out.frames?.map((f) => [f.frame_id, f.status]),
    [
      ['a', 'created'],
      ['b', 'failed'],
    ],
  );
  assert.equal(out.totals.frames, 1);
  assert.match(text(result), /1 of 3 frames/);
});

test('cancellation by the client stops between frames', async () => {
  const controller = new AbortController();
  const result = await buildBoard(
    newBoard({ dry_run: false, confirm_hash: await hashOf(VALID_SPEC) }),
    testDeps(),
    {
      signal: controller.signal,
      onFrame: (done) => {
        if (done === 1) controller.abort(new Error('user pressed stop'));
      },
    },
  );
  assert.equal(result.isError, true);
  const out = data<BuildData>(result);
  assert.equal(out.aborted, true);
  assert.equal(out.abort_reason, 'cancelled: user pressed stop');
  assert.equal(out.totals.frames, 1);
  assert.equal(out.totals.connectors, 0);
});

test('the wall-clock limit stops a slow build', async () => {
  const miro = fakeMiro((call) =>
    call.path.endsWith('/frames') ? { status: 201, body: { id: 'f' }, delayMs: 30 } : undefined,
  );
  const result = await buildBoard(
    newBoard({ dry_run: false, confirm_hash: await hashOf(VALID_SPEC) }),
    testDeps({ miro, buildTimeoutMs: 10 }),
  );
  assert.equal(result.isError, true);
  assert.match(data<BuildData>(result).abort_reason ?? '', /time limit/);
});

test('progress is reported once per frame', async () => {
  const seen: string[] = [];
  await buildBoard(
    newBoard({ dry_run: false, confirm_hash: await hashOf(VALID_SPEC) }),
    testDeps(),
    {
      onFrame: (done, total, title) => seen.push(`${done}/${total} ${title}`),
    },
  );
  assert.deepEqual(seen, ['1/3 First', '2/3 Second', '3/3 Third']);
});

test('an existing board must be allowlisted or created by this server', async () => {
  const miro = fakeMiro();
  const deps = testDeps({ miro });
  const result = await buildBoard(
    { ...newBoard(), target: { board_id: 'someone-elses-board' } },
    deps,
  );
  assert.equal(result.isError, true);
  assert.match(text(result), /not allowed/);
  assert.equal(miro.calls.length, 0);

  deps.state.createdBoards.add('mine');
  const own = await buildBoard({ ...newBoard(), target: { board_id: 'mine' } }, deps);
  assert.equal(own.isError, undefined);
});

test('without a token nothing is attempted', async () => {
  const result = await buildBoard(newBoard(), testDeps({ token: null }));
  assert.equal(result.isError, true);
  assert.match(text(result), /MIRO_ACCESS_TOKEN is not set/);
});

test('the number of builds per process is limited', async () => {
  const deps = testDeps();
  deps.state.buildsStarted = LIMITS.buildsPerProcess;
  const result = await buildBoard(
    newBoard({ dry_run: false, confirm_hash: await hashOf(VALID_SPEC) }),
    deps,
  );
  assert.equal(result.isError, true);
  assert.match(text(result), /already run 10 builds/);
});

test('an invalid spec is refused before any Miro call', async () => {
  const miro = fakeMiro();
  const result = await buildBoard(
    {
      ...newBoard({ dry_run: false, confirm_hash: 'x' }),
      spec: 'name: X\nframes:\n  - title: t\n',
    },
    testDeps({ miro }),
  );
  assert.equal(result.isError, true);
  assert.equal(miro.calls.length, 0);
});

test('the token never appears in a result', async () => {
  const token = 'secret-token-value-123';
  const miro = fakeMiro(() => ({ status: 401, body: { message: 'Unauthorized' } }));
  const deps = testDeps({ miro, token });
  const result = await buildBoard(
    newBoard({ dry_run: false, confirm_hash: await hashOf(VALID_SPEC) }),
    deps,
  );
  assert.ok(!JSON.stringify(result).includes(token));
});
