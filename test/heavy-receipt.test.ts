/**
 * The heavy-hunt receipt's contracts.
 *
 * The receipt exists so the 2026-10-04 Sunday hunt lands as one command, so its judgments
 * are pinned: which runs count as heavy (duration, never the clock — GitHub's schedule queue
 * delays starts), how the artifact's numbers are read, and what the printed sentence carries.
 * Fixture-shaped strings, no `gh`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { durationSeconds, isHeavy, parseResults, renderReceipt, type HeavyHunt } from '../scripts/heavy-receipt.ts';

const green: HeavyHunt = { id: 36311839721, createdAt: '2026-09-27T10:13:21Z', updatedAt: '2026-09-27T10:51:23Z', conclusion: 'success', headSha: 'e81a605abcdef' };
const nightly = { ...green, id: 2, createdAt: '2026-09-27T09:14:00Z', updatedAt: '2026-09-27T09:20:15Z' };

/** The shape of the real artifact, 30 for 30 — sampled from the 2026-09-27 run. */
const RESULTS = JSON.stringify({
  startedAt: '2026-09-27T10:13:32.569Z',
  runs: 30, load: 3, timeoutSeconds: 600,
  files: ['test/hostile-line.test.ts', 'test/operator-profiles.test.ts', 'test/recovery-pass.test.ts', 'test/cli.test.ts', 'test/doctor-signature.test.ts'],
  passes: Array.from({ length: 30 }, (_, i) => ({ total: 41, pass: 41, failed: [], timedOut: false, seconds: 75.0 + (i % 5) })),
  verdict: { flaked: [], consistent: [], timedOut: 0 },
});

test('heavy is a duration judgment, not a clock one', () => {
  assert.ok(isHeavy(green), 'a ~38 minute run is the heavy net');
  assert.ok(!isHeavy(nightly), 'a ~6 minute run is the nightly floor');
  assert.ok(!isHeavy({ ...green, updatedAt: 'bogus' }), 'a run with no duration reads as not-heavy, not as heavy');
  assert.equal(durationSeconds(green), (new Date(green.updatedAt).getTime() - new Date(green.createdAt).getTime()) / 1000);
});

test('the artifact numbers are read as the record keeps them', () => {
  const receipt = parseResults(RESULTS);
  assert.equal(receipt.passes, 30);
  assert.equal(receipt.ok, 30);
  assert.equal(receipt.timedOut, 0);
  assert.equal(receipt.flaked, 0);
  assert.equal(receipt.consistent, 0);
  assert.equal(receipt.files.length, 5);
  assert.ok(Math.abs(receipt.meanSeconds - receipt.totalSeconds / 30) < 0.001);
});

test('a torn artifact degrades to unknown counts instead of inventing zeros', () => {
  const torn = parseResults('{"startedAt":"2026-10-04T10:00:00Z","passes":[]}');
  assert.equal(torn.flaked, -1, 'no verdict block means unknown, not clean');
  assert.equal(torn.passes, 0);
});

test('the receipt sentence carries day, commit, health, load, timing, verdict and artifact', () => {
  const text = renderReceipt(green, parseResults(RESULTS));
  assert.match(text, /Heavy hunt receipt — 2026-09-27, commit `e81a605`:/);
  assert.match(text, /30 for 30 · load 3 · 5 file\(s\) · 2310\.0s total, 77\.0s mean\/pass/);
  assert.match(text, /0 flake\(s\), 0 break\(s\) in the verdict/);
  assert.match(text, /artifact: https:\/\/github\.com\/ezzaeskardi-afk\/EZ_scanner\/actions\/runs\/36311839721#artifact/);
});

test('a red heavy hunt still renders, naming the timeouts it saw', () => {
  const red = parseResults(JSON.stringify({
    startedAt: '2026-10-04T10:00:00Z', files: ['a.ts'],
    passes: Array.from({ length: 30 }, (_, i) => (i === 7 ? { total: 41, pass: 39, failed: [{ name: 'x' }], timedOut: false, seconds: 80 } : { total: 41, pass: 41, failed: [], timedOut: false, seconds: 75 })),
    verdict: { flaked: [{ name: 'x', runs: 1, of: 30, error: 'boom' }], consistent: [], timedOut: 0 },
  }));
  const text = renderReceipt({ ...green, id: 9, createdAt: '2026-10-04T10:00:00Z', headSha: 'abcdef1234' }, red);
  assert.match(text, /29 for 30/);
  assert.match(text, /1 flake\(s\), 0 break\(s\)/);
});
