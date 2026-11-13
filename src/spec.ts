/**
 * Reading and checking a board spec written by an agent.
 *
 * Order matters:
 * 1. size of the text            (before parsing anything)
 * 2. YAML without !include       (generator option allowInclude: false)
 * 3. node count with aliases     (before the generator copies the document)
 * 4. JSON Schema + semantic checks + text fit (generator)
 * 5. limits and URL policy       (this server)
 * 6. layout warnings             (this server, src/layout.ts)
 */
import { createHash } from 'node:crypto';
import {
  BoardParser,
  validateBoard,
  type ElementSpec,
  type NormalizedBoard,
  type RawBoard,
} from 'miro-board-builder';
import { layoutFindings, type LayoutFinding } from './layout.ts';
import { LIMITS } from './limits.ts';

export type SpecErrorCode =
  'empty' | 'too_large' | 'yaml' | 'include' | 'too_complex' | 'two_sources';

/** The spec cannot be read at all. Everything else is a validation finding. */
export class SpecError extends Error {
  readonly code: SpecErrorCode;
  readonly hint: string;

  constructor(code: SpecErrorCode, message: string, hint: string) {
    super(message);
    this.name = 'SpecError';
    this.code = code;
    this.hint = hint;
  }
}

export interface Finding {
  /** JSON pointer into the spec (after `repeat` expansion), or "line N" for documents. */
  path: string;
  message: string;
  /** Documents only: the Markdown line the finding is about. */
  line?: number;
}

export interface TextFitFinding {
  frame_id: string;
  element_index: number;
  text: string;
  deficit_px: number;
  /** Documents only: the Markdown line of the block the element came from. */
  line?: number;
}

export interface ValidationReport {
  valid: boolean;
  errors: Finding[];
  warnings: Finding[];
  text_fit: TextFitFinding[];
  /** Overlapping frames, elements outside their frame or on the title bar (src/layout.ts). */
  layout: LayoutFinding[];
  summary: { frames: number; spec_elements: number };
}

export interface CheckedSpec {
  report: ValidationReport;
  /** Present when the spec could be normalised. */
  board: NormalizedBoard | null;
}

export interface SpecPolicy {
  allowedUrlHosts: ReadonlySet<string>;
}

const SCHEMA_HINT = 'Read the resource board-spec://schema for the allowed fields.';

/** Steps 1-3: text to raw YAML document, or SpecError. */
export function loadRaw(text: string): RawBoard {
  if (text.trim().length === 0) {
    throw new SpecError(
      'empty',
      'The spec is empty.',
      `Write a YAML board description. ${SCHEMA_HINT}`,
    );
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > LIMITS.specBytes) {
    throw new SpecError(
      'too_large',
      `The spec has ${bytes} bytes; the limit is ${LIMITS.specBytes}.`,
      'Split the workshop into smaller boards or shorten long texts.',
    );
  }

  let raw: RawBoard;
  try {
    raw = new BoardParser({ allowInclude: false }).loadString(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('!include is disabled')) {
      throw new SpecError(
        'include',
        '!include is not allowed in specs sent to this server.',
        'Put the text directly into the spec.',
      );
    }
    throw new SpecError('yaml', `The spec is not valid YAML: ${message}`, 'Fix the YAML syntax.');
  }

  const nodes = countNodes(raw, LIMITS.yamlNodes);
  if (nodes > LIMITS.yamlNodes) {
    throw new SpecError(
      'too_complex',
      `The spec expands to more than ${LIMITS.yamlNodes} YAML nodes.`,
      'Do not use YAML anchors and aliases to repeat content; use `repeat` for lists.',
    );
  }
  return raw;
}

/**
 * Counts nodes the way a deep copy would see them: an alias is counted every time it
 * is referenced. Stops as soon as the limit is passed, so an alias bomb costs nothing.
 */
export function countNodes(value: unknown, limit: number): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0 && count <= limit) {
    const node = stack.pop();
    count++;
    if (Array.isArray(node)) {
      stack.push(...node);
    } else if (node !== null && typeof node === 'object') {
      stack.push(...Object.values(node));
    }
  }
  return count;
}

/** Steps 1-6 for one spec text. Throws SpecError only if the text cannot be read. */
export function checkSpec(text: string, policy: SpecPolicy): CheckedSpec {
  return checkRaw(loadRaw(text), policy);
}

