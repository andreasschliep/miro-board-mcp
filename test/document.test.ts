import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { ElementSpec } from 'miro-board-builder';
import { checkDocument } from '../src/document/check.ts';
import { composeDocument } from '../src/document/compose.ts';
import { flowchartDiagram } from '../src/document/flowchart.ts';
import { parseDocument } from '../src/document/markdown.ts';
import { wardleyDiagram } from '../src/document/wardley.ts';
import { layoutFindings } from '../src/layout.ts';
import { specHash } from '../src/spec.ts';
import { previewBoard } from '../src/tools/preview.ts';
import { validateBoard } from '../src/tools/validate.ts';
import { data, testDeps } from './helpers.ts';

const policy = { allowedUrlHosts: new Set<string>() };

const DOC = `# Retro board

Welcome to the **retro**.

## Check-in

How was the sprint? One word.

- Calm
- Busy
  - too many meetings
- Fun

## Flow

\`\`\`mermaid
flowchart LR
  a[Idea] --> b{Ready?}
  b -->|yes| c([Done])
  b -.->|no| a
\`\`\`

## Map

\`\`\`mermaid
wardley-beta
anchor User [0.95, 0.5]
component Answers [0.8, 0.5]
component Search [0.4, 0.7]
User -> Answers
Answers -> Search
evolve Search 0.9
\`\`\`
`;

test('one frame per "##", text before it becomes an overview frame', () => {
  const model = parseDocument(DOC);
  assert.equal(model.name, 'Retro board');
  assert.deepEqual(
    model.frames.map((f) => f.title),
    ['Retro board', 'Check-in', 'Flow', 'Map'],
  );
  assert.deepEqual(
    model.frames.map((f) => f.line),
    [3, 5, 14, 23],
  );
  assert.deepEqual(model.errors, []);
});

test('paragraphs become text, list items become sticky notes with nested items inside', () => {
  const frame = parseDocument(DOC).frames[1]!;
  assert.equal(frame.blocks[0]?.kind, 'text');
  const stickies = frame.blocks[1];
  assert.equal(stickies?.kind, 'stickies');
  assert.deepEqual(stickies?.kind === 'stickies' ? stickies.items : [], [
    'Calm',
    'Busy<br>• too many meetings',
    'Fun',
  ]);
});

test('bold text is kept, HTML in the text is escaped', () => {
  const model = parseDocument('# B\n\n## F\n\nA **bold** <script>x</script> & more\n');
  const block = model.frames[0]?.blocks[0];
  assert.equal(block?.kind, 'text');
  assert.match(block?.kind === 'text' ? block.html : '', /<strong>bold<\/strong>/);
  assert.doesNotMatch(block?.kind === 'text' ? block.html : '', /<script>/);
});

test('tables, images and other code are reported with their line, not drawn', () => {
  const model = parseDocument(
    '# B\n\n## F\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![x](https://example.com/x.png)\n\n```js\nlet a;\n```\n',
  );
  assert.deepEqual(
    model.warnings.map((w) => [w.line, w.message.split(' ')[0]]),
    [
      [5, 'table'],
      [9, 'image'],
      [11, 'code'],
    ],
  );
});

test('a document without content is an error, one without a title a warning', () => {
  assert.match(parseDocument('just a line').warnings[0]?.message ?? '', /no "# Title"/);
  assert.match(parseDocument('# Only a title\n').errors[0]?.message ?? '', /no content/);
});

test('a Wardley map: dots, labels, dependencies and an evolution arrow', async () => {
  const code =
    'wardley-beta\nanchor User [0.95, 0.5]\ncomponent Search [0.4, 0.7]\nUser -> Search\nevolve Search 0.9\n';
  const map = await wardleyDiagram(code, 10, 'm');
  assert.deepEqual(map.errors, []);
  const connectors = map.elements.filter((e) => e.type === 'connector');
  assert.equal(connectors.length, 2);
  const evolve = connectors.find((c) => c.strokeStyle === 'dashed');
  assert.equal(evolve?.color, '#E03131');
  const labels = map.elements.filter((e) => e.type === 'text').map((e) => e.content);
  assert.ok(labels.includes('Search'));
  assert.ok(labels.includes('Genesis') && labels.includes('Commodity'));
});

