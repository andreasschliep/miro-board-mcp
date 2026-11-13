/**
 * Mermaid `flowchart` / `graph` to board elements.
 *
 * Parsed with the official `mermaid` package (design decision: no grammar of our own).
 * Mermaid sanitises labels with DOMPurify, which needs a DOM; in Node a jsdom window
 * provides it. Nothing is rendered and no script runs: jsdom executes no scripts by
 * default. Positions come from dagre, the layout engine Mermaid itself started with.
 */
import { layout, graphlib } from '@dagrejs/dagre';
import type { ElementSpec } from 'miro-board-builder';
import { mermaidFrontMatter } from './wardley.ts';
import { escapeHtml, textWidth, type Diagram, type DocFinding } from './model.ts';

interface FlowVertex {
  id: string;
  text?: string;
  type?: string;
  classes?: string[];
  styles?: string[];
}
interface FlowEdge {
  start: string;
  end: string;
  type?: string;
  stroke?: string;
  text?: string;
}
interface FlowSubGraph {
  id: string;
  title?: string;
  nodes: string[];
}
interface FlowDb {
  getVertices(): Map<string, FlowVertex> | Record<string, FlowVertex>;
  getEdges(): FlowEdge[];
  getSubGraphs(): FlowSubGraph[];
  getDirection?(): string;
  getClasses?(): Map<string, { styles?: string[] }> | Record<string, { styles?: string[] }>;
}
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  mermaidAPI: { getDiagramFromText(text: string): Promise<{ type: string; db: unknown }> };
}

let mermaidLoading: Promise<MermaidApi> | null = null;

/** Loads mermaid once, behind a jsdom window. */
function loadMermaid(): Promise<MermaidApi> {
  mermaidLoading ??= (async () => {
    const { JSDOM } = await import('jsdom');
    const { window } = new JSDOM('');
    const globals = globalThis as Record<string, unknown>;
    for (const key of [
      'window',
      'document',
      'DOMParser',
      'Element',
      'HTMLElement',
      'Node',
    ] as const) {
      if (globals[key] === undefined) {
        globals[key] =
          key === 'window' ? window : (window as unknown as Record<string, unknown>)[key];
      }
    }
    const { default: mermaid } = (await import('mermaid')) as unknown as { default: MermaidApi };
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    return mermaid;
  })();
  return mermaidLoading;
}

/** Mermaid keeps one database per diagram type; parse one diagram at a time. */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

const SHAPES: Record<string, string> = {
  square: 'rectangle',
  rect: 'rectangle',
  round: 'round_rectangle',
  stadium: 'round_rectangle',
  subroutine: 'rectangle',
  cylinder: 'can',
  circle: 'circle',
  doublecircle: 'circle',
  ellipse: 'circle',
  diamond: 'rhombus',
  hexagon: 'hexagon',
  trapezoid: 'trapezoid',
  inv_trapezoid: 'trapezoid',
  lean_right: 'parallelogram',
  lean_left: 'parallelogram',
  odd: 'rectangle',
};

const CAPS: Record<string, { start: string; end: string }> = {
  arrow_point: { start: 'none', end: 'arrow' },
  arrow_open: { start: 'none', end: 'none' },
  arrow_circle: { start: 'none', end: 'filled_oval' },
  arrow_cross: { start: 'none', end: 'none' },
  double_arrow_point: { start: 'arrow', end: 'arrow' },
  double_arrow_circle: { start: 'filled_oval', end: 'filled_oval' },
  double_arrow_cross: { start: 'none', end: 'none' },
};

/** Longer labels still fit, because the box grows; but the chart gets hard to read. */
export const NODE_LABEL_MAX_CHARS = 80;

/**
 * Checks Mermaid would either reject with a message about a later line (an unclosed
 * bracket) or accept without effect on the board (click, colours that are not hex).
 */
