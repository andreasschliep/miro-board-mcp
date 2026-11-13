/**
 * Mermaid `wardley-beta` to board elements.
 *
 * Parsed with the official @mermaid-js/parser (Langium grammar, no DOM). The map is
 * drawn the way Mermaid draws it: evolution on x (Genesis to Commodity, equal stages
 * unless the map says otherwise), visibility on y (visible at the top).
 *
 * Mermaid has no group statement; pipelines are drawn as boxes, which is how bands
 * and groups are written in these documents.
 */
import { load } from 'js-yaml';
import { parse } from '@mermaid-js/parser';
import type { ElementSpec } from 'miro-board-builder';
import { escapeHtml, textWidth, type Diagram, type DocFinding } from './model.ts';

const DEFAULT_STAGES = ['Genesis', 'Custom Built', 'Product', 'Commodity'];
const DEFAULT_SIZE = { width: 1800, height: 1100 };
const PADDING = { left: 50, right: 50, top: 40, bottom: 80 };
const DOT = 28;
const PIPELINE = { height: 44, padding: 30, dot: 20 };

interface Theme {
  axisColor: string;
  axisTextColor: string;
  gridColor: string;
  componentFill: string;
  componentStroke: string;
  componentLabelColor: string;
  linkStroke: string;
  evolutionStroke: string;
  annotationFill: string;
  annotationStroke: string;
  annotationTextColor: string;
}

const DEFAULT_THEME: Theme = {
  axisColor: '#343A40',
  axisTextColor: '#495057',
  gridColor: '#DEE2E6',
  componentFill: '#FFFFFF',
  componentStroke: '#212529',
  componentLabelColor: '#212529',
  linkStroke: '#868E96',
  evolutionStroke: '#E03131',
  annotationFill: '#FFFFFF',
  annotationStroke: '#495057',
  annotationTextColor: '#212529',
};

/** Only plain hex colours reach Miro; anything else falls back to the default. */
function hex(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim() : null;
}

/** A front matter block at the top of the Mermaid code: theme colours, and how many lines it takes. */
export function mermaidFrontMatter(code: string): {
  body: string;
  lineOffset: number;
  config: unknown;
} {
  const match = /^---\n([\s\S]*?)\n---[ \t]*\n/.exec(code);
  if (!match) return { body: code, lineOffset: 0, config: null };
  let config: unknown;
  try {
    config = load(match[1] ?? '');
  } catch {
    // Front matter that is not YAML only loses its colours.
    config = null;
  }
  return { body: code.slice(match[0].length), lineOffset: match[0].split('\n').length - 1, config };
}

function themeFrom(config: unknown): Theme {
  const vars = (
    config as { config?: { themeVariables?: { wardley?: Record<string, unknown> } } } | null
  )?.config?.themeVariables?.wardley;
  const theme = { ...DEFAULT_THEME };
  for (const key of Object.keys(theme) as Array<keyof Theme>) {
    const colour = hex(vars?.[key]);
    if (colour) theme[key] = colour;
  }
  return theme;
}

interface Located {
  $cstNode?: { range?: { start?: { line?: number } } };
}
interface Named extends Located {
  name: string;
  visibility: number;
  evolution: number;
}
interface WardleyAst {
  title?: string;
  size?: { width: number; height: number };
  evolution?: { stages: Array<{ name: string; boundary?: number; secondName?: string }> };
  anchors: Named[];
  components: Array<
    Named & {
      label?: { negX?: boolean; offsetX: number; negY?: boolean; offsetY: number };
      decorator?: { strategy: string };
      inertia?: boolean;
    }
  >;
  links: Array<
    Located & {
      from: string;
      to: string;
      arrow?: string;
      fromPort?: string;
      toPort?: string;
      linkLabel?: string;
    }
  >;
  evolves: Array<Located & { component: string; target: number }>;
  pipelines: Array<
    Located & { parent: string; components: Array<Located & { name: string; evolution: number }> }
  >;
  notes: Array<Located & { text: string; visibility: number; evolution: number }>;
  annotations: Array<Located & { x: number; y: number }>;
  annotation: Array<Located & { number: number; x: number; y: number; text: string }>;
  accelerators: Array<Located & { name: string; x: number; y: number }>;
  deaccelerators: Array<Located & { name: string; x: number; y: number }>;
}

interface ParseErrorShape {
  message?: string;
  result?: {
    lexerErrors?: Array<{ line?: number; message: string }>;
    parserErrors?: Array<{ token?: { startLine?: number }; message: string }>;
  };
}