test("a pipeline is a box on its parent's line, with the parent on top", async () => {
  const code =
    'wardley-beta\ncomponent Teams [0.5, 0.5]\npipeline Teams {\n  component Alpha [0.2]\n  component Beta [0.8]\n}\nAlpha -> Teams\n';
  const map = await wardleyDiagram(code, 1, 'p');
  assert.deepEqual(map.errors, []);
  const dots = map.elements.filter((e) => e.shape === 'circle');
  const y = (name: string) => {
    const index = map.elements.findIndex((e) => e.type === 'text' && e.content === name);
    return map.elements[index - 1]?.y as number;
  };
  const box = map.elements.find(
    (e) => e.type === 'shape' && e.shape === 'rectangle' && e.height === 44,
  );
  assert.ok(box, 'pipeline box');
  assert.equal(dots.length, 3);
  assert.ok(y('Teams') < (box.y as number) - 22, 'parent sits on top of the box');
  // The link from a part to its own parent is not drawn; the parts are joined instead.
  const connectors = map.elements.filter((e) => e.type === 'connector');
  assert.equal(connectors.length, 1);
});

test('Wardley parse errors and unknown names point to the document line', async () => {
  const broken = await wardleyDiagram(
    'wardley-beta\ncomponent A [0.5, 0.5]\ncomponent B [x]\n',
    20,
    'e',
  );
  assert.equal(broken.errors[0]?.line, 22);
  const unknown = await wardleyDiagram(
    'wardley-beta\ncomponent A [0.5, 0.5]\nA -> Nobody\n',
    20,
    'e',
  );
  assert.equal(unknown.errors[0]?.line, 22);
  assert.match(unknown.errors[0]?.message ?? '', /"Nobody" is not declared/);
});

test('Wardley colours come from the front matter of the block', async () => {
  const code =
    '---\nconfig:\n  themeVariables:\n    wardley:\n      componentStroke: "#5F3DC4"\n---\nwardley-beta\ncomponent A [0.5, 0.5]\n';
  const map = await wardleyDiagram(code, 1, 'c');
  assert.equal(map.elements.find((e) => e.shape === 'circle')?.borderColor, '#5F3DC4');
});

test('a flowchart: shapes, labels, dotted edges and colours from classDef', async () => {
  const code =
    'flowchart TD\n  a[Idea] --> b{Ready?}\n  b -->|yes| c([Done])\n  b -.->|no| a\n  classDef ok fill:#d3f9d8,stroke:#2b8a3e\n  class c ok\n';
  const chart = await flowchartDiagram(code, 1, 'f');
  assert.deepEqual(chart.errors, []);
  const shapes = chart.elements.filter((e) => e.type === 'shape');
  assert.deepEqual(
    shapes.map((s) => s.shape),
    ['rectangle', 'rhombus', 'round_rectangle'],
  );
  assert.equal(shapes[2]?.color, '#D3F9D8');
  const edges = chart.elements.filter((e) => e.type === 'connector');
  assert.equal(edges.length, 3);
  assert.equal(edges[1]?.caption, 'yes');
  assert.equal(edges[2]?.strokeStyle, 'dotted');
  // Top-down: each rank lies below the previous one.
  assert.ok((shapes[0]?.y as number) < (shapes[1]?.y as number));
  assert.ok((shapes[1]?.y as number) < (shapes[2]?.y as number));
});

