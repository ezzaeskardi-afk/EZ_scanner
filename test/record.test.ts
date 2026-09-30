/**
 * The A/B record writer's contracts.
 *
 * The record is evidence in the README, so the writer's judgments are pinned: the sentence is
 * built only from artifact numbers, one date lands once (a re-dispatch cannot duplicate a row),
 * and a drifted paragraph fails loudly instead of appending into the wrong place.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendToRecord, recordSentence } from '../scripts/record.ts';
import type { HeavyHunt, Receipt } from '../scripts/heavy-receipt.ts';

const HUNT: HeavyHunt = { id: 1, createdAt: '2026-10-04T10:13:21Z', updatedAt: '2026-10-04T10:51:23Z', conclusion: 'success', headSha: '4aad9e8abcdef' };
const RECEIPT: Receipt = {
  startedAt: '2026-10-04T10:13:32.569Z',
  passes: 30, ok: 30, timedOut: 0,
  totalSeconds: 2280.4, meanSeconds: 76.0,
  flaked: 0, consistent: 0,
  files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
};

const README = `The hunt's record is measured, not promised. The first scheduled firing (2026-09-27, on the\n1.7.8 tag's commit) came back 30 for 30 — and every later Sunday appends another row, one\n\`npm run hunt-receipt\` away from being read.\n\n## Releases\n`;

test('the sentence carries day, commit, health, timing and verdict — artifact numbers only', () => {
  const sentence = recordSentence(HUNT, RECEIPT);
  assert.match(sentence, /The next scheduled firing \(2026-10-04, commit `4aad9e8`\)/);
  assert.match(sentence, /came back 30 for 30 —/);
  assert.match(sentence, /2280\.4 seconds of loaded scanning, a 76\.0-second mean per pass,/);
  assert.match(sentence, /0 flake\(s\) and 0 break\(s\) in the verdict/);
});

test('a red receipt is named, not beautified', () => {
  const red = recordSentence(HUNT, { ...RECEIPT, ok: 29, timedOut: 1, flaked: 1 });
  assert.match(red, /29\/30 clean plus 1 timed out/);
  assert.match(red, /1 flake\(s\) and 0 break\(s\)/);
});

test('one date lands once — a re-run is a no-op, not a duplicate row', () => {
  const once = appendToRecord(README, recordSentence(HUNT, RECEIPT), '2026-10-04');
  assert.ok(once!.includes('The next scheduled firing (2026-10-04'));
  assert.equal(appendToRecord(once!, recordSentence(HUNT, RECEIPT), '2026-10-04'), null, 'the same date is skipped');
  const next = appendToRecord(once!, recordSentence({ ...HUNT, createdAt: '2026-10-11T10:00:00Z' }, RECEIPT), '2026-10-11');
  assert.ok(next!.includes('2026-10-04'));
  assert.ok(next!.includes('2026-10-11'), 'a later Sunday appends after the last row');
});

test('a drifted paragraph fails loudly instead of appending into the wrong place', () => {
  assert.throws(() => appendToRecord('no anchor here', recordSentence(HUNT, RECEIPT), '2026-10-04'), /ANCHOR text not found/);
});