/** Steps 4-6 for a board in the generator's format, from YAML or from a document. */
export function checkRaw(raw: RawBoard, policy: SpecPolicy): CheckedSpec {
  const parser = new BoardParser({ allowInclude: false });

  let board: NormalizedBoard | null = null;
  let normalizeError: string | null = null;
  try {
    board = parser.normalize(raw);
  } catch (error) {
    normalizeError = error instanceof Error ? error.message : String(error);
  }

  // The generator checks the JSON Schema before it looks at the normalised board, so
  // an empty placeholder is enough when normalising failed.
  const result = validateBoard(raw, board ?? { name: '', frames: [], phases: {} });
  const errors = result.errors.map((message) => toFinding(message, board));
  const warnings = result.warnings.map((message) => toFinding(message, board));
  if (normalizeError && errors.length === 0) errors.push({ path: '/', message: normalizeError });

  if (errors.length > 0 || !board) {
    return { report: report(false, errors, warnings, [], [], board), board: null };
  }

  errors.push(...limitFindings(board), ...urlFindings(board, policy));
  const textFit: TextFitFinding[] = result.textFit.map((issue) => ({
    frame_id: issue.frameId,
    element_index: issue.index,
    text: issue.text,
    deficit_px: Math.round(issue.deficit),
  }));
  const layout = layoutFindings(board);
  return {
    report: report(errors.length === 0, errors, warnings, textFit, layout, board),
    board,
  };
}

function report(
  valid: boolean,
  errors: Finding[],
  warnings: Finding[],
  textFit: TextFitFinding[],
  layout: LayoutFinding[],
  board: NormalizedBoard | null,
): ValidationReport {
  return {
    valid,
    errors,
    warnings,
    text_fit: textFit,
    layout,
    summary: { frames: board?.frames.length ?? 0, spec_elements: board ? countElements(board) : 0 },
  };
}

/** The generator reports "<instancePath> <message>" for schema errors, plain text otherwise. */
function toFinding(message: string, board: NormalizedBoard | null): Finding {
  const schema = /^(\(root\)|\/\S*) (.+)$/.exec(message);
  if (schema && schema[1] && schema[2]) {
    return { path: schema[1] === '(root)' ? '/' : schema[1], message: schema[2] };
  }
  const frameId = /Frame '([^']+)'/.exec(message)?.[1] ?? /frame id: (\S+)/.exec(message)?.[1];
  const index = frameId && board ? board.frames.findIndex((frame) => frame.id === frameId) : -1;
  return { path: index >= 0 ? `/frames/${index}` : '/', message };
}

function* walkElements(
  elements: ElementSpec[] | undefined,
  path: string,
): Generator<{ element: ElementSpec; path: string }> {
  for (const [index, element] of (elements ?? []).entries()) {
    const here = `${path}/${index}`;
    yield { element, path: here };
    if (element.items) yield* walkElements(element.items, `${here}/items`);
  }
}

function countElements(board: NormalizedBoard): number {
  let count = 0;
  for (const [index, frame] of board.frames.entries()) {
    count += [...walkElements(frame.elements, `/frames/${index}/elements`)].length;
  }
  return count;
}

function limitFindings(board: NormalizedBoard): Finding[] {
  const findings: Finding[] = [];
  if (board.frames.length > LIMITS.frames) {
    findings.push({
      path: '/frames',
      message: `${board.frames.length} frames; the limit is ${LIMITS.frames}. Split the board.`,
    });
  }
  const elements = countElements(board);
  if (elements > LIMITS.elements) {
    findings.push({
      path: '/frames',
      message: `${elements} elements after repeat expansion; the limit is ${LIMITS.elements}.`,
    });
  }
  return findings;
}

/** image and embed place external content on the board: https and allowed hosts only. */
function urlFindings(board: NormalizedBoard, policy: SpecPolicy): Finding[] {
  const findings: Finding[] = [];
  for (const [index, frame] of board.frames.entries()) {
    for (const { element, path } of walkElements(frame.elements, `/frames/${index}/elements`)) {
      if (element.type !== 'image' && element.type !== 'embed') continue;
      const host = httpsHost(element.url);
      if (!host) {
        findings.push({ path: `${path}/url`, message: `${element.type} needs an https URL.` });
      } else if (!policy.allowedUrlHosts.has(host)) {
        findings.push({
          path: `${path}/url`,
          message:
            `${element.type} URLs on host '${host}' are not allowed. ` +
            'Leave the element out, or ask the user to add the host to MIRO_MCP_ALLOWED_URL_HOSTS.',
        });
      }
    }
  }
  return findings;
}

function httpsHost(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Fingerprint of a normalised board: SHA-256 over JSON with sorted keys, so the same
 * content always gives the same hash. build_board only writes when the agent passes
 * the hash the preview showed (design decision D4).
 */
export function specHash(board: NormalizedBoard): string {
  return `sha256:${createHash('sha256').update(canonicalJson(board)).digest('hex')}`;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
