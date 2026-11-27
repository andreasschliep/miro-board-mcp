/**
 * The default look must not change when themes are added (design decision D19).
 *
 * The hashes were taken from the code before `theme: slides` existed. They cover the
 * composed board, the validation report, the spec hash and every planned Miro call, so
 * any change to positions, sizes, colours, findings or API payloads shows up here.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BoardBuilder, DryRunTransport, MiroClient } from 'miro-board-builder';
import { checkDocument } from '../src/document/check.ts';
import { composeDocument } from '../src/document/compose.ts';
import { silentLogger } from '../src/logger.ts';
import { canonicalJson, specHash } from '../src/spec.ts';

const policy = { allowedUrlHosts: new Set<string>() };

const short = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16);

async function fingerprint(path: string) {
  const markdown = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const composed = await composeDocument(markdown);
  const checked = await checkDocument(markdown, policy);
  assert.ok(checked.board, `${path} must be valid`);
  const transport = new DryRunTransport();
  await new BoardBuilder(new MiroClient(transport, { logger: silentLogger }), {
    logger: silentLogger,
  }).build('b', checked.board, { dryRun: true });
  return {
    raw: short(composed.raw),
    report: short(checked.report),
    spec: specHash(checked.board),
    calls: transport.calls.length,
    callsHash: short(transport.calls),
  };
}

test('documents without a theme give exactly the output they gave before themes existed', async () => {
  assert.deepEqual(await fingerprint('examples/code-review-basics.md'), {
    raw: '148fa849e7c8365d',
    report: 'c872ec0fbf573b39',
    spec: 'sha256:2daefb1075b898371fe1568dd6cfd68b212e5924f04afe3f215757b1ac9459da',
    calls: 64,
    callsHash: '1f631d81e9fcbd7a',
  });
  assert.deepEqual(await fingerprint('test/fixtures/every-block.md'), {
    raw: 'a1a9dce98e0a4d8c',
    report: '231b4f19018493ee',
    spec: 'sha256:6dea5f588f3da7910f75eb64e791c65f0f30c1d0784228daa5796c0f9703b3c1',
    calls: 55,
    callsHash: 'b2738aaa75361499',
  });
});
