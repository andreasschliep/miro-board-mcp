import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { LIMITS } from '../src/limits.ts';
import { checkSpec, countNodes, specHash } from '../src/spec.ts';
import { previewBoard } from '../src/tools/preview.ts';
import { validateBoardSpec } from '../src/tools/validate.ts';
import { data, testDeps, text, VALID_SPEC } from './helpers.ts';

interface Report {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  warnings: unknown[];
  summary: { frames: number; spec_elements: number };
}

const deps = testDeps();

test('a valid spec is valid', () => {
  const result = validateBoardSpec(VALID_SPEC, deps);
  assert.equal(result.isError, undefined);
  const report = data<Report>(result);
  assert.equal(report.valid, true);
  assert.deepEqual(report.summary, { frames: 3, spec_elements: 4 });
  assert.match(text(result), /^Valid: 3 frames/);
});

test('the example served as a resource is valid', () => {
  const example = readFileSync(
    new URL('../examples/code-review-basics.yaml', import.meta.url),
    'utf8',
  );
  assert.equal(data<Report>(validateBoardSpec(example, deps)).valid, true);
});

test('missing required fields are reported with a path, not as a tool error', () => {
  const result = validateBoardSpec('frames:\n  - title: no id\n', deps);
  assert.equal(result.isError, undefined);
  const report = data<Report>(result);
  assert.equal(report.valid, false);
  assert.deepEqual(
    report.errors.map((e) => e.path),
    ['/', '/frames/0'],
  );
  assert.match(report.errors[0]?.message ?? '', /name/);
  assert.match(report.errors[1]?.message ?? '', /id/);
});

test('wrong types are reported', () => {
  const frames = data<Report>(validateBoardSpec('name: X\nframes: not-a-list\n', deps));
  assert.equal(frames.valid, false);
  assert.equal(frames.errors[0]?.path, '/frames');

  const width = data<Report>(
    validateBoardSpec('name: X\nframes:\n  - { id: a, title: A, width: wide }\n', deps),
  );
  assert.equal(width.valid, false);
  assert.equal(width.errors[0]?.path, '/frames/0/width');
});

test('semantic errors point to the frame', () => {
  const report = data<Report>(
    validateBoardSpec('name: X\nframes:\n  - { id: a, title: A, template: nope }\n', deps),
  );
  assert.equal(report.valid, false);
  assert.equal(report.errors[0]?.path, '/frames/0');
  assert.match(report.errors[0]?.message ?? '', /unknown template/);
});

test('an empty spec is a tool error with a hint', () => {
  const result = validateBoardSpec('   \n', deps);
  assert.equal(result.isError, true);
  assert.equal(data<{ code: string }>(result).code, 'empty');
  assert.match(text(result), /Hint:/);
});

test('a spec above the size limit is rejected before parsing', () => {
  const big = `name: X\nframes: []\n# ${'x'.repeat(LIMITS.specBytes)}\n`;
  const result = validateBoardSpec(big, deps);
  assert.equal(result.isError, true);
  assert.equal(data<{ code: string }>(result).code, 'too_large');
});

test('invalid YAML is a tool error', () => {
  const result = validateBoardSpec('name: [unclosed\n', deps);
  assert.equal(result.isError, true);
  assert.equal(data<{ code: string }>(result).code, 'yaml');
});

test('!include is refused without reading a file', () => {
  const result = validateBoardSpec(
    'name: X\nframes:\n  - id: a\n    title: A\n    elements:\n      - { type: text, content: !include .env }\n',
    deps,
  );
  assert.equal(result.isError, true);
  assert.equal(data<{ code: string }>(result).code, 'include');
});

test('an alias bomb is stopped by the node limit', () => {
  const levels = ['a: &a ["x","x","x","x","x","x","x","x","x","x"]'];
  for (let i = 1; i <= 6; i++) {
    const prev = String.fromCharCode(96 + i);
    const name = String.fromCharCode(97 + i);
    levels.push(`${name}: &${name} [${Array(10).fill(`*${prev}`).join(',')}]`);
  }
  const bomb = `name: X\nframes: []\n${levels.join('\n')}\n`;
  assert.ok(bomb.length < 2_000, 'the bomb itself is tiny');
  const result = validateBoardSpec(bomb, deps);
  assert.equal(result.isError, true);
  assert.equal(data<{ code: string }>(result).code, 'too_complex');
});

test('countNodes stops counting at the limit', () => {
  assert.equal(countNodes({ a: [1, 2] }, 100), 4);
  assert.equal(countNodes(Array(1000).fill(0), 10), 11);
});

test('a very large but valid structure hits the frame limit', () => {
  const frames = Array.from(
    { length: LIMITS.frames + 1 },
    (_, i) => `  - { id: f${i}, title: F${i} }`,
  );
  const report = data<Report>(validateBoardSpec(`name: X\nframes:\n${frames.join('\n')}\n`, deps));
  assert.equal(report.valid, false);
  assert.match(report.errors[0]?.message ?? '', /51 frames; the limit is 50/);
});

test('image URLs need an allowed https host', () => {
  const spec = (url: string) =>
    `name: X\nframes:\n  - id: a\n    title: A\n    elements:\n      - { type: image, url: "${url}" }\n`;
  const blocked = data<Report>(validateBoardSpec(spec('https://example.com/a.png'), deps));
  assert.equal(blocked.valid, false);
  assert.equal(blocked.errors[0]?.path, '/frames/0/elements/0/url');

  const insecure = data<Report>(validateBoardSpec(spec('http://example.com/a.png'), deps));
  assert.match(insecure.errors[0]?.message ?? '', /https/);

  const allowed = testDeps({ allowedUrlHosts: ['example.com'] });
  assert.equal(
    data<Report>(validateBoardSpec(spec('https://example.com/a.png'), allowed)).valid,
    true,
  );
});

test('the spec hash ignores key order and changes with the content', () => {
  const policy = { allowedUrlHosts: new Set<string>() };
  const hash = (spec: string) => specHash(checkSpec(spec, policy).board!);
  const a = hash('name: X\nframes:\n  - { id: a, title: A }\n');
  const b = hash('frames:\n  - { title: A, id: a }\nname: X\n');
  const c = hash('name: X\nframes:\n  - { id: a, title: B }\n');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test('preview lists frames in build order with totals and a hash', async () => {
  const result = await previewBoard(VALID_SPEC, deps);
  assert.equal(result.isError, undefined);
  const plan = data<{
    frames: Array<{ order: number; id: string; elements: number }>;
    totals: { frames: number; elements: number; connectors: number; api_calls: number };
    estimated_seconds: number;
    spec_hash: string;
  }>(result);
  // Every frame gets a header bar from the generator, so 1 element in the spec = 2 on the board.
  assert.deepEqual(
    plan.frames.map((f) => [f.order, f.id, f.elements]),
    [
      [1, 'a', 2],
      [2, 'b', 2],
      [3, 'c', 2],
    ],
  );
  // 3 frames + 6 elements + 1 connector = 10 calls, at 650 ms each about 7 s.
  assert.deepEqual(plan.totals, { frames: 3, elements: 6, connectors: 1, api_calls: 10 });
  assert.equal(plan.estimated_seconds, 7);
  assert.match(text(result), /confirm_hash/);
});

test('preview of an invalid spec is a tool error that carries the validation', async () => {
  const result = await previewBoard('name: X\nframes:\n  - title: no id\n', deps);
  assert.equal(result.isError, true);
  assert.equal(data<{ validation: Report }>(result).validation.valid, false);
});
