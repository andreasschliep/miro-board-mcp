/**
 * Document model to frames in the slide style (theme: slides, design D19 ff.).
 *
 * Every frame has the same fixed size; content does not make it grow. A white title
 * slide comes first, then one black slide per "##": heading top left, blocks stacked
 * below it, logos in the footer. Content that does not fit into the safe area is a
 * layout warning on the frame's heading line, so the agent splits the frame instead
 * of the server shrinking the text. All colours, fonts and sizes come from SLIDES.
 */
import { statSync } from 'node:fs';
import { extname } from 'node:path';
import { estimateRequiredHeight, type ElementSpec } from 'miro-board-builder';
import {
  frameDiagrams,
  uniqueId,
  type ComposedBoard,
  type ComposeOptions,
  type LayoutNote,
} from './compose.ts';
import type { FlowchartLook } from './flowchart.ts';
import {
  escapeHtml,
  type Block,
  type Diagram,
  type DocFinding,
  type DocFrame,
  type DocModel,
} from './model.ts';
import { LOGO_ENV, SLIDES, type LogoPlacement, type SlideLogos } from './theme.ts';

const S = SLIDES;
const HALF_W = S.frame.width / 2;
const HALF_H = S.frame.height / 2;
const SAFE = {
  left: -HALF_W + S.safe.margin,
  right: HALF_W - S.safe.margin,
  top: -HALF_H + S.safe.margin,
  bottom: S.safe.footerTop,
};
const SAFE_WIDTH = SAFE.right - SAFE.left;
const SAFE_HEIGHT = SAFE.bottom - SAFE.top;

const FLOWCHART_LOOK: FlowchartLook = {
  node: S.flowchart.node,
  edge: S.flowchart.edge,
  subgraph: S.flowchart.subgraph,
  caption: S.flowchart.caption,
  fontFamily: S.fonts.content,
};

/** Image files Miro takes as an upload, and its size limit. */
const LOGO_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg']);
const LOGO_MAX_BYTES = 6 * 1024 * 1024;

type Line = number;
type Placed = Array<[ElementSpec, Line]>;

/** A paragraph, bold or italic when the theme says so. */
function paragraph(html: string, emphasis: 'strong' | 'em' | null): string {
  return emphasis ? `<p><${emphasis}>${html}</${emphasis}></p>` : `<p>${html}</p>`;
}

function estimate(html: string, fontSize: number, width: number): number {
  return estimateRequiredHeight(html, { fontSize, width });
}

/** Lines of wrapped text, from the same estimate (its height less padding, per line). */
function lineCount(html: string, fontSize: number, width: number): number {
  const padding = 2 * Math.max(4, fontSize * 0.25);
  return Math.max(1, Math.round((estimate(html, fontSize, width) - padding) / (fontSize * 1.6)));
}

function textElement(
  content: string,
  style: { color: string; fontSize: number },
  at: { x: number; y: number; width: number },
  align: 'left' | 'center',
  fontFamily: string,
): ElementSpec {
  return {
    type: 'text',
    content,
    x: Math.round(at.x),
    y: Math.round(at.y),
    width: Math.round(at.width),
    fontSize: style.fontSize,
    textAlign: align,
    textColor: style.color,
    fontFamily,
  };
}

