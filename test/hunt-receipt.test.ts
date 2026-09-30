/**
 * The hunt receipt's contracts.
 *
 * The receipt is a read-only ledger over records that already exist (run pages, artifacts,
 * issue threads), so the tests pin its three real jobs: counting pass rows where they really
 * exist, assembling a window's greens and reds, and rendering reds with the evidence a reader
 * needs — verdict table, artifact links, issue thread. Scheduled shapes come from the crons'
 * start hours, commits from `head_sha` — the run title is a commit subject, not a fact sheet.
 * All against string fixtures shaped like the live records; no `gh`, no network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  artifactDownload,
  artifactUrl,
  buildReceipt,
  headlineOf,
  passRowCounts,
  renderReceipt,
  scheduledOnly,
  scheduledShape,
  verdictOf,
  type ScheduledHunt,
} from '../scripts/hunt-receipt.ts';
import { PASS_TABLE_HEADER, passRow, verdictTable } from '../scripts/flake-hunt.ts';

const iso = (text: string): string => new Date(text).toISOString();
const at = (text: string): Date => new Date(text);

function hunt(id: number, created: string, conclusion: string, title: string, sha = '8155a1b2c3d4e5f6', event = 'schedule', updated?: string): ScheduledHunt {
  return { databaseId: id, createdAt: iso(created), workflowName: 'Flake hunt', event, conclusion, displayTitle: title, headSha: sha, updatedAt: iso(updated ?? created) };
}

/** A scheduled hunt's title is the commit subject — no pass facts in it, by observation. */
const TITLE = 'test: property tests fuzz the parsers front door';

/** The summary text a red hunt leaves: passRow rows plus the verdict block. */
function redSummary(firstMessage: string): string {
  const rows = [PASS_TABLE_HEADER];
  rows.push(passRow(1, { total: 40, pass: 40, failed: [], timedOut: false, seconds: 71.2 } as never));
  rows.push(passRow(2, { total: 40, pass: 38, failed: [{ name: 'the burst precondition holds all 12 slots', error: firstMessage }], timedOut: false, seconds: 74.9 } as never));
  rows.push('', verdictTable({ runs: 2, timedOut: 0, flaked: [{ name: 'the burst precondition holds all 12 slots', runs: 1, of: 2, error: firstMessage }], consistent: [] }, { runs: 5, load: 2, files: ['test/hostile-line.test.ts'], timeout: 900 }));
  return rows.join('\n');
}

const GREEN = hunt(1, '2026-10-02T03:17:00Z', 'success', TITLE, '8155a1b2c3d4e5f6', 'schedule', '2026-10-02T03:23:00Z');
const RED = hunt(2, '2026-10-04T04:47:00Z', 'failure', TITLE, '8155a1b2c3d4e5f6', 'schedule', '2026-10-04T04:53:00Z');

test('pass counts come from rows, and rows only — a title yields zeros honestly', () => {
  const rows = [PASS_TABLE_HEADER, passRow(1, { total: 5, pass: 5, failed: [], timedOut: false, seconds: 1 } as never)];
  assert.deepEqual(passRowCounts(rows.join('\n')), { passes: 1, ok: 1, timedOut: 0, failing: 0 });

  const summary = redSummary('expected the table full');
  assert.deepEqual(passRowCounts(summary), { passes: 2, ok: 1, timedOut: 0, failing: 1 });

  assert.deepEqual(passRowCounts(TITLE), { passes: 0, ok: 0, timedOut: 0, failing: 0 }, 'a commit subject carries no rows');
});

test('the scheduled shape derives from the run duration — schedule starts are delayed, durations are honest', () => {
  // 2026-09-27's live pair proves the shape: same cron window, ~6 min and ~38 min apart.
  const nightly = scheduledShape(hunt(6, '2026-09-27T09:14:00Z', 'success', TITLE, 'abc', 'schedule'));
  assert.deepEqual(nightly, { passes: 5, load: 2, label: 'nightly (5×load 2)' }, 'a ~6 minute run is the nightly floor');
  const sunday = scheduledShape(hunt(7, '2026-09-27T10:13:21Z', 'success', TITLE, 'def', 'schedule', '2026-09-27T10:51:23Z'));
  assert.equal(sunday.passes, 30, 'the ~38 minute run is the heavy net');
  // A hunt updated_at never saw (killed run, clock skew) still reads as the nightly floor.
  const killed = scheduledShape({ ...hunt(8, '2026-10-06T11:00:00Z', 'failure', TITLE), updatedAt: 'bogus' });
  assert.equal(killed.passes, 5);
});

