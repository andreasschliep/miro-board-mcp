/**
 * Checking a board document: Markdown to the generator's format, then the same checks
 * as for a YAML spec (src/spec.ts). Findings are moved from JSON paths to Markdown
 * lines, because the agent never sees the generated board.
 */
import { LIMITS } from '../limits.ts';
import { checkRaw, SpecError, type CheckedSpec, type Finding, type SpecPolicy } from '../spec.ts';
import { composeDocument } from './compose.ts';
import type { DocFinding } from './model.ts';

function fromDoc(f: DocFinding): Finding {
  return { path: `line ${f.line}`, message: f.message, line: f.line };
}

export const GUIDE_HINT = 'Read the resource board-doc://guide for the format.';

export async function checkDocument(markdown: string, policy: SpecPolicy): Promise<CheckedSpec> {
  if (markdown.trim().length === 0) {
    throw new SpecError(
      'empty',
      'The document is empty.',
      `Write Markdown: "# Board name", then one "## Heading" per frame. ${GUIDE_HINT}`,
    );
  }
  const bytes = Buffer.byteLength(markdown, 'utf8');
  if (bytes > LIMITS.specBytes) {
    throw new SpecError(
      'too_large',
      `The document has ${bytes} bytes; the limit is ${LIMITS.specBytes}.`,
      'Split the workshop into smaller boards or shorten long texts.',
    );
  }

  const composed = await composeDocument(markdown, { slideLogos: policy.slideLogos });
  const byLine = (a: Finding, b: Finding) => (a.line ?? 0) - (b.line ?? 0);
  if ((composed.raw.frames as unknown[]).length === 0) {
    // Nothing to build: the document findings say why; the generator's schema errors
    // about an empty frame list would only repeat it without a line.
    return {
      report: {
        valid: false,
        errors: composed.errors.map(fromDoc).sort(byLine),
        warnings: composed.warnings.map(fromDoc).sort(byLine),
        text_fit: [],
        layout: [],
        summary: { frames: 0, spec_elements: 0 },
      },
      board: null,
    };
  }
  const checked = checkRaw(composed.raw, policy);
  const frameIds = (composed.raw.frames as Array<{ id: string }>).map((frame) => frame.id);

  const lineFor = (path: string): number | undefined => {
    const element = /^\/frames\/\d+\/elements\/\d+/.exec(path)?.[0];
    if (element && composed.elementLines.has(element)) return composed.elementLines.get(element);
    const frame = /^\/frames\/(\d+)/.exec(path)?.[1];
    return frame === undefined ? undefined : composed.frameLines[Number(frame)];
  };
  const located = (f: Finding): Finding => {
    const line = lineFor(f.path);
    return line ? { path: `line ${line}`, message: f.message, line } : f;
  };

  const report = checked.report;
  const errors = [...composed.errors.map(fromDoc), ...report.errors.map(located)].sort(byLine);
  const warnings = [...composed.warnings.map(fromDoc), ...report.warnings.map(located)].sort(
    byLine,
  );
  const notes = composed.layout.map((note) => ({
    frame_id: frameIds[note.frameIndex] ?? '',
    path: `line ${note.line}`,
    message: note.message,
    line: note.line,
  }));
  // A slide that is too full also has elements beyond its edge; one message is enough.
  const full = new Set(notes.map((note) => note.frame_id));
  const layout = [
    ...notes,
    ...report.layout
      .filter((finding) => !full.has(finding.frame_id))
      .map((finding) => {
        const line = lineFor(finding.path);
        return line ? { ...finding, path: `line ${line}`, line } : finding;
      }),
  ].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  // The generator counts the title bar it adds as element 0, when there is one.
  const titleBar = (composed.raw.style as { headerBar?: boolean } | undefined)?.headerBar !== false;
  const textFit = report.text_fit.map((finding) => {
    const frame = frameIds.indexOf(finding.frame_id);
    const index = finding.element_index - (titleBar ? 1 : 0);
    const line =
      composed.elementLines.get(`/frames/${frame}/elements/${index}`) ?? composed.frameLines[frame];
    return line ? { ...finding, line } : finding;
  });

  const valid = report.valid && errors.length === 0;
  return {
    report: { ...report, valid, errors, warnings, layout, text_fit: textFit },
    board: valid ? checked.board : null,
  };
}