/** The logos for every content slide, or findings that say why there are none. */
function logoElements(
  logos: SlideLogos | undefined,
  line: Line,
  errors: DocFinding[],
  warnings: DocFinding[],
): ElementSpec[] {
  const missing = (['left', 'right'] as const).filter((side) => !logos?.[side]);
  if (missing.length > 0) {
    const names = missing.map((side) => LOGO_ENV[side]).join(' and ');
    warnings.push({
      line,
      message:
        `theme slides: no footer logo configured in ${names}; the slides are built without ` +
        'it. Ask the user to set it in the server environment (an absolute path or an https URL).',
    });
  }
  const elements: ElementSpec[] = [];
  for (const side of ['left', 'right'] as const) {
    const source = logos?.[side];
    if (!source) continue;
    const place: LogoPlacement = S.logos[side];
    const fail = (why: string) =>
      errors.push({
        line,
        message: `${source.env}="${source.value}" ${why}. Ask the user to fix the server configuration.`,
      });
    if (source.kind === 'invalid') {
      fail(`is not usable: ${source.reason}`);
      continue;
    }
    if (source.kind === 'file') {
      const extension = extname(source.value).toLowerCase();
      const stat = statSync(source.value, { throwIfNoEntry: false });
      const size = stat?.isFile() ? stat.size : null;
      if (size === null) {
        fail('does not exist or is not a file');
        continue;
      }
      if (!LOGO_EXTENSIONS.has(extension)) {
        fail('is not a png, jpg, gif or svg file');
        continue;
      }
      if (size > LOGO_MAX_BYTES) {
        fail('is larger than the 6 MB Miro accepts');
        continue;
      }
    }
    elements.push({
      type: 'image',
      ...(source.kind === 'file' ? { file: source.value } : { url: source.value }),
      width: place.width,
      x: place.x,
      y: place.y,
    });
  }
  return elements;
}

/** White title slide from the front matter; positions as measured on the reference. */
function titleSlide(model: DocModel): { elements: Placed; notes: string[] } {
  const T = S.titleSlide;
  const line = model.themeLine;
  const font = S.fonts.title;
  const elements: Placed = [];
  const notes: string[] = [];
  /** Vertical extent of every text, top to bottom, to find overlaps. */
  const extents: Array<{ name: string; top: number; bottom: number }> = [];

  const place = (
    name: string,
    value: string,
    style: {
      color: string;
      fontSize: number;
      width: number;
      emphasis: 'strong' | 'em' | null;
    },
    y: number,
  ) => {
    const html = paragraph(escapeHtml(value), style.emphasis);
    const height = lineCount(html, style.fontSize, style.width) * style.fontSize * 1.6;
    elements.push([
      textElement(html, style, { x: 0, y, width: style.width }, 'center', font),
      line,
    ]);
    extents.push({ name, top: y - height / 2, bottom: y + height / 2 });
  };

  // A title of several lines grows upwards from where a one-line title ends, and pushes
  // the kicker up, at most to the safe margin.
  const titleHtml = paragraph(escapeHtml(model.name), T.title.emphasis);
  const lineHeight = T.title.fontSize * 1.6;
  const titleHeight = lineCount(titleHtml, T.title.fontSize, T.title.width) * lineHeight;
  const titleBottom = T.title.y + lineHeight / 2;
  const titleY = titleBottom - titleHeight / 2;

  const { kicker, subtitle, tagline, byline } = model.titleSlide;
  if (kicker !== undefined) {
    const kickerHtml = paragraph(escapeHtml(kicker), T.kicker.emphasis);
    const kickerHeight =
      lineCount(kickerHtml, T.kicker.fontSize, T.kicker.width) * T.kicker.fontSize * 1.6;
    const referenceGap = T.title.y - lineHeight / 2 - (T.kicker.y + (T.kicker.fontSize * 1.6) / 2);
    const wanted = Math.min(T.kicker.y, titleY - titleHeight / 2 - referenceGap - kickerHeight / 2);
    place('kicker', kicker, T.kicker, Math.max(SAFE.top + kickerHeight / 2, wanted));
  }
  place('title', model.name, T.title, titleY);
  elements.push([
    {
      type: 'shape',
      shape: 'rectangle',
      content: '',
      x: 0,
      y: T.bar.y,
      width: T.bar.width,
      height: T.bar.height,
      color: T.bar.color,
      borderColor: T.bar.color,
      borderWidth: 1,
    },
    line,
  ]);
  extents.push({
    name: 'bar',
    top: T.bar.y - T.bar.height / 2,
    bottom: T.bar.y + T.bar.height / 2,
  });
  if (subtitle !== undefined) place('subtitle', subtitle, T.subtitle, T.subtitle.y);
  if (tagline !== undefined) place('tagline', tagline, T.tagline, T.tagline.y);
  if (byline !== undefined) place('byline', byline, T.byline, T.byline.y);

  for (const [index, extent] of extents.entries()) {
    const next = extents[index + 1];
    if (extent.top < SAFE.top || extent.bottom > SAFE.bottom) {
      notes.push(
        `title slide: the ${extent.name} does not fit on the slide; shorten it or move words ` +
          'into the subtitle or tagline.',
      );
    } else if (next && extent.bottom + T.minGap > next.top) {
      const lines = Math.round((extent.bottom - extent.top) / (T.title.fontSize * 1.6));
      notes.push(
        `title slide: the ${extent.name} runs into the ${next.name}` +
          `${extent.name === 'title' && lines > 1 ? ` (it needs ${lines} lines)` : ''}; ` +
          'shorten it or move words into the subtitle or tagline.',
      );
    }
  }
  return { elements, notes };
}

