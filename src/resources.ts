/**
 * Resources: read-only context the agent can load before it writes a board.
 *
 * board-doc://guide     the Markdown format: frames, text, stickies, Mermaid diagrams
 * board-doc://example   a complete, valid, fictional board document
 * board-spec://schema   advanced: JSON Schema of the generator's YAML spec
 * board-spec://example  advanced: the same kind of workshop as a YAML spec
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { McpServer } from '@modelcontextprotocol/server';

const require = createRequire(import.meta.url);
const SCHEMA_PATH = require.resolve('miro-board-builder/schema/board.schema.json');
/** Same relative paths from src/ (tests) and dist/ (built server). */
const GUIDE_PATH = new URL('../resources/board-document-guide.md', import.meta.url);
const DOC_EXAMPLE_PATH = new URL('../examples/code-review-basics.md', import.meta.url);
const SPEC_EXAMPLE_PATH = new URL('../examples/code-review-basics.yaml', import.meta.url);

function fileResource(
  server: McpServer,
  name: string,
  uri: string,
  meta: { title: string; description: string; mimeType: string },
  path: URL | string,
): void {
  server.registerResource(name, uri, meta, (requested) => ({
    contents: [{ uri: requested.href, mimeType: meta.mimeType, text: readFileSync(path, 'utf8') }],
  }));
}

export function registerResources(server: McpServer): void {
  fileResource(
    server,
    'board-doc-guide',
    'board-doc://guide',
    {
      title: 'Board document format',
      description:
        'How to write a board as Markdown: one "## Heading" per frame, text, sticky notes, and ' +
        'Mermaid flowcharts and Wardley maps. Read it before writing a board.',
      mimeType: 'text/markdown',
    },
    GUIDE_PATH,
  );
  fileResource(
    server,
    'board-doc-example',
    'board-doc://example',
    {
      title: 'Example board document',
      description: 'A complete, valid board document for a fictional 45-minute workshop.',
      mimeType: 'text/markdown',
    },
    DOC_EXAMPLE_PATH,
  );
  fileResource(
    server,
    'board-spec-schema',
    'board-spec://schema',
    {
      title: 'Board spec JSON Schema (advanced)',
      description:
        'Only for the spec parameter: JSON Schema of the YAML format with exact coordinates. ' +
        'Use a Markdown document unless the user asks for exact positions.',
      mimeType: 'application/schema+json',
    },
    SCHEMA_PATH,
  );
  fileResource(
    server,
    'board-spec-example',
    'board-spec://example',
    {
      title: 'Example board spec (advanced)',
      description: 'The fictional workshop as a YAML spec with exact coordinates.',
      mimeType: 'application/yaml',
    },
    SPEC_EXAMPLE_PATH,
  );
}
