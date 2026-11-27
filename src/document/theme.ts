/**
 * Looks a board document can choose with `theme:` in its front matter (design D19).
 *
 * The default look has no entry here: it is the frame layout in compose.ts and must not
 * change. `slides` is the slide style of the focus-topic webinars, measured on a
 * reference board through the Miro REST API. Every colour, font, size and position of
 * that look lives in this one object; the composer reads them from here.
 *
 * Positions are offsets from the frame centre (generator convention).
 */

export type ThemeName = 'default' | 'slides';

export const THEME_NAMES: readonly ThemeName[] = ['default', 'slides'];

/** A logo in the footer of every content slide. */
export interface LogoPlacement {
  /** Centre of the logo. */
  x: number;
  y: number;
  /** Miro keeps the aspect ratio; only the width is set. */
  width: number;
}

export const SLIDES = {
  /** AME3 slide size, about A4 landscape. Fixed: frames do not grow with their content. */
  frame: { width: 6078, height: 4332, gap: 800 },
  fills: { title: '#ffffff', content: '#010101' },
  fonts: { title: 'open_sans', content: 'arial' },
  /** Content must stay this far from the frame edges, and above the footer line. */
  safe: { margin: 330, footerTop: 1800 },

  /** Title slide: everything centred; kicker and title bold, tagline italic. */
  titleSlide: {
    kicker: { color: '#EA8125', fontSize: 130, width: 3000, y: -1266, emphasis: 'strong' },
    title: { color: '#1A1A1A', fontSize: 300, width: 5600, y: -566, emphasis: 'strong' },
    bar: { color: '#EA8125', width: 1400, height: 36, y: -86 },
    subtitle: { color: '#333333', fontSize: 240, width: 5600, y: 284, emphasis: null },
    tagline: { color: '#555555', fontSize: 170, width: 5600, y: 684, emphasis: 'em' },
    byline: { color: '#555555', fontSize: 150, width: 5600, y: 1634, emphasis: null },
    /** Smallest gap between two texts on the title slide. */
    minGap: 40,
  },

  /** Content slides: heading top left, blocks below it. */
  heading: { color: '#BC7AF5', fontSize: 190, gapBelow: 160, emphasis: 'strong' },
  text: { color: '#FFFFFF', fontSize: 140, maxWidth: 5200 },
  blockGap: 120,
  /** A frame whose only block is a quote: one sentence, centred. */
  statement: { color: '#FFFFFF', fontSize: 380, width: 5300 },
  /** List items: dark cards in the AME3 style. */
  card: {
    fill: '#151515',
    border: '#FFFFFF',
    borderWidth: 2,
    text: '#FFFFFF',
    fontSize: 70,
    maxColumns: 3,
    gap: 120,
    minHeight: 300,
  },
  /** Task items ("- [ ]"): sticky notes as templates for participants. */
  sticky: { color: 'light_yellow', width: 640, heightRatio: 228 / 199, gap: 100 },
  /** Flowcharts: AME3 step style; classDef colours are kept. Scaled to the free space. */
  flowchart: {
    node: { fill: '#151515', stroke: '#FFFFFF', text: '#FFFFFF' },
    edge: '#FFFFFF',
    caption: '#FFFFFF',
    subgraph: { fill: '#010101', border: '#FFFFFF', text: '#FFFFFF' },
    minScale: 2,
    maxScale: 4,
  },
  /** Wardley maps keep their own colours and get a white panel behind them. */
  wardley: { panel: '#FFFFFF', padding: 60, minScale: 1.5, maxScale: 3.5 },
  /**
   * Footer logos, measured on the reference: 523 x 259 at (-2710, 2002) and 731 x 330 at
   * (2674, 2001). The right one sits 1 unit further left, because at 2674 it would end
   * half a unit outside the frame.
   */
  logos: {
    left: { x: -2710, y: 2002, width: 523 } satisfies LogoPlacement,
    right: { x: 2673, y: 2001, width: 731 } satisfies LogoPlacement,
  },
} as const;

/** Where a slide logo comes from: server configuration, never the document. */
export type LogoSource =
  | { env: string; kind: 'file'; value: string }
  | { env: string; kind: 'url'; value: string }
  | { env: string; kind: 'invalid'; value: string; reason: string };

export interface SlideLogos {
  left?: LogoSource;
  right?: LogoSource;
}

export const LOGO_ENV = { left: 'MIRO_SLIDE_LOGO_LEFT', right: 'MIRO_SLIDE_LOGO_RIGHT' } as const;
