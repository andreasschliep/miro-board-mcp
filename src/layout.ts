/**
 * Layout warnings: frames that overlap, elements that leave their frame or cover the
 * title bar.
 *
 * Found in the first end-to-end run: an agent read toX/toY as absolute end points
 * (they are distances from x/y), and every axis came out diagonal and partly outside
 * its frame. Found in the second: an agent read layout.frameSpacing and rowSpacing as
 * gaps (they are distances between frame centres), and four 3000-wide frames landed
 * 300 apart, on top of each other. The schema now explains both, and these checks
 * catch them before anything is built. Element coordinates are offsets from the frame
 * centre; frame positions are board coordinates of the frame centre (generator
 * convention).
 *
 * Warnings, not errors: the spec stays buildable, but validate and preview show them,
 * and the agent is told to fix them first.
 */
import type { ElementSpec, NormalizedBoard } from 'miro-board-builder';

export interface LayoutFinding {
  frame_id: string;
  path: string;
  message: string;
  /** Documents only: the Markdown line of the frame or block. */
  line?: number;
}

/** Height of the title bar the generator draws at the top of every frame. */
export const TITLE_BAR_HEIGHT = 60;

/** Sizes the generator or Miro use when the spec gives none. */
const DEFAULT_WIDTH: Record<string, number> = {
  text: 300,
  shape: 200,
  sticky: 200,
  card: 320,
  image: 400,
  embed: 480,
  divider: 400,
};
const DEFAULT_HEIGHT: Record<string, number> = { shape: 100, sticky: 230 };

interface Bounds {
  halfW: number;
  halfH: number;
  /** y below which the title bar ends; null when the frame has no title bar. */
  titleBarBottom: number | null;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function outside(x: number, y: number, b: Bounds): boolean {
  return x < -b.halfW || x > b.halfW || y < -b.halfH || y > b.halfH;
}

function range(b: Bounds): string {
  return `x ${-b.halfW}..${b.halfW}, y ${-b.halfH}..${b.halfH}`;
}

function checkElement(
  element: ElementSpec,
  offset: { x: number; y: number },
  b: Bounds,
): string | null {
  const x = (num(element.x) ?? 0) + offset.x;
  const y = (num(element.y) ?? 0) + offset.y;

  if (element.type === 'line') {
    const endX = x + (num(element.toX) ?? 0);
    const endY = y + (num(element.toY) ?? 0);
    if (outside(x, y, b) || outside(endX, endY, b)) {
      return (
        `line runs from (${x}, ${y}) to (${endX}, ${endY}), outside the frame (${range(b)}). ` +
        'toX and toY are distances from x and y, not absolute positions.'
      );
    }
    if (b.titleBarBottom !== null && Math.min(y, endY) < b.titleBarBottom) {
      return `line reaches into the title bar (the top ${TITLE_BAR_HEIGHT} units of the frame).`;
    }
    return null;
  }

  const width = num(element.width) ?? DEFAULT_WIDTH[element.type];
  const height = num(element.height) ?? DEFAULT_HEIGHT[element.type];
  const left = width ? x - width / 2 : x;
  const right = width ? x + width / 2 : x;
  const top = height ? y - height / 2 : y;
  const bottom = height ? y + height / 2 : y;

  const beyond = Math.max(-b.halfW - left, right - b.halfW, -b.halfH - top, bottom - b.halfH);
  if (beyond > 0) {
    return `${element.type} extends ${Math.round(beyond)} units beyond the frame edge (${range(b)}).`;
  }
  if (b.titleBarBottom !== null && top < b.titleBarBottom) {
    return `${element.type} overlaps the title bar (the top ${TITLE_BAR_HEIGHT} units of the frame).`;
  }
  return null;
}

/** Gap between frames that the overlap message suggests. */
export const SUGGESTED_FRAME_GAP = 200;

/**
 * Every pair of frames whose rectangles overlap. Frames that only touch are fine.
 * The finding sits on the later frame of the pair.
 */
function frameOverlaps(board: NormalizedBoard): LayoutFinding[] {
  const findings: LayoutFinding[] = [];
  const frames = board.frames;
  if (frames.length < 2) return findings;

  const maxW = Math.max(...frames.map((f) => f.width));
  const maxH = Math.max(...frames.map((f) => f.height));
  const hint =
    'layout.frameSpacing and layout.rowSpacing are distances between frame centres, not gaps; ' +
    `for frames of ${maxW} x ${maxH}, frameSpacing ${maxW + SUGGESTED_FRAME_GAP} and rowSpacing ` +
    `${maxH + SUGGESTED_FRAME_GAP} leave a gap of ${SUGGESTED_FRAME_GAP}.`;

  for (const [j, later] of frames.entries()) {
    for (const earlier of frames.slice(0, j)) {
      const overlapX =
        Math.min(later.x + later.width / 2, earlier.x + earlier.width / 2) -
        Math.max(later.x - later.width / 2, earlier.x - earlier.width / 2);
      const overlapY =
        Math.min(later.y + later.height / 2, earlier.y + earlier.height / 2) -
        Math.max(later.y - later.height / 2, earlier.y - earlier.height / 2);
      if (overlapX > 0 && overlapY > 0) {
        findings.push({
          frame_id: later.id,
          path: `/frames/${j}`,
          message:
            `frame overlaps frame "${earlier.id}" by ${Math.round(overlapX)} x ` +
            `${Math.round(overlapY)} units (centres at (${earlier.x}, ${earlier.y}) and ` +
            `(${later.x}, ${later.y})). ${hint}`,
        });
      }
    }
  }
  return findings;
}

export function layoutFindings(board: NormalizedBoard): LayoutFinding[] {
  // Overlapping frames first: they break the whole board, not one element.
  const findings: LayoutFinding[] = frameOverlaps(board);
  const style = (board.style ?? {}) as { headerBar?: boolean };

  for (const [index, frame] of board.frames.entries()) {
    const hasTitleBar = style.headerBar !== false && frame.headerBar !== false;
    const bounds: Bounds = {
      halfW: frame.width / 2,
      halfH: frame.height / 2,
      titleBarBottom: hasTitleBar ? -frame.height / 2 + TITLE_BAR_HEIGHT : null,
    };

    const walk = (
      elements: ElementSpec[] | undefined,
      path: string,
      offset: { x: number; y: number },
    ) => {
      for (const [i, element] of (elements ?? []).entries()) {
        const here = `${path}/${i}`;
        if (element.type === 'group') {
          // Group items are positioned relative to the group's offset.
          const groupOffset = {
            x: offset.x + (num(element.x) ?? 0),
            y: offset.y + (num(element.y) ?? 0),
          };
          walk(element.items, `${here}/items`, groupOffset);
          continue;
        }
        if (element.type === 'connector') continue;
        const message = checkElement(element, offset, bounds);
        if (message) findings.push({ frame_id: frame.id, path: here, message });
      }
    };
    walk(frame.elements, `/frames/${index}/elements`, { x: 0, y: 0 });
  }
  return findings;
}
