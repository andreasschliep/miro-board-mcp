/**
 * Checking a board document: Markdown to the generator's format, then the same checks
 * as for a YAML spec (src/spec.ts). Findings are moved from JSON paths to Markdown
 * lines, because the agent never sees the generated board.
 */
import { LIMITS } from '../limits.ts';
import { checkRaw, SpecError, type CheckedSpec, type Finding, type SpecPolicy } from '../spec.ts';
import { composeDocument } from './compose.ts';
import type { DocFinding } from './model.ts';

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

  const composed = await composeDocument(markdown);
  const checked = checkRaw(composed.raw, policy);
  const frameIds = (composed.raw.frames as Array<{ id: string }>).map((frame) => frame.id);

  const lineFor = (path: string): number | undefined => {
    const element = /^\/frames\/\d+\/elements\/\d+/.exec(path)?.[0];
    if (element && composed.elementLines.has(element)) return composed.elementLines.get(element);
    const frame = /^\/frames\/(\d+)/.exec(path)?.[1];
    return frame === undefined ? undefined : composed.frameLines[Number(frame)];
  };
  const fromDoc = (f: DocFinding): Finding => ({
    path: `line ${f.line}`,
    message: f.message,
    line: f.line,
  });
  const located = (f: Finding): Finding => {
    const line = lineFor(f.path);
    return line ? { path: `line ${line}`, message: f.message, line } : f;
  };

  const report = checked.report;
  const errors = [...composed.errors.map(fromDoc), ...report.errors.map(located)];
  const warnings = [...composed.warnings.map(fromDoc), ...report.warnings.map(located)];
  const layout = report.layout.map((finding) => {
    const line = lineFor(finding.path);
    return line ? { ...finding, line } : finding;
  });
  const textFit = report.text_fit.map((finding) => {
    const frame = frameIds.indexOf(finding.frame_id);
    // The generator counts the title bar it adds as element 0.
    const line =
      composed.elementLines.get(`/frames/${frame}/elements/${finding.element_index - 1}`) ??
      composed.frameLines[frame];
    return line ? { ...finding, line } : finding;
  });

  const valid = report.valid && errors.length === 0;
  return {
    report: { ...report, valid, errors, warnings, layout, text_fit: textFit },
    board: valid ? checked.board : null,
  };
}