function lineChecks(
  codeLines: string[],
  firstLine: number,
): { errors: DocFinding[]; warnings: DocFinding[] } {
  const errors: DocFinding[] = [];
  const warnings: DocFinding[] = [];
  const pairs: Array<[string, string]> = [
    ['[', ']'],
    ['(', ')'],
    ['{', '}'],
  ];
  codeLines.forEach((raw, index) => {
    const line = firstLine + index;
    const text = raw.trim();
    if (!text || text.startsWith('%%')) return;
    if (/^click\s/.test(text)) {
      warnings.push({
        line,
        message: `flowchart: "${text}" is not drawn; shapes on the board get no links.`,
      });
      return;
    }
    if (/^(classDef|style)\s/.test(text)) {
      for (const [, property, value] of text.matchAll(/\b(fill|stroke|color)\s*:\s*([^,;\s]+)/g)) {
        if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value ?? '')) {
          warnings.push({
            line,
            message: `flowchart: ${property}:${value} is not a hex colour; the default is used. Write e.g. ${property}:#2b8a3e.`,
          });
        }
      }
      return;
    }
    // Brackets inside quotes, edge labels |...| and asymmetric shapes id>text] do not count.
    const bare = text
      .replace(/"[^"]*"/g, '')
      .replace(/\|[^|]*\|/g, '')
      .replace(/(\w)>[^\]]*\]/g, '$1');
    for (const [open, close] of pairs) {
      const opened = bare.split(open).length - 1;
      const closed = bare.split(close).length - 1;
      if (opened !== closed) {
        errors.push({
          line,
          message:
            opened > closed
              ? `flowchart: "${text}" opens "${open}" but does not close it. Add "${close}" on this line.`
              : `flowchart: "${text}" has a "${close}" without a matching "${open}".`,
        });
        break;
      }
    }
  });
  return { errors, warnings };
}

const DIRECTIONS: Record<string, string> = { TB: 'TB', TD: 'TB', BT: 'BT', LR: 'LR', RL: 'RL' };
const FONT = 16;
const COLOURS = { fill: '#FFFFFF', stroke: '#343A40', text: '#212529', edge: '#495057' };

function values<T>(collection: Map<string, T> | Record<string, T> | undefined): Array<[string, T]> {
  if (!collection) return [];
  return collection instanceof Map ? [...collection.entries()] : Object.entries(collection);
}

/** Label text without tags or entities, lines split on <br>. */
function labelLines(label: string | undefined, fallback: string): string[] {
  const text = (label ?? fallback)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\*\*|`/g, '');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function cssColour(styles: string[] | undefined, property: string): string | null {
  for (const style of styles ?? []) {
    const [key, raw] = style.split(':').map((part) => part.trim());
    if (key !== property || !raw) continue;
    const value = raw.replace(/;$/, '');
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toUpperCase();
    if (/^#[0-9a-fA-F]{3}$/.test(value)) {
      return `#${[...value.slice(1)].map((c) => c + c).join('')}`.toUpperCase();
    }
  }
  return null;
}

function nodeSize(lines: string[], shape: string): { width: number; height: number } {
  const longest = Math.max(...lines.map((line) => textWidth(line, FONT)), 60);
  const width = Math.min(Math.max(longest + 40, 140), 360);
  const wrapped = lines.reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(textWidth(line, FONT) / (width - 40))),
    0,
  );
  const height = Math.max(64, wrapped * 26 + 28);
  if (shape === 'rhombus')
    return { width: Math.round(width * 1.5), height: Math.round(Math.max(height * 1.6, 110)) };
  if (shape === 'circle') {
    const size = Math.max(width, height, 100);
    return { width: size, height: size };
  }
  return { width, height };
}

