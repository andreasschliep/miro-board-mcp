#!/usr/bin/env node
/**
 * miro-board-mcp: MCP server over stdio.
 *
 * stdout carries JSON-RPC messages only. Everything else (startup, errors, build
 * progress for humans) goes to stderr through src/logger.ts.
 */
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { defaultDeps, type ServerDeps } from './deps.ts';
import { registerPrompts } from './prompts.ts';
import { registerResources } from './resources.ts';
import { registerBuildBoard } from './tools/build.ts';
import { registerListFrames } from './tools/listFrames.ts';
import { registerPreviewBoard } from './tools/preview.ts';
import { registerValidateBoard } from './tools/validate.ts';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const INSTRUCTIONS =
  'Builds Miro boards from a Markdown document: one "## Heading" per frame, text, bullet lists ' +
  'as sticky notes, Mermaid flowcharts and Wardley maps. The server places everything. Order: ' +
  'read board-doc://guide, write the document, validate_board until valid, preview_board, show ' +
  'the preview to the user, and call build_board with dry_run: false and confirm_hash only ' +
  'after the user confirms.';

export function createServer(deps: ServerDeps = defaultDeps()): McpServer {
  const server = new McpServer({ name: 'miro-board-mcp', version }, { instructions: INSTRUCTIONS });
  registerValidateBoard(server, deps);
  registerPreviewBoard(server, deps);
  registerBuildBoard(server, deps);
  registerListFrames(server, deps);
  registerResources(server);
  registerPrompts(server);
  return server;
}

async function main(): Promise<void> {
  const deps = defaultDeps();
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
  deps.logger.log(
    `v${version} ready on stdio; Miro token ${deps.config.token ? 'configured' : 'not set'}`,
  );
}

/** True when this file is the process entry point (not imported by a test). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    console.error('miro-board-mcp failed to start:', error);
    process.exit(1);
  });
}