export async function wardleyDiagram(
  code: string,
  codeLine: number,
  refPrefix: string,
): Promise<Diagram> {
  const errors: DocFinding[] = [];
  const warnings: DocFinding[] = [];
  const { body, lineOffset, config } = mermaidFrontMatter(code);
  const firstLine = codeLine + lineOffset;
  const lineOf = (node: Located) => firstLine + (node.$cstNode?.range?.start?.line ?? 0);

  let ast: WardleyAst;
  try {
    ast = (await parse(
      'wardley',
      body.endsWith('\n') ? body : `${body}\n`,
    )) as unknown as WardleyAst;
  } catch (error) {
    const result = (error as ParseErrorShape).result;
    // A character the lexer cannot read (an umlaut in an unquoted name) is the real cause;
    // the parser error that follows it only says what it found next.
    const first =
      result?.lexerErrors?.map((e) => ({ line: e.line, message: e.message }))[0] ??
      result?.parserErrors?.map((e) => ({ line: e.token?.startLine, message: e.message }))[0];
    const codeText = first?.line ? (body.split('\n')[first.line - 1] ?? '').trim() : '';
    errors.push({
      line: firstLine + (first?.line ? first.line - 1 : 0),
      message:
        `wardley-beta could not read ${codeText ? `"${codeText}"` : 'this block'}: ` +
        `${(first?.message ?? (error as Error).message).replace(/ at offset: \d+, skipped \d+ characters\.?/, '').replace(/([^.!?])$/, '$1.')}` +
        (needsQuotes(codeText)
          ? ' A name with umlauts or one of : , ? needs double quotes, e.g. component "Zugänge" [0.30, 0.70].'
          : ''),
    });
    return { elements: [], width: 0, height: 0, errors, warnings, sourceLines: new Map() };
  }

  // Out-of-range values are errors; drawing continues (clamped) so that the other
  // findings of this block are reported in the same run.
  errors.push(...rangeErrors(ast, lineOf));

  const theme = themeFrom(config);
  const width = clamp(ast.size?.width ?? DEFAULT_SIZE.width, 800, 3000);
  const height = clamp(ast.size?.height ?? DEFAULT_SIZE.height, 500, 2000);
  const left = -width / 2 + PADDING.left;
  const right = width / 2 - PADDING.right;
  const top = -height / 2 + PADDING.top;
  const bottom = height / 2 - PADDING.bottom;
  const x = (evolution: number) => left + clamp(evolution, 0, 1) * (right - left);
  const y = (visibility: number) => bottom - clamp(visibility, 0, 1) * (bottom - top);

  // Every element remembers the line of the statement it came from, so that a layout
  // warning can point to its cause rather than to the start of the block.
  const sourceLines = new Map<ElementSpec, number>();
  let currentLine = firstLine;
  const tracked = (): ElementSpec[] => {
    const list: ElementSpec[] = [];
    const push = list.push.bind(list);
    list.push = (...items: ElementSpec[]) => {
      for (const item of items) sourceLines.set(item, currentLine);
      return push(...items);
    };
    return list;
  };
  const background = tracked();
  const nodes = tracked();
  const connectors = tracked();
  const refs = new Map<string, { ref: string; x: number; y: number }>();
  let counter = 0;
  const nextRef = () => `${refPrefix}-w${++counter}`;

  // Stages: dividers and names under the evolution axis.
  const stages = ast.evolution?.stages.length
    ? ast.evolution.stages
    : DEFAULT_STAGES.map((name) => ({ name }));
  const bounds = stages.every((s) => 'boundary' in s && typeof s.boundary === 'number');
  let start = 0;
  stages.forEach((stage, index) => {
    const end = bounds
      ? Number((stage as { boundary?: number }).boundary)
      : (index + 1) / stages.length;
    if (index < stages.length - 1) {
      background.push(line(x(end), bottom, 0, top - bottom, theme.gridColor));
    }
    const label =
      'secondName' in stage && stage.secondName
        ? `${stage.name} / ${stage.secondName}`
        : stage.name;
    background.push(
      text(
        label,
        (x(start) + x(end)) / 2,
        bottom + 28,
        16,
        theme.axisTextColor,
        'center',
        x(end) - x(start),
      ),
    );
    start = end;
  });
  if (
    ast.evolution?.stages.length &&
    !bounds &&
    ast.evolution.stages.some((s) => s.boundary !== undefined)
  ) {
    warnings.push({
      line: lineOf(ast.evolution as Located),
      message:
        'evolution: give every stage a boundary, or none; the stages are drawn with equal width.',
    });
  }

  // Axes.
  background.push(line(left, bottom, right - left, 0, theme.axisColor));
  background.push(line(left, bottom, 0, top - bottom, theme.axisColor));
  background.push(
    text(
      '<strong>Evolution</strong> →',
      right - 80,
      bottom + 58,
      16,
      theme.axisTextColor,
      'right',
      200,
    ),
  );
  background.push(text('Visible', left + 50, top + 12, 14, theme.axisTextColor, 'left', 100));
  background.push(text('Invisible', left + 56, bottom - 16, 14, theme.axisTextColor, 'left', 110));

  // Anchors: bold labels without a dot; links attach to an invisible box around them.
  for (const anchor of ast.anchors) {
    currentLine = lineOf(anchor);
    const ref = nextRef();
    const w = textWidth(anchor.name, 15) + 10;
    refs.set(anchor.name, { ref, x: x(anchor.evolution), y: y(anchor.visibility) });
    nodes.push({
      type: 'shape',
      ref,
      shape: 'rectangle',
      content: `<strong>${escapeHtml(anchor.name)}</strong>`,
      x: x(anchor.evolution),
      y: y(anchor.visibility),
      width: w,
      height: 40,
      color: '#FFFFFF',
      borderColor: '#FFFFFF',
      textColor: theme.componentLabelColor,
      fontSize: 15,
    });
  }

  // Pipelines, as Mermaid draws them: the parts sit on the parent's line inside a
  // box, and the parent moves to the top centre of that box.
  const parentAt = new Map<string, { x: number; y: number }>();
  const pipelineParts = new Set<string>();
  for (const pipeline of ast.pipelines) {
    currentLine = lineOf(pipeline);
    const parent = ast.components.find((c) => c.name === pipeline.parent);
    if (!parent) {
      errors.push({
        line: lineOf(pipeline),
        message: `pipeline "${pipeline.parent}": declare the component "${pipeline.parent}" with coordinates first.`,
      });
      continue;
    }
    if (pipeline.components.length === 0) continue;
    const lineY = y(parent.visibility);
    const parts = [...pipeline.components].sort((a, b) => a.evolution - b.evolution);
    const xs = parts.map((c) => x(c.evolution));
    const boxLeft = Math.min(...xs) - PIPELINE.padding;
    const boxRight = Math.max(...xs) + PIPELINE.padding;
    const boxTop = lineY - PIPELINE.height / 2;
    parentAt.set(pipeline.parent, { x: (boxLeft + boxRight) / 2, y: boxTop - DOT / 2 + 4 });
    background.push({
      type: 'shape',
      shape: 'rectangle',
      content: '',
      x: round((boxLeft + boxRight) / 2),
      y: round(lineY),
      width: round(boxRight - boxLeft),
      height: PIPELINE.height,
      color: '#FFFFFF',
      borderColor: theme.axisColor,
      borderWidth: 1,
    });

    // Labels under the box; a label that would overlap its left neighbour moves a row down.
    const rowEnds: number[] = [];
    let previous: string | null = null;
    for (const part of parts) {
      currentLine = lineOf(part);
      const ref = nextRef();
      const px = x(part.evolution);
      refs.set(part.name, { ref, x: px, y: lineY });
      pipelineParts.add(`${pipeline.parent}\u0000${part.name}`);
      nodes.push(dot(ref, px, lineY, theme.componentFill, theme.componentStroke, PIPELINE.dot));
      const w = Math.min(textWidth(part.name, 12), 240);
      let row = rowEnds.findIndex((end) => end + 8 <= px - w / 2);
      if (row === -1) row = rowEnds.length;
      rowEnds[row] = px + w / 2;
      nodes.push(
        text(
          escapeHtml(part.name),
          px,
          lineY + PIPELINE.height / 2 + 12 + row * 18,
          12,
          theme.componentLabelColor,
          'center',
          w,
        ),
      );
      if (previous) {
        connectors.push({
          type: 'connector',
          from: previous,
          to: ref,
          shape: 'straight',
          startCap: 'none',
          endCap: 'none',
          color: theme.linkStroke,
          strokeWidth: 1,
        });
      }
      previous = ref;
    }
  }

  // Components: a dot and a label to its right (or where `label [x, y]` puts it).
  for (const component of ast.components) {
    currentLine = lineOf(component);
    const moved = parentAt.get(component.name);
    const cx = moved?.x ?? x(component.evolution);
    const cy = moved?.y ?? y(component.visibility);
    const ref = nextRef();
    if (refs.has(component.name)) {
      warnings.push({
        line: lineOf(component),
        message: `"${component.name}" is declared twice; the second one is drawn too.`,
      });
    }
    refs.set(component.name, { ref, x: cx, y: cy });
    nodes.push(dot(ref, cx, cy, theme.componentFill, theme.componentStroke));
    const w = Math.min(textWidth(component.name, 14), 320);
    const offset = component.label
      ? {
          dx: (component.label.negX ? -1 : 1) * component.label.offsetX,
          dy: (component.label.negY ? -1 : 1) * component.label.offsetY,
        }
      : { dx: DOT / 2 + 4, dy: -DOT / 2 - 2 };
    nodes.push(
      text(
        escapeHtml(component.name),
        cx + offset.dx + w / 2,
        cy + offset.dy,
        14,
        theme.componentLabelColor,
        'left',
        w,
      ),
    );
    if (component.inertia) {
      nodes.push({
        type: 'shape',
        shape: 'rectangle',
        content: '',
        x: cx + DOT,
        y: cy,
        width: 8,
        height: 36,
        color: theme.componentStroke,
        borderColor: theme.componentStroke,
      });
    }
    if (component.decorator) {
      warnings.push({
        line: lineOf(component),
        message: `(${component.decorator.strategy}) on "${component.name}" is not drawn on the board.`,
      });
    }
  }

  // Dependencies. Like Mermaid, a link from a pipeline part to its own parent is not drawn.
  for (const link of ast.links) {
    currentLine = lineOf(link);
    if (
      pipelineParts.has(`${link.to}\u0000${link.from}`) ||
      pipelineParts.has(`${link.from}\u0000${link.to}`)
    )
      continue;
    const from = refs.get(link.from);
    const to = refs.get(link.to);
    if (!from || !to) {
      const missing = from ? link.to : link.from;
      errors.push({
        line: lineOf(link),
        message: `link ${link.from} -> ${link.to}: "${missing}" is not declared.`,
      });
      continue;
    }
    const arrow = link.arrow ?? '';
    const flow = Boolean(link.fromPort || link.toPort) || (arrow !== '' && arrow !== '->');
    const caption = link.linkLabel ?? /\+'([^']*)'/.exec(arrow)?.[1];
    connectors.push({
      type: 'connector',
      from: from.ref,
      to: to.ref,
      shape: 'straight',
      startCap: 'none',
      endCap: flow ? 'arrow' : 'none',
      color: theme.linkStroke,
      strokeWidth: 1,
      ...(arrow.includes('.') ? { strokeStyle: 'dashed' } : {}),
      ...(caption ? { caption: escapeHtml(caption) } : {}),
    });
  }

  // Evolution: a red ghost at the target and a dashed arrow towards it.
  const partNames = new Set(ast.pipelines.flatMap((p) => p.components.map((c) => c.name)));
  for (const evolve of ast.evolves) {
    currentLine = lineOf(evolve);
    if (partNames.has(evolve.component)) {
      // Mermaid draws no evolution for a pipeline part; the board shows the same map.
      warnings.push({
        line: currentLine,
        message:
          `evolve "${evolve.component}" is not drawn: Mermaid draws no evolution for a part ` +
          'of a pipeline, so the board leaves it out too. Write it as a note instead.',
      });
      continue;
    }
    const source = refs.get(evolve.component);
    if (!source) {
      errors.push({
        line: lineOf(evolve),
        message: `evolve "${evolve.component}": the component is not declared.`,
      });
      continue;
    }
    const ref = nextRef();
    const gx = x(evolve.target);
    nodes.push(dot(ref, gx, source.y, '#FFFFFF', theme.evolutionStroke));
    const w = Math.min(textWidth(evolve.component, 14), 320);
    nodes.push(
      text(
        escapeHtml(evolve.component),
        gx + DOT / 2 + 4 + w / 2,
        source.y - DOT / 2 - 2,
        14,
        theme.evolutionStroke,
        'left',
        w,
      ),
    );
    connectors.push({
      type: 'connector',
      from: source.ref,
      to: ref,
      shape: 'straight',
      startCap: 'none',
      endCap: 'arrow',
      color: theme.evolutionStroke,
      strokeWidth: 2,
      strokeStyle: 'dashed',
    });
  }

  for (const note of ast.notes) {
    currentLine = lineOf(note);
    const w = Math.min(textWidth(note.text, 14), 360);
    nodes.push(
      text(
        escapeHtml(note.text),
        x(note.evolution) + w / 2,
        y(note.visibility),
        14,
        theme.axisTextColor,
        'left',
        w,
      ),
    );
  }

  for (const annotation of ast.annotation) {
    currentLine = lineOf(annotation);
    nodes.push({
      type: 'shape',
      shape: 'circle',
      content: String(annotation.number),
      x: x(annotation.y),
      y: y(annotation.x),
      width: 30,
      height: 30,
      color: theme.annotationFill,
      borderColor: theme.annotationStroke,
      textColor: theme.annotationTextColor,
      fontSize: 12,
    });
  }
  const legend = ast.annotations[0];
  if (legend && ast.annotation.length > 0) {
    const lines = ast.annotation.map((a) => `<p>${a.number}. ${escapeHtml(a.text)}</p>`).join('');
    nodes.push(
      text(
        lines,
        x(legend.y) + 180,
        y(legend.x) + 20 * ast.annotation.length,
        14,
        theme.annotationTextColor,
        'left',
        360,
      ),
    );
  }

  for (const [list, shape] of [
    [ast.accelerators, 'right_arrow'],
    [ast.deaccelerators, 'left_arrow'],
  ] as const) {
    for (const item of list) {
      currentLine = lineOf(item);
      nodes.push({
        type: 'shape',
        shape,
        content: escapeHtml(item.name),
        x: x(item.y),
        y: y(item.x),
        width: Math.max(160, textWidth(item.name, 14) + 40),
        height: 60,
        color: '#FFFFFF',
        borderColor: theme.axisColor,
        fontSize: 14,
      });
    }
  }

  return {
    elements: [...background, ...nodes, ...connectors],
    width,
    height,
    errors,
    warnings,
    sourceLines,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function line(x: number, y: number, toX: number, toY: number, color: string): ElementSpec {
  return {
    type: 'line',
    x: round(x),
    y: round(y),
    toX: round(toX),
    toY: round(toY),
    color,
    thickness: 2,
  };
}

function dot(
  ref: string,
  x: number,
  y: number,
  fill: string,
  stroke: string,
  size = DOT,
): ElementSpec {
  return {
    type: 'shape',
    ref,
    shape: 'circle',
    content: '',
    x: round(x),
    y: round(y),
    width: size,
    height: size,
    color: fill,
    borderColor: stroke,
    borderWidth: 2,
  };
}

function text(
  html: string,
  x: number,
  y: number,
  fontSize: number,
  color: string,
  textAlign: 'left' | 'center' | 'right',
  width: number,
): ElementSpec {
  return {
    type: 'text',
    content: html,
    x: round(x),
    y: round(y),
    width: Math.max(40, Math.round(width)),
    fontSize,
    textColor: color,
    textAlign,
  };
}

function round(value: number): number {
  return Math.round(value);
}

/** Text left of a quoted name or comment that a Wardley name cannot hold without quotes. */
export function needsQuotes(codeLine: string): boolean {
  if (/^\s*title\b/.test(codeLine)) return false;
  const bare = codeLine.replace(/"([^"\\]|\\.)*"/g, '').replace(/%%.*$/, '');
  const rest = bare.replace(/\[[^\]]*\]/g, '');
  return /[:,?]/.test(rest) || [...rest].some((c) => c.charCodeAt(0) > 127);
}

