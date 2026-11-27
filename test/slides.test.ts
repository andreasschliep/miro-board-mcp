/**
 * `theme: slides` (design D19 ff.): the slide style of the focus-topic webinars.
 *
 * The expected numbers are the values measured on the reference board, written out
 * here on purpose instead of read from the theme object, so a changed theme value
 * shows up as a failing test.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ElementSpec } from 'miro-board-builder';
import { configFromEnv } from '../src/config.ts';
import { checkDocument } from '../src/document/check.ts';
import { composeDocument } from '../src/document/compose.ts';
import type { SlideLogos } from '../src/document/theme.ts';
import { checkSpec } from '../src/spec.ts';
import { previewBoard } from '../src/tools/preview.ts';
import { validateBoard } from '../src/tools/validate.ts';
import { data, testDeps, text } from './helpers.ts';

function logoFiles(): SlideLogos {
  const dir = mkdtempSync(join(tmpdir(), 'slide-logos-'));
  const left = join(dir, 'left.svg');
  const right = join(dir, 'right.svg');
  writeFileSync(left, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"></svg>');
  writeFileSync(right, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"></svg>');
  return {
    left: { env: 'MIRO_SLIDE_LOGO_LEFT', kind: 'file', value: left },
    right: { env: 'MIRO_SLIDE_LOGO_RIGHT', kind: 'file', value: right },
  };
}

const LOGOS = logoFiles();
const policy = { allowedUrlHosts: new Set<string>(), slideLogos: LOGOS };

const DOC = `---
theme: slides
title: Clear code reviews
kicker: FOCUS TOPIC
subtitle: What makes feedback helpful
tagline: A fictional one-hour session
byline: 1 January 2030, Example Team
---

## Why reviews matter

Reviews spread knowledge across the team.

- Readers find bugs the author misses
- Names get better

- [ ] Your sticky: one review that helped you

## A statement

> Code is read far more often than it is written.

## Flow

\`\`\`mermaid
flowchart LR
  a[Open] -->|ready| b{Review}
  b --> c([Merge])
  classDef done fill:#d3f9d8,stroke:#2b8a3e,color:#212529
  class c done
\`\`\`
`;

type Frame = {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor?: string;
  elements: ElementSpec[];
};

async function frames(markdown = DOC, logos: SlideLogos = LOGOS) {
  const composed = await composeDocument(markdown, { slideLogos: logos });
  return { composed, frames: composed.raw.frames as Frame[] };
}

const texts = (frame: Frame) => frame.elements.filter((e) => e.type === 'text');
const plain = (html: unknown) => String(html).replace(/<[^>]*>/g, '');

test('slides: fixed 6078 x 4332 frames in a row, 800 apart, no title bar', async () => {
  const { composed, frames: list } = await frames();
  assert.deepEqual(composed.raw.style, { headerBar: false });
  assert.equal(list.length, 4);
  for (const frame of list) {
    assert.equal(frame.width, 6078);
    assert.equal(frame.height, 4332);
  }
  assert.equal(list[0]!.fillColor, '#ffffff');
  for (const frame of list.slice(1)) assert.equal(frame.fillColor, '#010101');
  for (const [i, frame] of list.entries()) {
    if (i > 0) assert.equal(frame.x - list[i - 1]!.x, 6078 + 800);
    assert.equal(frame.y, list[0]!.y);
  }
});

test('slides: the title slide comes first, built from the front matter as measured', async () => {
  const { composed, frames: list } = await frames();
  const title = list[0]!;
  assert.equal(composed.raw.name, 'Clear code reviews');
  assert.equal(title.title, 'Clear code reviews');
  const byText = (needle: string) => texts(title).find((e) => plain(e.content) === needle)!;
  const expect = (needle: string, color: string, fontSize: number, width: number, y: number) => {
    const element = byText(needle);
    assert.ok(element, needle);
    assert.deepEqual(
      [element.textColor, element.fontSize, element.width, element.x, element.y],
      [color, fontSize, width, 0, y],
      needle,
    );
    assert.equal(element.textAlign, 'center');
    assert.equal(element.fontFamily, 'open_sans');
  };
  // As on the reference: kicker and title bold, tagline italic.
  assert.equal(byText('FOCUS TOPIC').content, '<p><strong>FOCUS TOPIC</strong></p>');
  assert.equal(byText('Clear code reviews').content, '<p><strong>Clear code reviews</strong></p>');
  assert.equal(
    byText('A fictional one-hour session').content,
    '<p><em>A fictional one-hour session</em></p>',
  );
  assert.equal(byText('What makes feedback helpful').content, '<p>What makes feedback helpful</p>');
  expect('FOCUS TOPIC', '#EA8125', 130, 3000, -1266);
  expect('Clear code reviews', '#1A1A1A', 300, 5600, -566);
  expect('What makes feedback helpful', '#333333', 240, 5600, 284);
  expect('A fictional one-hour session', '#555555', 170, 5600, 684);
  expect('1 January 2030, Example Team', '#555555', 150, 5600, 1634);
  const bar = title.elements.find((e) => e.type === 'shape')!;
  assert.deepEqual([bar.color, bar.width, bar.height, bar.x, bar.y], ['#EA8125', 1400, 36, 0, -86]);
  assert.equal(
    title.elements.some((e) => e.type === 'image'),
    false,
    'no logos on the title slide',
  );
});

test('slides: heading top left in light violet, white body text, both Arial', async () => {
  const { frames: list } = await frames();
  const slide = list[1]!;
  const [heading, body] = texts(slide);
  assert.equal(heading!.content, '<p><strong>Why reviews matter</strong></p>');
  assert.equal(heading!.textColor, '#BC7AF5');
  assert.equal(heading!.fontSize, 190);
  assert.equal(heading!.textAlign, 'left');
  assert.equal(heading!.fontFamily, 'arial');
  // Left edge on the 330 margin, top edge on the 330 margin.
  assert.equal((heading!.x! as number) - (heading!.width as number) / 2, -3039 + 330);
  assert.ok((heading!.y as number) < -2166 + 330 + 300);
  assert.equal(plain(body!.content), 'Reviews spread knowledge across the team.');
  assert.equal(body!.textColor, '#FFFFFF');
  assert.equal(body!.fontSize, 140);
  assert.equal(body!.fontFamily, 'arial');
  assert.ok((body!.width as number) <= 5200);
  assert.ok((body!.y as number) > (heading!.y as number));
});

test('slides: list items are dark AME3 cards, task items yellow stickies', async () => {
  const { frames: list } = await frames();
  const slide = list[1]!;
  const cards = slide.elements.filter((e) => e.type === 'shape');
  assert.deepEqual(
    cards.map((c) => plain(c.content)),
    ['Readers find bugs the author misses', 'Names get better'],
  );
  for (const card of cards) {
    assert.deepEqual(
      [
        card.color,
        card.borderColor,
        card.borderWidth,
        card.textColor,
        card.fontSize,
        card.fontFamily,
      ],
      ['#151515', '#FFFFFF', 2, '#FFFFFF', 110, 'arial'],
    );
  }
  const stickies = slide.elements.filter((e) => e.type === 'sticky');
  assert.deepEqual(
    stickies.map((s) => plain(s.content)),
    ['Your sticky: one review that helped you'],
  );
  assert.equal(stickies[0]!.color, 'light_yellow');
  assert.ok((stickies[0]!.width as number) >= 500, 'sticky sized for the slide');
  // In document order: the cards above the sticky.
  assert.ok((stickies[0]!.y as number) > Math.max(...cards.map((c) => c.y as number)));
});

test('slides: logos bottom left and bottom right on every content slide', async () => {
  const { frames: list } = await frames();
  for (const slide of list.slice(1)) {
    const images = slide.elements.filter((e) => e.type === 'image');
    assert.deepEqual(
      images.map((i) => [i.file, i.width, i.x, i.y]),
      [
        [LOGOS.left!.value, 523, -2710, 2002],
        [LOGOS.right!.value, 731, 2673, 2001],
      ],
    );
  }
});

test('slides: logos given as https URLs become image URLs', async () => {
  const { frames: list } = await frames(DOC, {
    left: { env: 'MIRO_SLIDE_LOGO_LEFT', kind: 'url', value: 'https://logos.example/l.png' },
  });
  const images = list[1]!.elements.filter((e) => e.type === 'image');
  assert.deepEqual(
    images.map((i) => [i.url, i.file]),
    [['https://logos.example/l.png', undefined]],
  );
});

test('slides: a quote as the only block is a statement slide, centred, without heading', async () => {
  const { frames: list } = await frames();
  const slide = list[2]!;
  const statement = texts(slide);
  assert.equal(statement.length, 1);
  assert.equal(plain(statement[0]!.content), 'Code is read far more often than it is written.');
  assert.deepEqual(
    [statement[0]!.textColor, statement[0]!.fontSize, statement[0]!.width, statement[0]!.x],
    ['#FFFFFF', 380, 5300, 0],
  );
  assert.equal(statement[0]!.textAlign, 'center');
  assert.equal(statement[0]!.fontFamily, 'arial');
});

test('slides: flowcharts in the AME3 style, scaled up, white connectors and captions', async () => {
  const { frames: list } = await frames();
  const slide = list[3]!;
  const shapes = slide.elements.filter((e) => e.type === 'shape');
  const byLabel = (label: string) => shapes.find((s) => plain(s.content) === label)!;
  const open = byLabel('Open');
  assert.deepEqual(
    [open.color, open.borderColor, open.textColor],
    ['#151515', '#FFFFFF', '#FFFFFF'],
  );
  assert.ok((open.fontSize as number) >= 32, 'node text scaled with the slide');
  // classDef colours stay.
  assert.deepEqual([byLabel('Merge').color, byLabel('Merge').textColor], ['#D3F9D8', '#212529']);
  const connectors = slide.elements.filter((e) => e.type === 'connector');
  assert.equal(connectors.length, 2);
  for (const connector of connectors) assert.equal(connector.color, '#FFFFFF');
  const captioned = connectors.find((c) => c.caption === 'ready')!;
  assert.equal(captioned.textColor, '#FFFFFF');
  assert.ok((captioned.fontSize as number) >= 28);
  // The diagram stays inside the safe area.
  for (const shape of shapes) {
    const x = shape.x as number;
    const w = shape.width as number;
    assert.ok(x - w / 2 >= -3039 + 330 && x + w / 2 <= 3039 - 330, String(shape.content));
  }
});

test('slides: the test document is valid, without layout or text-fit warnings', async () => {
  const { report } = await checkDocument(DOC, policy);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.layout, []);
  assert.deepEqual(report.text_fit, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.valid, true);
});

test('slides: without configured logos there are none, and one warning says how to add them', async () => {
  const { composed, frames: list } = await frames(DOC, {});
  assert.equal(list.flatMap((f) => f.elements).filter((e) => e.type === 'image').length, 0);
  assert.equal(composed.warnings.length, 1);
  assert.equal(composed.warnings[0]!.line, 2);
  assert.match(composed.warnings[0]!.message, /MIRO_SLIDE_LOGO_LEFT/);
  assert.match(composed.warnings[0]!.message, /MIRO_SLIDE_LOGO_RIGHT/);
});

test('slides: a logo file that does not exist or is no image is an error on the theme line', async () => {
  const { composed } = await frames(DOC, {
    left: { env: 'MIRO_SLIDE_LOGO_LEFT', kind: 'file', value: '/nowhere/logo.svg' },
    right: { env: 'MIRO_SLIDE_LOGO_RIGHT', kind: 'invalid', value: 'logo.svg', reason: 'x' },
  });
  assert.equal(composed.errors.length, 2);
  for (const error of composed.errors) assert.equal(error.line, 2);
  assert.match(composed.errors[0]!.message, /MIRO_SLIDE_LOGO_LEFT.*\/nowhere\/logo\.svg/);
  assert.match(composed.errors[1]!.message, /MIRO_SLIDE_LOGO_RIGHT/);
});

test('slides: a slide that is too full is a layout warning on its heading line', async () => {
  const long = Array.from(
    { length: 12 },
    (_, i) => `Paragraph ${i + 1} explains one more detail of the review process at length.`,
  ).join('\n\n');
  const markdown = `---\ntheme: slides\n---\n\n# Board\n\n## Too much\n\n${long}\n`;
  const { report } = await checkDocument(markdown, policy);
  assert.equal(report.valid, true);
  assert.equal(report.layout.length, 1);
  assert.equal(report.layout[0]!.line, 7);
  assert.match(report.layout[0]!.message, /too full/);
  assert.match(report.layout[0]!.message, /split/i);
});

test('slides: a flowchart that only fits below the minimum scale makes the slide too full', async () => {
  const chain = Array.from(
    { length: 14 },
    (_, i) => `  n${i}[Step ${i}] --> n${i + 1}[Step ${i + 1}]`,
  );
  const markdown =
    `---\ntheme: slides\n---\n\n# Board\n\n## Long chain\n\n` +
    `\`\`\`mermaid\nflowchart TD\n${chain.join('\n')}\n\`\`\`\n`;
  const { report } = await checkDocument(markdown, policy);
  assert.equal(report.layout.length, 1);
  assert.match(report.layout[0]!.message, /too full/);
});

test('an unknown theme is an error on its line', async () => {
  const { report } = await checkDocument(
    '---\ntitle: X\ntheme: posters\n---\n\n## A\n\ntext\n',
    policy,
  );
  assert.equal(report.valid, false);
  assert.equal(report.errors[0]!.line, 3);
  assert.match(report.errors[0]!.message, /posters/);
  assert.match(report.errors[0]!.message, /slides/);
});

test('title slide fields without theme slides are a warning, and the look stays the default', async () => {
  const { composed } = await frames('---\nkicker: K\n---\n\n# B\n\n## A\n\ntext\n');
  assert.equal(composed.raw.style, undefined);
  assert.equal(composed.warnings.length, 1);
  assert.equal(composed.warnings[0]!.line, 2);
  assert.match(composed.warnings[0]!.message, /theme: slides/);
});

test('a spec may not upload local files; documents only the configured logos', () => {
  const spec = `
name: X
frames:
  - id: a
    title: A
    elements:
      - { type: image, file: /etc/hosts }
`;
  const { report } = checkSpec(spec, policy);
  assert.equal(report.valid, false);
  assert.match(report.errors[0]!.message, /local files/);
  assert.equal(report.errors[0]!.path, '/frames/0/elements/0/file');
});

test('preview of a slides document counts the logo uploads and has no title bars', async () => {
  const deps = testDeps({ slideLogos: LOGOS });
  const result = await previewBoard({ document: DOC }, deps);
  const preview = data<{ totals: { api_calls: number; frames: number } }>(result);
  assert.equal(preview.totals.frames, 4);
  assert.doesNotMatch(text(result), /title bar/);
  assert.match(text(result), /4 frames, \d+ elements, \d+ connectors/);
  const validated = await validateBoard({ document: DOC }, deps);
  assert.doesNotMatch(text(validated), /title bar/);
  assert.match(text(validated), /elements and connectors, 0 warnings/);
});

test('slide logos come from MIRO_SLIDE_LOGO_LEFT and _RIGHT: an absolute path or an https URL', () => {
  const config = configFromEnv({
    MIRO_SLIDE_LOGO_LEFT: '/logos/left.svg',
    MIRO_SLIDE_LOGO_RIGHT: 'https://logos.example/right.png',
  });
  assert.deepEqual(config.slideLogos, {
    left: { env: 'MIRO_SLIDE_LOGO_LEFT', kind: 'file', value: '/logos/left.svg' },
    right: { env: 'MIRO_SLIDE_LOGO_RIGHT', kind: 'url', value: 'https://logos.example/right.png' },
  });
  const home = configFromEnv({ HOME: '/home/a', MIRO_SLIDE_LOGO_LEFT: '~/l.svg' });
  assert.deepEqual(home.slideLogos.left, {
    env: 'MIRO_SLIDE_LOGO_LEFT',
    kind: 'file',
    value: '/home/a/l.svg',
  });
  const bad = configFromEnv({
    MIRO_SLIDE_LOGO_LEFT: 'logo.svg',
    MIRO_SLIDE_LOGO_RIGHT: 'http://x/y.png',
  });
  assert.equal(bad.slideLogos.left!.kind, 'invalid');
  assert.equal(bad.slideLogos.right!.kind, 'invalid');
  assert.deepEqual(configFromEnv({}).slideLogos, {});
});

test('slides: a Wardley map keeps its colours on a white panel inside the safe area', async () => {
  const markdown =
    '---\ntheme: slides\n---\n\n# Board\n\n## Map\n\n```mermaid\nwardley-beta\n' +
    'anchor User [0.95, 0.5]\ncomponent Answers [0.8, 0.5]\ncomponent Search [0.4, 0.7]\n' +
    'User -> Answers\nAnswers -> Search\n```\n';
  const { frames: list } = await frames(markdown);
  const slide = list[1]!;
  const panel = slide.elements.find((e) => e.type === 'shape')!;
  assert.equal(panel.color, '#FFFFFF');
  for (const element of slide.elements) {
    if (element.type === 'connector' || element.type === 'image' || element.type === 'line')
      continue;
    const x = element.x as number;
    const y = element.y as number;
    const w = (element.width as number | undefined) ?? 0;
    assert.ok(x - w / 2 >= -3039 + 330 - 1 && x + w / 2 <= 3039 - 330 + 1, String(element.content));
    assert.ok(y <= 1800, String(element.content));
  }
  const { report } = await checkDocument(markdown, policy);
  assert.deepEqual(report.layout, []);
});