/** A diagram scaled by s around its centre, then moved down by dy. */
function scaled(element: ElementSpec, s: number, dy: number): ElementSpec {
  const out: ElementSpec = { ...element };
  for (const key of ['x', 'width', 'height', 'toX', 'toY'] as const) {
    const value = out[key];
    if (typeof value === 'number') out[key] = Math.round(value * s);
  }
  if (typeof out.y === 'number') out.y = Math.round(out.y * s + dy);
  if (typeof out.fontSize === 'number') out.fontSize = Math.round(out.fontSize * s);
  return out;
}

type Piece =
  | { kind: 'text'; line: Line; html: string; height: number }
  | {
      kind: 'cards';
      line: Line;
      items: string[];
      columns: number;
      width: number;
      cardHeight: number;
      height: number;
    }
  | { kind: 'stickies'; line: Line; items: string[]; columns: number; height: number }
  | { kind: 'diagram'; line: Line; diagram: Diagram & { kind: 'wardley' | 'flowchart' } };

/** A list becomes runs of cards and of sticky notes, in document order. */
function listPieces(block: Extract<Block, { kind: 'stickies' }>): Piece[] {
  const runs: Array<{ task: boolean; items: string[] }> = [];
  block.items.forEach((content, index) => {
    const task = block.tasks[index] === true;
    // In a loose list marked leaves the checkbox in the text; a sticky note does not show it.
    const item = task ? content.replace(/^\[[ xX]\]\s+/, '') : content;
    const last = runs.at(-1);
    if (last && last.task === task) last.items.push(item);
    else runs.push({ task, items: [item] });
  });
  return runs.map((run): Piece => {
    if (run.task) {
      const { width, gap, heightRatio } = S.sticky;
      const columns = Math.max(1, Math.floor((SAFE_WIDTH + gap) / (width + gap)));
      const rows = Math.ceil(run.items.length / columns);
      const height = rows * Math.round(width * heightRatio) + (rows - 1) * gap;
      return { kind: 'stickies', line: block.line, items: run.items, columns, height };
    }
    const { gap, maxColumns, fontSize, minHeight } = S.card;
    const columns = Math.min(maxColumns, run.items.length);
    const width = Math.floor((SAFE_WIDTH - (columns - 1) * gap) / columns);
    const cardHeight = Math.max(minHeight, ...run.items.map((i) => estimate(i, fontSize, width)));
    const rows = Math.ceil(run.items.length / columns);
    const height = rows * cardHeight + (rows - 1) * gap;
    return {
      kind: 'cards',
      line: block.line,
      items: run.items,
      columns,
      width,
      cardHeight,
      height,
    };
  });
}

/** Native size of a diagram on the slide, before scaling; Wardley maps get a panel. */
function nativeSize(diagram: Piece & { kind: 'diagram' }): { width: number; height: number } {
  const pad = diagram.diagram.kind === 'wardley' ? 2 * S.wardley.padding : 0;
  return { width: diagram.diagram.width + pad, height: diagram.diagram.height + pad };
}

function scaleLimits(diagram: Piece & { kind: 'diagram' }): { min: number; max: number } {
  const limits = diagram.diagram.kind === 'wardley' ? S.wardley : S.flowchart;
  return { min: limits.minScale, max: limits.maxScale };
}