test('a subgraph becomes a titled box drawn before its nodes', async () => {
  const chart = await flowchartDiagram(
    'flowchart LR\n  subgraph team [Team]\n    a --> b\n  end\n  b --> c\n',
    1,
    's',
  );
  assert.deepEqual(chart.errors, []);
  const boxIndex = chart.elements.findIndex((e) => e.ref === 's-f-team');
  const nodeIndex = chart.elements.findIndex((e) => e.ref === 's-f-a');
  assert.ok(boxIndex >= 0 && boxIndex < nodeIndex);
  assert.ok(chart.elements.some((e) => e.type === 'text' && /Team/.test(String(e.content))));
});

test('flowchart parse errors point to the document line', async () => {
  const chart = await flowchartDiagram('flowchart TD\n  a --> b\n  b --> \n', 30, 'x');
  assert.equal(chart.errors.length, 1);
  assert.ok((chart.errors[0]?.line ?? 0) >= 30);
});

test('unsupported Mermaid diagrams are an error with the line of the block', async () => {
  const checked = await checkDocument(
    '# B\n\n## F\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n',
    policy,
  );
  assert.equal(checked.report.valid, false);
  assert.equal(checked.report.errors[0]?.line, 5);
  assert.match(checked.report.errors[0]?.message ?? '', /not supported/);
});

test('the server places frames side by side and every element inside its frame', async () => {
  const composed = await composeDocument(DOC);
  const frames = composed.raw.frames as Array<{
    x: number;
    width: number;
    elements: ElementSpec[];
  }>;
  for (let i = 1; i < frames.length; i++) {
    const gap = frames[i]!.x - frames[i]!.width / 2 - (frames[i - 1]!.x + frames[i - 1]!.width / 2);
    assert.equal(gap, 300);
  }
  const checked = await checkDocument(DOC, policy);
  assert.equal(checked.report.valid, true, JSON.stringify(checked.report.errors));
  assert.deepEqual(layoutFindings(checked.board!), []);
});

test('findings carry Markdown lines, and the same document always gives the same hash', async () => {
  const first = await checkDocument(DOC, policy);
  const second = await checkDocument(DOC, policy);
  assert.equal(specHash(first.board!), specHash(second.board!));
  const changed = await checkDocument(DOC.replace('Calm', 'Quiet'), policy);
  assert.notEqual(specHash(first.board!), specHash(changed.board!));

  const unknown = await checkDocument('# B\n\n## Map\n\n```\nwardley-beta\nA -> B\n```\n', policy);
  assert.equal(unknown.report.valid, false);
  assert.deepEqual(
    unknown.report.errors.map((e) => e.path),
    ['line 7'],
  );
});

test('validate_board and preview_board take the document; the preview shows where frames go', async () => {
  const deps = testDeps();
  const report = data<{ valid: boolean }>(await validateBoard({ document: DOC }, deps));
  assert.equal(report.valid, true);
  const preview = data<{ frames: Array<{ x: number; width: number; height: number }> }>(
    await previewBoard({ document: DOC }, deps),
  );
  assert.equal(preview.frames.length, 4);
  assert.ok(preview.frames.every((f) => f.width >= 1600 && f.height >= 900));
});

test('document and spec together are refused', async () => {
  const result = await validateBoard({ document: DOC, spec: 'name: X' }, testDeps());
  assert.equal(result.isError, true);
});

test('the example document is valid and has no warnings of any kind', async () => {
  const example = readFileSync(
    new URL('../examples/code-review-basics.md', import.meta.url),
    'utf8',
  );
  const { report } = await checkDocument(example, policy);
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  assert.deepEqual([report.warnings, report.text_fit, report.layout], [[], [], []]);
});

test('the Wardley example in the guide is valid', async () => {
  const guide = readFileSync(
    new URL('../resources/board-document-guide.md', import.meta.url),
    'utf8',
  );
  const block = /```text\n(wardley-beta[\s\S]*?)```/.exec(guide)?.[1] ?? '';
  const map = await wardleyDiagram(block, 1, 'g');
  assert.deepEqual(map.errors, []);
});
