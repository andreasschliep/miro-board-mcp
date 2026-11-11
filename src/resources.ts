/**
 * Resources: read-only context the agent can load before it writes a spec.
 *
 * board-spec://schema   the JSON Schema of the YAML description, from the generator
 * board-spec://example  a complete, valid, fictional spec
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { McpServer } from '@modelcontextprotocol/server';

const require = createRequire(import.meta.url);
const SCHEMA_PATH = require.resolve('miro-board-builder/schema/board.schema.json');
/** Same relative path from src/ (tests) and dist/ (built server). */
const EXAMPLE_PATH = new URL('../examples/code-review-basics.yaml', import.meta.url);

export function registerResources(server: McpServer): void {
  server.registerResource(
    'board-spec-schema',
    'board-spec://schema',
    {
      title: 'Board spec JSON Schema',
      description:
        'JSON Schema of the YAML board description used by validate_board_spec, preview_board ' +
        'and build_board. Read it before writing a spec.',
      mimeType: 'application/schema+json',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/schema+json',
          text: readFileSync(SCHEMA_PATH, 'utf8'),
        },
      ],
    }),
  );

  server.registerResource(
    'board-spec-example',
    'board-spec://example',
    {
      title: 'Example board spec',
      description:
        'A complete, valid spec for a fictional 45-minute workshop: phases, repeat, templates ' +
        'and connectors.',
      mimeType: 'application/yaml',
    },
    (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'application/yaml', text: readFileSync(EXAMPLE_PATH, 'utf8') },
      ],
    }),
  );
}
