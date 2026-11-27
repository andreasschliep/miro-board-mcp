/**
 * The board document: Markdown with Mermaid blocks (design section 15).
 *
 * The agent writes this; the server turns it into the generator's board format,
 * which stays internal. Every finding carries the Markdown line it is about.
 */
import type { ElementSpec } from 'miro-board-builder';
import type { ThemeName } from './theme.ts';

export interface DocFinding {
  /** 1-based line in the Markdown document. */
  line: number;
  message: string;
}

export type Block =
  /**
   * Paragraphs, sub-headings and quotes, already converted to the simple HTML Miro accepts.
   * `quote` is set while the block holds nothing but quotes: their HTML without the
   * italics, for a statement slide (theme slides).
   */
  | { kind: 'text'; line: number; html: string; quote?: string }
  /**
   * One sticky note per list item. `tasks` marks task items ("- [ ]", "- [x]"): the
   * default look ignores it, theme slides draws only those as sticky notes.
   */
  | { kind: 'stickies'; line: number; items: string[]; tasks: boolean[] }
  /** A Mermaid diagram; codeLine is the document line of the first line of code. */
  | { kind: 'mermaid'; line: number; codeLine: number; code: string };

export interface DocFrame {
  title: string;
  /** The heading as inline HTML (bold, links), for themes that draw it. */
  html: string;
  /** Line of the "##" heading; for the intro frame the line of its first block. */
  line: number;
  blocks: Block[];
}

/** Front matter fields the title slide of theme slides is made of. */
export interface TitleSlideFields {
  kicker?: string;
  subtitle?: string;
  tagline?: string;
  byline?: string;
}

export interface DocModel {
  name: string;
  /** From the front matter; "default" when none is given. */
  theme: ThemeName;
  /** Line of the "theme:" key in the front matter, or 1. */
  themeLine: number;
  titleSlide: TitleSlideFields;
  frames: DocFrame[];
  errors: DocFinding[];
  warnings: DocFinding[];
}

/** A diagram laid out around its own centre (0, 0), ready to be placed in a frame. */
export interface Diagram {
  elements: ElementSpec[];
  width: number;
  height: number;
  errors: DocFinding[];
  warnings: DocFinding[];
  /** Document line of the statement each element came from, when the diagram knows it. */
  sourceLines?: Map<ElementSpec, number>;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c] ?? c);
}

const UMLAUTS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** Frame ids must match ^[a-z0-9_-]+$ (generator schema). */
export function slug(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => UMLAUTS[c] ?? c)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'frame';
}

/** Width of a single-line text in board units, close to Miro's rendering at that size. */
export function textWidth(text: string, fontSize: number): number {
  return Math.ceil(text.length * fontSize * 0.6 + fontSize * 1.2);
}
