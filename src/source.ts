/**
 * The board a tool call is about: a Markdown document (the normal case) or, for
 * exact positions, a YAML spec in the generator's format (design section 15.5).
 */
import { checkDocument } from './document/check.ts';
import { checkSpec, SpecError, type CheckedSpec, type SpecPolicy } from './spec.ts';

export interface SourceInput {
  document?: string | undefined;
  spec?: string | undefined;
}

export async function checkSource(input: SourceInput, policy: SpecPolicy): Promise<CheckedSpec> {
  if (input.document !== undefined && input.spec !== undefined) {
    throw new SpecError(
      'two_sources',
      'Pass either document or spec, not both.',
      'Use document (Markdown); spec is only for exact positions the user asked for.',
    );
  }
  if (input.spec !== undefined) return checkSpec(input.spec, policy);
  if (input.document !== undefined) return checkDocument(input.document, policy);
  throw new SpecError(
    'empty',
    'No board was passed.',
    'Pass the board as document: Markdown, one "## Heading" per frame. Read board-doc://guide.',
  );
}
