import assert from 'node:assert/strict';
import test from 'node:test';
import { BoardParser } from 'miro-board-builder';
import { layoutFindings } from '../src/layout.ts';
import { validateBoardSpec } from '../src/tools/validate.ts';
import { data, testDeps } from './helpers.ts';

function board(elements: string, frameExtra = '', style = '') {
  const yaml =
    `name: Layout\n${style}frames:\n  - id: map\n    title: Map\n    width: 1600\n    height: 1000\n${frameExtra}` +
    `    elements:\n${elements}`;
  return new BoardParser({ allowInclude: false }).normalize(
    new BoardParser({ allowInclude: false }).loadString(yaml),
  );
}

test('axes written with absolute end points are reported, with the reason', () => {
  // The lines from the first end-to-end run: toX/toY were meant as absolute end points.
  const findings = layoutFindings(
    board(
      '      - { type: line, x: -650, y: 400, toX: -650, toY: -360 }\n' +
        '      - { type: line, x: -650, y: 400, toX: 700, toY: 400 }\n',
    ),
  );
  assert.equal(findings.length, 2);
  assert.match(findings[0]?.message ?? '', /\(-650, 400\) to \(-1300, 40\)/);
  assert.match(findings[0]?.message ?? '', /toX and toY are distances from x and y/);
  assert.equal(findings[1]?.path, '/frames/0/elements/1');
});

test('the same axes written as distances are fine', () => {
  const findings = layoutFindings(
    board(
      '      - { type: line, x: -650, y: 400, toX: 0, toY: -760 }\n' +
        '      - { type: line, x: -650, y: 400, toX: 1350, toY: 0 }\n',
    ),
  );
  assert.deepEqual(findings, []);
});

test('an element that sticks out of the frame is reported with the overhang', () => {
  const findings = layoutFindings(
    board('      - { type: shape, x: 750, y: 0, width: 200, height: 100 }\n'),
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? '', /shape extends 50 units beyond the frame edge/);
});

test('an element on the title bar is reported, unless the frame has none', () => {
  const onBar = '      - { type: text, content: Label, x: 0, y: -470 }\n';
  assert.match(layoutFindings(board(onBar))[0]?.message ?? '', /overlaps the title bar/);
  assert.deepEqual(layoutFindings(board(onBar, '    headerBar: false\n')), []);
  assert.deepEqual(layoutFindings(board(onBar, '', 'style: { headerBar: false }\n')), []);
});

test('group items are checked at their real position', () => {
  const findings = layoutFindings(
    board(
      '      - type: group\n        x: 700\n        y: 0\n        items:\n' +
        '          - { type: shape, x: 50, y: 0, width: 200, height: 100 }\n',
    ),
  );
  assert.equal(findings[0]?.path, '/frames/0/elements/0/items/0');
  assert.match(findings[0]?.message ?? '', /extends 50 units/);
});

function frames(yaml: string) {
  const parser = new BoardParser({ allowInclude: false });
  return parser.normalize(parser.loadString(`name: Frames\n${yaml}`));
}

test('frames placed with spacing read as a gap overlap, and the message says why', () => {
  // The layout from the second end-to-end run: 300 was meant as the gap between frames.
  const findings = layoutFindings(
    frames(
      'layout: { frameSpacing: 300, rowSpacing: 300, defaultFrameWidth: 3000, defaultFrameHeight: 1800 }\n' +
        'frames:\n' +
        '  - { id: a, title: A, row: 0, col: 0 }\n' +
        '  - { id: b, title: B, row: 0, col: 1 }\n' +
        '  - { id: c, title: C, row: 1, col: 0 }\n' +
        '  - { id: d, title: D, row: 1, col: 1 }\n',
    ),
  );
  assert.equal(findings.length, 6);
  assert.equal(findings[0]?.frame_id, 'b');
  assert.equal(findings[0]?.path, '/frames/1');
  assert.match(findings[0]?.message ?? '', /overlaps frame "a" by 2700 x 1800 units/);
  assert.match(findings[0]?.message ?? '', /distances between frame centres, not gaps/);
  assert.match(findings[0]?.message ?? '', /frameSpacing 3200 and rowSpacing 2000/);
});

test('frames on the default layout, or exactly touching, do not overlap', () => {
  const defaults = frames('frames:\n  - { id: a, title: A }\n  - { id: b, title: B }\n');
  assert.deepEqual(layoutFindings(defaults), []);
  const touching = frames(
    'layout: { frameSpacing: 1600 }\nframes:\n  - { id: a, title: A }\n  - { id: b, title: B }\n',
  );
  assert.deepEqual(layoutFindings(touching), []);
});

test('frames with their own x and y are checked too', () => {
  const findings = layoutFindings(
    frames(
      'frames:\n  - { id: a, title: A, x: 0, y: 0 }\n' +
        '  - { id: b, title: B, x: 1000, y: 500, width: 800, height: 600 }\n',
    ),
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? '', /overlaps frame "a" by 200 x 300 units/);
});

test('layout warnings do not make a spec invalid but are part of the report', () => {
  const spec =
    'name: X\nframes:\n  - id: a\n    title: A\n    elements:\n' +
    '      - { type: line, x: 0, y: 0, toX: 2000, toY: 0 }\n';
  const result = validateBoardSpec(spec, testDeps());
  const report = data<{ valid: boolean; layout: Array<{ frame_id: string }> }>(result);
  assert.equal(report.valid, true);
  assert.equal(report.layout.length, 1);
  assert.equal(report.layout[0]?.frame_id, 'a');
});