function contentSlide(
  frame: DocFrame,
  diagrams: Map<Block, Diagram & { kind: 'wardley' | 'flowchart' }>,
): { elements: Placed; overflow: string | null } {
  const font = S.fonts.content;
  const only = frame.blocks.length === 1 ? frame.blocks[0] : undefined;
  if (only?.kind === 'text' && only.quote !== undefined) {
    const { statement } = S;
    const height = estimate(only.quote, statement.fontSize, statement.width);
    const element = textElement(
      only.quote,
      statement,
      { x: 0, y: (SAFE.top + SAFE.bottom) / 2, width: statement.width },
      'center',
      font,
    );
    return {
      elements: [[element, only.line]],
      overflow: height > SAFE_HEIGHT ? `the statement needs ${height} units of height` : null,
    };
  }

  const elements: Placed = [];
  const headingHtml = paragraph(frame.html, S.heading.emphasis);
  const headingHeight = estimate(headingHtml, S.heading.fontSize, SAFE_WIDTH);
  elements.push([
    textElement(
      headingHtml,
      S.heading,
      { x: SAFE.left + SAFE_WIDTH / 2, y: SAFE.top + headingHeight / 2, width: SAFE_WIDTH },
      'left',
      font,
    ),
    frame.line,
  ]);
  const contentTop = SAFE.top + headingHeight + S.heading.gapBelow;
  const textWidth = Math.min(S.text.maxWidth, SAFE_WIDTH);

  const pieces: Piece[] = frame.blocks.flatMap((block): Piece[] => {
    if (block.kind === 'text') {
      const height = estimate(block.html, S.text.fontSize, textWidth);
      return [{ kind: 'text', line: block.line, html: block.html, height }];
    }
    if (block.kind === 'stickies') return listPieces(block);
    const diagram = diagrams.get(block);
    if (!diagram || diagram.elements.length === 0) return [];
    return [{ kind: 'diagram', line: block.line, diagram }];
  });

  // Diagrams take the height the other blocks leave, all at one scale within their limits.
  const charts = pieces.filter((p): p is Piece & { kind: 'diagram' } => p.kind === 'diagram');
  const fixed = pieces.reduce((sum, p) => sum + (p.kind === 'diagram' ? 0 : p.height), 0);
  const gaps = S.blockGap * Math.max(0, pieces.length - 1);
  const free = SAFE.bottom - contentTop - fixed - gaps;
  const nativeHeight = charts.reduce((sum, p) => sum + nativeSize(p).height, 0);
  const fitting = Math.min(
    free / Math.max(1, nativeHeight),
    ...charts.map((p) => SAFE_WIDTH / Math.max(1, nativeSize(p).width)),
  );
  const scales = new Map(
    charts.map((p) => {
      const { min, max } = scaleLimits(p);
      return [p, Math.max(min, Math.min(max, fitting))];
    }),
  );

  let cursorY = contentTop;
  let widest = 0;
  for (const piece of pieces) {
    if (piece.kind === 'text') {
      elements.push([
        textElement(
          piece.html,
          S.text,
          { x: SAFE.left + textWidth / 2, y: cursorY + piece.height / 2, width: textWidth },
          'left',
          font,
        ),
        piece.line,
      ]);
      cursorY += piece.height;
    } else if (piece.kind === 'cards') {
      const { card } = S;
      piece.items.forEach((content, index) => {
        const column = index % piece.columns;
        const row = Math.floor(index / piece.columns);
        elements.push([
          {
            type: 'shape',
            shape: 'rectangle',
            content,
            x: Math.round(SAFE.left + piece.width / 2 + column * (piece.width + card.gap)),
            y: Math.round(cursorY + piece.cardHeight / 2 + row * (piece.cardHeight + card.gap)),
            width: piece.width,
            height: piece.cardHeight,
            color: card.fill,
            borderColor: card.border,
            borderWidth: card.borderWidth,
            textColor: card.text,
            fontSize: card.fontSize,
            fontFamily: font,
            textAlign: 'left',
          },
          piece.line,
        ]);
      });
      cursorY += piece.height;
    } else if (piece.kind === 'stickies') {
      const { sticky } = S;
      const height = Math.round(sticky.width * sticky.heightRatio);
      piece.items.forEach((content, index) => {
        const column = index % piece.columns;
        const row = Math.floor(index / piece.columns);
        elements.push([
          {
            type: 'sticky',
            content,
            x: Math.round(SAFE.left + sticky.width / 2 + column * (sticky.width + sticky.gap)),
            y: Math.round(cursorY + height / 2 + row * (height + sticky.gap)),
            width: sticky.width,
            color: sticky.color,
          },
          piece.line,
        ]);
      });
      cursorY += piece.height;
    } else {
      const s = scales.get(piece) ?? 1;
      const size = nativeSize(piece);
      const centreY = cursorY + (size.height * s) / 2;
      widest = Math.max(widest, size.width * s);
      if (piece.diagram.kind === 'wardley') {
        elements.push([
          {
            type: 'shape',
            shape: 'rectangle',
            content: '',
            x: 0,
            y: Math.round(centreY),
            width: Math.round(size.width * s),
            height: Math.round(size.height * s),
            color: S.wardley.panel,
            borderColor: S.wardley.panel,
            borderWidth: 1,
          },
          piece.line,
        ]);
      }
      for (const element of piece.diagram.elements) {
        elements.push([
          scaled(element, s, centreY),
          piece.diagram.sourceLines?.get(element) ?? piece.line,
        ]);
      }
      cursorY += size.height * s;
    }
    cursorY += S.blockGap;
  }
  const bottom = Math.round(cursorY - (pieces.length > 0 ? S.blockGap : 0));
  const problems: string[] = [];
  if (bottom > SAFE.bottom) {
    problems.push(
      `its content reaches y ${bottom}, ${bottom - SAFE.bottom} units below the footer line (y ${SAFE.bottom})`,
    );
  }
  if (widest > SAFE_WIDTH + 1) {
    problems.push(`a diagram is ${Math.round(widest)} units wide, ${SAFE_WIDTH} fit`);
  }
  return { elements, overflow: problems.length > 0 ? problems.join(', and ') : null };
}

