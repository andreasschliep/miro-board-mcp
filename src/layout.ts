/**
 * Layout warnings: elements that leave their frame or cover the title bar.
 *
 * Found in the first end-to-end run: an agent read toX/toY as absolute end points
 * (they are distances from x/y), and every axis came out diagonal and partly outside
 * its frame. The schema now says so, and this check catches it before anything is
 * built. Coordinates are offsets from the frame centre (generator convention).
 *
 * Warnings, not errors: the spec stays buildable, but validate and preview show them,
 * and the agent is told to fix them first.
 */
import type { ElementSpec, NormalizedBoard } from 'miro-board-builder';

export interface LayoutFinding {
  frame_id: string;
  path: string;
  message: string;
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

export function layoutFindings(board: NormalizedBoard): LayoutFinding[] {
  const findings: LayoutFinding[] = [];
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