/** Coordinates in wardley-beta are [visibility, evolution], both from 0 to 1. */
function rangeErrors(ast: WardleyAst, lineOf: (node: Located) => number): DocFinding[] {
  const errors: DocFinding[] = [];
  const check = (node: Located, name: string, values: Array<[string, number]>) => {
    for (const [what, value] of values) {
      if (!(value >= 0 && value <= 1)) {
        errors.push({
          line: lineOf(node),
          message:
            `"${name}": ${what} ${value} is outside 0 to 1. Wardley coordinates are ` +
            '[visibility, evolution], both from 0 to 1.',
        });
      }
    }
  };
  for (const n of [...ast.anchors, ...ast.components]) {
    check(n, n.name, [
      ['visibility', n.visibility],
      ['evolution', n.evolution],
    ]);
  }
  for (const pipeline of ast.pipelines) {
    for (const part of pipeline.components) check(part, part.name, [['evolution', part.evolution]]);
  }
  for (const evolve of ast.evolves)
    check(evolve, evolve.component, [['evolve target', evolve.target]]);
  for (const note of ast.notes) {
    check(note, note.text, [
      ['visibility', note.visibility],
      ['evolution', note.evolution],
    ]);
  }
  for (const a of ast.annotation)
    check(a, `annotation ${a.number}`, [
      ['position', a.x],
      ['position', a.y],
    ]);
  for (const a of ast.annotations)
    check(a, 'annotations', [
      ['position', a.x],
      ['position', a.y],
    ]);
  for (const a of [...ast.accelerators, ...ast.deaccelerators]) {
    check(a, a.name, [
      ['position', a.x],
      ['position', a.y],
    ]);
  }
  return errors;
}
