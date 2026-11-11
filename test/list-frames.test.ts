import assert from 'node:assert/strict';
import test from 'node:test';
import { listFrames } from '../src/tools/listFrames.ts';
import { data, fakeMiro, testDeps, text } from './helpers.ts';

interface FramesData {
  count: number;
  truncated: boolean;
  frames: Array<{ id: string; title: string; x: number | null; width: number | null }>;
}

function frame(id: string, title: string) {
  return {
    id,
    type: 'frame',
    data: { title },
    position: { x: 10, y: 20 },
    geometry: { width: 800, height: 600 },
  };
}

test('lists frames across pages, titles and geometry only', async () => {
  const miro = fakeMiro((call) =>
    call.path.includes('cursor=')
      ? { status: 200, body: { data: [frame('f3', 'Three')], cursor: null } }
      : {
          status: 200,
          body: { data: [frame('f1', 'One'), frame('f2', 'Two')], cursor: 'next page' },
        },
  );
  const result = await listFrames('b1', testDeps({ miro, allowedBoardIds: ['b1'] }));
  assert.equal(result.isError, undefined);
  const out = data<FramesData>(result);
  assert.equal(out.count, 3);
  assert.equal(out.truncated, false);
  assert.deepEqual(
    out.frames.map((f) => f.title),
    ['One', 'Two', 'Three'],
  );
  assert.equal(out.frames[0]?.width, 800);
  assert.match(miro.calls[0]?.path ?? '', /\/boards\/b1\/items\?type=frame&limit=50$/);
  assert.match(miro.calls[1]?.path ?? '', /cursor=next%20page/);
});

test('stops after the page limit and says so', async () => {
  const miro = fakeMiro(() => ({ status: 200, body: { data: [frame('f', 'F')], cursor: 'more' } }));
  const out = data<FramesData>(await listFrames('b1', testDeps({ miro, allowedBoardIds: ['b1'] })));
  assert.equal(out.truncated, true);
  assert.equal(miro.calls.length, 10);
});

test('a board that is not allowed is not read', async () => {
  const miro = fakeMiro();
  const result = await listFrames('other', testDeps({ miro }));
  assert.equal(result.isError, true);
  assert.equal(miro.calls.length, 0);
});

test('Miro 404 becomes a tool error with a hint', async () => {
  const miro = fakeMiro(() => ({ status: 404, body: { message: 'Not found' } }));
  const result = await listFrames('b1', testDeps({ miro, allowedBoardIds: ['b1'] }));
  assert.equal(result.isError, true);
  assert.match(text(result), /does not exist or the token cannot see it/);
});