export async function flowchartDiagram(
  code: string,
  codeLine: number,
  refPrefix: string,
): Promise<Diagram> {
  const errors: DocFinding[] = [];
  const warnings: DocFinding[] = [];
  const { body, lineOffset } = mermaidFrontMatter(code);
  const firstLine = codeLine + lineOffset;
  const codeLines = body.split('\n');

  const checked = lineChecks(codeLines, firstLine);
  warnings.push(...checked.warnings);
  if (checked.errors.length > 0) {
    return { elements: [], width: 0, height: 0, errors: checked.errors, warnings };
  }
  /** Line where a node is first given a label or shape, for findings about that node. */
  const nodeLine = (id: string): number => {
    const pattern = new RegExp(`(^|[^\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[[({>]`);
    const index = codeLines.findIndex((l) => pattern.test(l));
    return index >= 0 ? firstLine + index : firstLine;
  };

  const mermaid = await loadMermaid();
  let parsed: {
    type: string;
    vertices: Array<[string, FlowVertex]>;
    edges: FlowEdge[];
    subgraphs: FlowSubGraph[];
    direction: string;
    classes: Map<string, string[]>;
  };
  try {
    parsed = await exclusive(async () => {
      const diagram = await mermaid.mermaidAPI.getDiagramFromText(body);
      const db = diagram.db as FlowDb;
      if (!diagram.type.startsWith('flowchart')) {
        return {
          type: diagram.type,
          vertices: [],
          edges: [],
          subgraphs: [],
          direction: 'TB',
          classes: new Map(),
        };
      }
      return {
        type: diagram.type,
        vertices: values(db.getVertices()).map(([id, v]) => [id, { ...v }] as [string, FlowVertex]),
        edges: db.getEdges().map((e) => ({ ...e })),
        subgraphs: db.getSubGraphs().map((s) => ({ ...s, nodes: [...s.nodes] })),
        direction: db.getDirection?.() ?? 'TB',
        classes: new Map(
          values(db.getClasses?.()).map(([name, c]) => [name, [...(c.styles ?? [])]]),
        ),
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const at = /line (\d+)/i.exec(message);
    const detail =
      message
        .split('\n')
        .filter((l) => l.trim() && !/^[-\s^]*$/.test(l))
        .slice(-1)[0] ?? message;
    const codeText = at ? (codeLines[Number(at[1]) - 1] ?? '').trim() : '';
    errors.push({
      line: firstLine + (at ? Number(at[1]) - 1 : 0),
      message:
        `flowchart could not read ${codeText ? `"${codeText}"` : 'this block'}. ` +
        `Check brackets, quotes and arrows on this line and the one before. (Mermaid: ${detail.trim()})`,
    });
    return { elements: [], width: 0, height: 0, errors, warnings };
  }
  if (!parsed.type.startsWith('flowchart')) {
    errors.push({
      line: firstLine,
      message: `Mermaid diagram type "${parsed.type}" is not supported; use flowchart or wardley-beta.`,
    });
    return { elements: [], width: 0, height: 0, errors, warnings };
  }

  const graph = new graphlib.Graph({ compound: true, multigraph: true });
  graph.setGraph({
    rankdir: DIRECTIONS[parsed.direction] ?? 'TB',
    nodesep: 50,
    ranksep: 70,
    edgesep: 20,
    marginx: 30,
    marginy: 50,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const clusterIds = new Set(parsed.subgraphs.map((s) => s.id));
  const nodes = new Map<
    string,
    { lines: string[]; shape: string; fill: string; stroke: string; text: string }
  >();
  for (const [id, vertex] of parsed.vertices) {
    if (clusterIds.has(id)) continue;
    const shape = SHAPES[vertex.type ?? 'square'];
    if (!shape)
      warnings.push({
        line: nodeLine(id),
        message: `flowchart: node "${id}" has shape "${vertex.type}", drawn as a rectangle.`,
      });
    const styles = [
      ...(vertex.classes ?? []).flatMap((c) => parsed.classes.get(c) ?? []),
      ...(vertex.styles ?? []),
    ];
    const lines = labelLines(vertex.text, id);
    const labelLength = lines.join(' ').length;
    if (labelLength > NODE_LABEL_MAX_CHARS) {
      warnings.push({
        line: nodeLine(id),
        message:
          `flowchart: node "${id}" has a label of ${labelLength} characters; the box grows ` +
          `with it. Keep labels under ${NODE_LABEL_MAX_CHARS} characters and put details into a text block.`,
      });
    }
    const resolved = shape ?? 'rectangle';
    nodes.set(id, {
      lines,
      shape: resolved,
      fill: cssColour(styles, 'fill') ?? COLOURS.fill,
      stroke: cssColour(styles, 'stroke') ?? COLOURS.stroke,
      text: cssColour(styles, 'color') ?? COLOURS.text,
    });
    graph.setNode(id, nodeSize(lines, resolved));
  }
  for (const subgraph of parsed.subgraphs) {
    graph.setNode(subgraph.id, {});
    for (const member of subgraph.nodes) {
      if (graph.hasNode(member) && member !== subgraph.id) graph.setParent(member, subgraph.id);
    }
  }
  parsed.edges.forEach((edge, index) => {
    if (clusterIds.has(edge.start) || clusterIds.has(edge.end)) return;
    const label = edge.text ? { width: textWidth(edge.text, 14), height: 24, labelpos: 'c' } : {};
    graph.setEdge(edge.start, edge.end, label, `e${index}`);
  });

  layout(graph);
  const { width = 0, height = 0 } = graph.graph() as { width?: number; height?: number };
  const dx = -width / 2;
  const dy = -height / 2;
  const ref = (id: string) => `${refPrefix}-f-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

  const elements: ElementSpec[] = [];
  // Subgraph boxes first, so that their nodes are drawn on top. Outer boxes before inner ones.
  const depth = (id: string): number => {
    const parent = graph.parent(id);
    return parent ? 1 + depth(parent) : 0;
  };
  for (const subgraph of [...parsed.subgraphs].sort((a, b) => depth(a.id) - depth(b.id))) {
    const box = graph.node(subgraph.id) as
      { x?: number; y?: number; width?: number; height?: number } | undefined;
    if (!box || box.x === undefined || box.y === undefined || !box.width || !box.height) continue;
    const top = box.y - box.height / 2 - 36;
    const boxHeight = box.height + 36;
    elements.push({
      type: 'shape',
      ref: ref(subgraph.id),
      shape: 'rectangle',
      content: '',
      x: Math.round(box.x + dx),
      y: Math.round(top + boxHeight / 2 + dy),
      width: Math.round(box.width),
      height: Math.round(boxHeight),
      color: '#F8F9FA',
      borderColor: '#ADB5BD',
      borderWidth: 1,
    });
    elements.push({
      type: 'text',
      content: `<strong>${escapeHtml(subgraph.title || subgraph.id)}</strong>`,
      x: Math.round(box.x + dx),
      y: Math.round(top + 20 + dy),
      width: Math.max(80, Math.round(box.width - 24)),
      fontSize: 16,
      textColor: COLOURS.text,
      textAlign: 'left',
    });
  }

  for (const [id, node] of nodes) {
    const placed = graph.node(id) as { x: number; y: number; width: number; height: number };
    elements.push({
      type: 'shape',
      ref: ref(id),
      shape: node.shape,
      content: node.lines.map(escapeHtml).join('<br>'),
      x: Math.round(placed.x + dx),
      y: Math.round(placed.y + dy),
      width: Math.round(placed.width),
      height: Math.round(placed.height),
      color: node.fill,
      borderColor: node.stroke,
      textColor: node.text,
      fontSize: FONT,
    });
  }

  for (const edge of parsed.edges) {
    if (edge.stroke === 'invisible') continue;
    const known = (id: string) => nodes.has(id) || clusterIds.has(id);
    if (!known(edge.start) || !known(edge.end)) continue;
    const caps = CAPS[edge.type ?? 'arrow_point'] ?? CAPS.arrow_point!;
    if (edge.type?.includes('cross')) {
      warnings.push({
        line: firstLine,
        message: `flowchart: the cross end of ${edge.start} -> ${edge.end} is drawn without a cap.`,
      });
    }
    elements.push({
      type: 'connector',
      from: ref(edge.start),
      to: ref(edge.end),
      shape: 'elbowed',
      startCap: caps.start,
      endCap: caps.end,
      color: COLOURS.edge,
      ...(edge.stroke === 'thick' ? { strokeWidth: 4 } : {}),
      ...(edge.stroke === 'dotted' ? { strokeStyle: 'dotted' } : {}),
      ...(edge.text ? { caption: escapeHtml(labelLines(edge.text, '').join(' ')) } : {}),
    });
  }

  return { elements, width: Math.round(width), height: Math.round(height), errors, warnings };
}