export async function composeSlides(
  model: DocModel,
  options: ComposeOptions,
): Promise<ComposedBoard> {
  const errors = [...model.errors];
  const warnings = [...model.warnings];
  const layout: LayoutNote[] = [];
  const frameLines: number[] = [];
  const elementLines = new Map<string, number>();
  const usedIds = new Set<string>();
  const frames: Array<Record<string, unknown>> = [];
  const logos = logoElements(options.slideLogos, model.themeLine, errors, warnings);

  const addFrame = (id: string, title: string, line: Line, fill: string, placed: Placed) => {
    const frameIndex = frames.length;
    placed.forEach(([, at], index) =>
      elementLines.set(`/frames/${frameIndex}/elements/${index}`, at),
    );
    frames.push({
      id,
      title,
      x: frameIndex * (S.frame.width + S.frame.gap) + S.frame.width / 2,
      y: S.frame.height / 2,
      width: S.frame.width,
      height: S.frame.height,
      fillColor: fill,
      elements: placed.map(([element]) => element),
    });
    frameLines.push(line);
  };

  if (model.frames.length > 0) {
    const cover = titleSlide(model);
    addFrame(
      uniqueId(model.name, usedIds),
      model.name,
      model.themeLine,
      S.fills.title,
      cover.elements,
    );
    for (const note of cover.notes)
      layout.push({ frameIndex: 0, line: model.themeLine, message: note });
  }

  for (const frame of model.frames) {
    const id = uniqueId(frame.title, usedIds);
    const diagrams = await frameDiagrams(frame, id, errors, warnings, FLOWCHART_LOOK);
    const slide = contentSlide(frame, diagrams);
    if (slide.overflow) {
      layout.push({
        frameIndex: frames.length,
        line: frame.line,
        message:
          `slide "${frame.title}" is too full: ${slide.overflow}. Split it into two frames ` +
          '(a second "## heading" for the rest); slides do not grow and the text is not shrunk.',
      });
    }
    const footer: Placed = logos.map((logo) => [{ ...logo }, frame.line]);
    addFrame(id, frame.title, frame.line, S.fills.content, [...slide.elements, ...footer]);
  }

  return {
    raw: { name: model.name, style: { headerBar: false }, frames },
    frameLines,
    elementLines,
    errors,
    warnings,
    layout,
  };
}