test('the verdict block is lifted whole, with a plain note when a run predates summaries', () => {
  const body = `Hunt went red.\n\n${redSummary('boom')}\n\n[run](https://example.com)`;
  assert.match(verdictOf(body), /^### Verdict/);
  assert.match(verdictOf(body), /boom/);
  assert.equal(verdictOf('no table here'), '_the thread carries no verdict table (a run predating the summary copy — see the run page)_');
});

test('a window sorts its hunts, attaches threads to their reds, and reads the commit from head_sha', () => {
  const thread = { number: 9, createdAt: iso('2026-10-04T04:50:00Z'), closedAt: null, body: redSummary('expected the table full, peak read 9') };
  const receipt = buildReceipt([RED, GREEN], [thread], at('2026-10-01T00:00:00Z'), at('2026-10-08T00:00:00Z'));
  assert.equal(receipt.hunts.length, 2);
  assert.equal(receipt.green.length, 1);
  assert.equal(receipt.green[0].passes, 5, 'the nightly shape, from the start hour');
  assert.equal(receipt.green[0].sha, '8155a1b', 'seven chars of head_sha');
  assert.equal(receipt.reds.length, 1);
  assert.equal(receipt.reds[0].threads[0].number, 9);
  assert.match(receipt.reds[0].verdictTable, /### Verdict/);
  assert.equal(receipt.reds[0].downloadUrl, artifactDownload(2));
});

test('a thread opened before the window still carries a red inside it', () => {
  const thread = { number: 7, createdAt: iso('2026-09-30T05:00:00Z'), closedAt: null, body: redSummary('still failing') };
  const receipt = buildReceipt([hunt(3, '2026-10-02T03:17:00Z', 'failure', redSummary('still failing'), 'abc', 'schedule', '2026-10-02T03:23:00Z')], [thread], at('2026-10-01T00:00:00Z'), at('2026-10-08T00:00:00Z'));
  assert.equal(receipt.reds[0].threads[0].number, 7, 'the 48h slack catches a red period already running');
});

test('the render carries the ledger, the red evidence and the artifact links', () => {
  const thread = { number: 9, createdAt: iso('2026-10-04T04:50:00Z'), closedAt: null, body: redSummary('expected the table full, peak read 9') };
  const receipt = buildReceipt([GREEN, RED], [thread], at('2026-10-01T00:00:00Z'), at('2026-10-08T00:00:00Z'));
  const text = renderReceipt(receipt);
  assert.match(text, /^## Hunt receipt — 2026-10-01 → 2026-10-08/);
  assert.match(text, /2 scheduled hunt\(s\): \*\*1 green\*\*, \*\*1 red\*\*/);
  assert.match(text, /\| 2026-10-02 \| nightly \(5×load 2\) \| 5 \| 2 \| 8155a1b \|/);
  assert.match(text, /#### 2026-10-04/);
  assert.match(text, /commit `8155a1b`/);
  assert.doesNotMatch(text, /pass\(es\): /, 'a title carries no rows, so no counts line is invented — the verdict table is the count of record');
  assert.match(text, /\| the burst precondition holds all 12 slots \| 1 \| 2 \| expected the table full, peak read 9 \|/);
  assert.match(text, /\[run page\]\(https:\/\/github\.com\/ezzaeskardi-afk\/EZ_scanner\/actions\/runs\/2#artifact\)/);
  assert.match(text, /\[artifact download\]\(https:\/\/github\.com\/ezzaeskardi-afk\/EZ_scanner\/actions\/runs\/2\/artifacts\)/);
  assert.match(text, /issue thread: #9 \(open\)/);
});

test('a clean week says so plainly', () => {
  const receipt = buildReceipt([GREEN], [], at('2026-10-01T00:00:00Z'), at('2026-10-08T00:00:00Z'));
  const text = renderReceipt(receipt);
  assert.match(text, /1 scheduled hunt\(s\): \*\*1 green\*\*, \*\*0 red\*\*/);
  assert.match(text, /No reds\./);
});

test('dispatches and the release gate never enter the ledger — event, not name, is the truth', () => {
  assert.equal(scheduledOnly([GREEN, hunt(4, GREEN.createdAt, 'success', TITLE)]).length, 2);
  // The gate and dispatches carry the same workflowName; only `event` separates them.
  const notScheduled = [hunt(5, GREEN.createdAt, 'success', TITLE, 'abc1234', 'workflow_dispatch'), hunt(6, GREEN.createdAt, 'success', TITLE, 'def5678', 'workflow_call')];
  assert.throws(() => scheduledOnly(notScheduled), /no scheduled hunts in the window/);
  assert.equal(scheduledOnly(notScheduled.concat(GREEN)).length, 1);
});

test('headlines and link builders stay stable', () => {
  assert.equal(headlineOf('flake hunt on the tagged commit / integration suite, repeated under load'), 'integration suite, repeated under load');
  assert.equal(headlineOf('integration suite, repeated under load'), 'integration suite, repeated under load');
  assert.equal(artifactUrl(36476214444), 'https://github.com/ezzaeskardi-afk/EZ_scanner/actions/runs/36476214444#artifact');
  assert.equal(artifactDownload(36476214444), 'https://github.com/ezzaeskardi-afk/EZ_scanner/actions/runs/36476214444/artifacts');
});
