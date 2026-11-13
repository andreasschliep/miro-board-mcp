/**
 * Document model to the generator's board format.
 *
 * The server decides every position (design section 15): frames side by side with a
 * fixed gap, each sized to its content; inside a frame the blocks stack from the top.
 * The agent writes no coordinates, so the error classes of the first two end-to-end
 * runs (line offsets, frame spacing) cannot occur in documents.
 */
import { estimateRequiredHeight, type ElementSpec, type RawBoard } from 'miro-board-builder';
import { TITLE_BAR_HEIGHT } from '../layout.ts';
import { flowchartDiagram } from './flowchart.ts';
import { isMermaidKind, mermaidKind } from './mermaid.ts';
import { parseDocument } from './markdown.ts';
import { slug, type Block, type Diagram, type DocFinding } from './model.ts';
import { wardleyDiagram } from './wardley.ts';

export const FRAME_LAYOUT = {
  padding: 60,
  blockGap: 40,
  frameGap: 300,
  minWidth: 1600,
  minHeight: 900,
  textFontSize: 20,
  maxTextWidth: 1400,
  sticky: { width: 220, cellWidth: 250, cellHeight: 280 },
} as const;

export interface ComposedBoard {
  raw: RawBoard;
  /** Line of each frame heading, by frame index. */
  frameLines: number[];
  /** Source line of each element, keyed by its path in the board ("/frames/0/elements/3"). */
  elementLines: Map<string, number>;
  errors: DocFinding[];
  warnings: DocFinding[];
}

type Placed =
  | { block: Block; kind: 'text'; height: number; width: number }
  | { block: Block; kind: 'stickies'; height: number; width: number; columns: number }
  | { block: Block; kind: 'diagram'; height: number; width: number; diagram: Diagram };

export async function composeDocument(markdown: string): Promise<ComposedBoard> {
  const model = parseDocument(markdown);
  const errors = [...model.errors];
  const warnings = [...model.warnings];
  const frameLines: number[] = [];
  const elementLines = new Map<string, number>();
  const usedIds = new Set<string>();
  const frames: Array<Record<string, unknown>> = [];
  let cursorX = 0;

  for (const [frameIndex, frame] of model.frames.entries()) {
    let id = slug(frame.title);
    for (let n = 2; usedIds.has(id); n++) id = `${slug(frame.title).slice(0, 36)}-${n}`;
    usedIds.add(id);

    // Diagrams first: they decide how wide the frame gets.
    const diagrams = new Map<Block, Diagram>();
    for (const [index, block] of frame.blocks.entries()) {
      if (block.kind !== 'mermaid') continue;
      const kind = mermaidKind(block.code);
      const refPrefix = `${id}-${index}`;
      let diagram: Diagram;
      if (kind === 'wardley') diagram = await wardleyDiagram(block.code, block.codeLine, refPrefix);
      else if (kind === 'flowchart')
        diagram = await flowchartDiagram(block.code, block.codeLine, refPrefix);
      else {
        diagram = { elements: [], width: 0, height: 0, warnings: [], errors: [] };
        errors.push({
          line: block.line,
          message: isMermaidKind(kind)
            ? `Mermaid "${kind}" is not supported; use flowchart or wardley-beta.`
            : 'this Mermaid block has no diagram type; start it with "flowchart TD" or "wardley-beta".',
        });
      }
      errors.push(...diagram.errors);
      warnings.push(...diagram.warnings);
      diagrams.set(block, diagram);
    }

    const widest = Math.max(0, ...[...diagrams.values()].map((d) => d.width));
    const contentWidth = Math.max(FRAME_LAYOUT.minWidth - 2 * FRAME_LAYOUT.padding, widest);
    const textWidth = Math.min(contentWidth, FRAME_LAYOUT.maxTextWidth);
    const { sticky } = FRAME_LAYOUT;

    const placed: Placed[] = frame.blocks.flatMap((block): Placed[] => {
      if (block.kind === 'text') {
        const height = estimateRequiredHeight(block.html, {
          fontSize: FRAME_LAYOUT.textFontSize,
          width: textWidth,
        });
        return [{ block, kind: 'text', height, width: textWidth }];
      }
      if (block.kind === 'stickies') {
        const columns = Math.max(
          1,
          Math.floor((contentWidth + (sticky.cellWidth - sticky.width)) / sticky.cellWidth),
        );
        const rows = Math.ceil(block.items.length / columns);
        return [
          {
            block,
            kind: 'stickies',
            height: rows * sticky.cellHeight - 28,
            width: contentWidth,
            columns,
          },
        ];
      }
      const diagram = diagrams.get(block);
      if (!diagram || diagram.elements.length === 0) return [];
      return [{ block, kind: 'diagram', height: diagram.height, width: diagram.width, diagram }];
    });

    const contentHeight =
      placed.reduce((sum, p) => sum + p.height, 0) +
      FRAME_LAYOUT.blockGap * Math.max(0, placed.length - 1);
    const width = Math.round(contentWidth + 2 * FRAME_LAYOUT.padding);
    const height = Math.round(
      Math.max(FRAME_LAYOUT.minHeight, TITLE_BAR_HEIGHT + 2 * FRAME_LAYOUT.padding + contentHeight),
    );
    const left = -width / 2 + FRAME_LAYOUT.padding;
    let cursorY = -height / 2 + TITLE_BAR_HEIGHT + FRAME_LAYOUT.padding;

    const elements: ElementSpec[] = [];
    const add = (element: ElementSpec, line: number) => {
      elementLines.set(`/frames/${frameIndex}/elements/${elements.length}`, line);
      elements.push(element);
    };

    for (const item of placed) {
      if (item.kind === 'text' && item.block.kind === 'text') {
        add(
          {
            type: 'text',
            content: item.block.html,
            x: Math.round(left + item.width / 2),
            y: Math.round(cursorY + item.height / 2),
            width: Math.round(item.width),
            fontSize: FRAME_LAYOUT.textFontSize,
            textAlign: 'left',
          },
          item.block.line,
        );
      } else if (item.kind === 'stickies' && item.block.kind === 'stickies') {
        item.block.items.forEach((content, index) => {
          const column = index % item.columns;
          const row = Math.floor(index / item.columns);
          add(
            {
              type: 'sticky',
              content,
              x: Math.round(left + sticky.width / 2 + column * sticky.cellWidth),
              y: Math.round(cursorY + (sticky.cellHeight - 28) / 2 + row * sticky.cellHeight),
              width: sticky.width,
              color: 'light_yellow',
            },
            item.block.line,
          );
        });
      } else if (item.kind === 'diagram') {
        const centreY = cursorY + item.height / 2;
        for (const element of item.diagram.elements) {
          const shifted =
            typeof element.x === 'number' && typeof element.y === 'number'
              ? { ...element, x: Math.round(element.x), y: Math.round(element.y + centreY) }
              : element;
          add(shifted, item.diagram.sourceLines?.get(element) ?? item.block.line);
        }
      }
      cursorY += item.height + FRAME_LAYOUT.blockGap;
    }

    frames.push({
      id,
      title: frame.title,
      x: Math.round(cursorX + width / 2),
      y: Math.round(height / 2),
      width,
      height,
      elements,
    });
    frameLines.push(frame.line);
    cursorX += width + FRAME_LAYOUT.frameGap;
  }

  return { raw: { name: model.name, frames }, frameLines, elementLines, errors, warnings };
}
