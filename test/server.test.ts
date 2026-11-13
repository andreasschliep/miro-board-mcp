/**
 * Protocol test: starts the real server as a child process over stdio and talks to it
 * with the official MCP client. If anything other than JSON-RPC reached stdout, the
 * client could not parse the stream and these tests would fail.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { VALID_SPEC } from './helpers.ts';

const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));
let client: Client;

before(async () => {
  client = new Client({ name: 'protocol-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      // No token: the test must not be able to reach Miro, even by mistake.
      env: { PATH: process.env.PATH ?? '' },
      stderr: 'ignore',
    }),
  );
});

after(async () => {
  await client.close();
});

test('lists the four tools with their annotations', async () => {
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), [
    'build_board',
    'list_frames',
    'preview_board',
    'validate_board',
  ]);
  assert.equal(byName.validate_board?.annotations?.readOnlyHint, true);
  assert.equal(byName.preview_board?.annotations?.readOnlyHint, true);
  assert.equal(byName.build_board?.annotations?.readOnlyHint, false);
  assert.equal(byName.build_board?.annotations?.idempotentHint, false);
  assert.equal(byName.build_board?.annotations?.openWorldHint, true);
  assert.equal(byName.list_frames?.annotations?.openWorldHint, true);
  assert.ok(byName.build_board?.outputSchema, 'tools declare an output schema');
});

test('serves the guide, the examples and the schema', async () => {
  const { resources } = await client.listResources();
  assert.deepEqual(resources.map((r) => r.uri).sort(), [
    'board-doc://example',
    'board-doc://guide',
    'board-spec://example',
    'board-spec://schema',
  ]);
  const guide = await client.readResource({ uri: 'board-doc://guide' });
  const guideText = guide.contents[0];
  assert.ok(guideText && 'text' in guideText);
  assert.match(guideText.text, /wardley-beta/);
  const schema = await client.readResource({ uri: 'board-spec://schema' });
  const first = schema.contents[0];
  assert.ok(first && 'text' in first);
  assert.deepEqual(JSON.parse(first.text).required, ['name', 'frames']);
});

test('the prompt template asks for confirmation before building', async () => {
  const { prompts } = await client.listPrompts();
  assert.deepEqual(
    prompts.map((p) => p.name),
    ['workshop_to_board'],
  );
  const prompt = await client.getPrompt({
    name: 'workshop_to_board',
    arguments: {
      topic: 'Pairing',
      duration_minutes: '90',
      participants: '12',
      learning_objectives: 'Pair',
    },
  });
  const message = prompt.messages[0]?.content;
  assert.ok(message && message.type === 'text');
  assert.match(message.text, /Do not continue without my explicit yes/);
});

test('validate_board answers over the wire with structured content', async () => {
  const result = await client.callTool({
    name: 'validate_board',
    arguments: { spec: VALID_SPEC },
  });
  assert.equal(result.isError ?? false, false);
  assert.equal((result.structuredContent as { valid: boolean }).valid, true);
});

test('validate_board reads a Markdown document with a flowchart over the wire', async () => {
  const result = await client.callTool({
    name: 'validate_board',
    arguments: {
      document: '# Wire\n\n## Flow\n\n```mermaid\nflowchart LR\n  a[Start] --> b[End]\n```\n',
    },
  });
  assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
  assert.equal((result.structuredContent as { valid: boolean }).valid, true);
});

test('invalid arguments come back as a tool error the model can read', async () => {
  const result = await client.callTool({ name: 'validate_board', arguments: { spec: 42 } });
  assert.equal(result.isError, true);
});

test('build_board without a token is a domain error, not a crash', async () => {
  const result = await client.callTool({
    name: 'build_board',
    arguments: { spec: VALID_SPEC, target: { new_board_name: 'X' } },
  });
  assert.equal(result.isError, true);
  const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
  assert.match(text, /MIRO_ACCESS_TOKEN is not set/);
});

test('an unknown tool is a protocol error', async () => {
  await assert.rejects(client.callTool({ name: 'delete_board', arguments: {} }));
});

test('the prompt template works with only topic and duration', async () => {
  const prompt = await client.getPrompt({
    name: 'workshop_to_board',
    arguments: { topic: 'Pairing', duration_minutes: '60' },
  });
  const message = prompt.messages[0]?.content;
  assert.ok(message && message.type === 'text');
  assert.match(message.text, /60-minute workshop on "Pairing"\./);
  assert.match(message.text, /Propose three learning objectives/);
});
