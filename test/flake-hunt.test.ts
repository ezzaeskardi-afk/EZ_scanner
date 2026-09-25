/**
 * The flake hunt's judgements, pinned.
 *
 * `scripts/flake-hunt.ts` runs on a schedule, against a runner nobody is watching, and it is the
 * thing that decides whether a red test is a race or a break. The fixtures below are that
 * reporter's real output, captured in the three shapes this project produces: an assertion whose
 * message is the whole error (inline), one with a diff (a block), and a subtest.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classify,
  failuresOf,
  type HuntResultsFile,
  INTEGRATION_FILES,
  PASS_TABLE_HEADER,
  passRow,
  type RunResult,
  verdictTable,
  writeResultsFile,
} from '../scripts/flake-hunt.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A run with the pieces a classification reads, and nothing else to keep in step. */
function runOf(failed: RunResult['failed'], overrides: Partial<RunResult> = {}): RunResult {
  return { total: 5, pass: 5 - failed.length, failed, seconds: 1, timedOut: false, ...overrides };
}

test('a failure is read with its message, and a subtest arrives as the parent it failed under', () => {
  const tap = [
    'TAP version 13',
    'not ok 1 - resets make the scanner slow itself down instead of hammering',
    '  ---',
    "  error: 'the worker budget was respected throughout (widest 8 in flight, budget 4)'",
    "  code: 'ERR_ASSERTION'",
    '  ...',
    'not ok 2 - the speed phase is not what was retested',
    '  ---',
    '  error: |-',
    '    the speed phase is not what was retested',
    '    ',
    '    0 !== 42.5',
    "  code: 'ERR_ASSERTION'",
    '  ...',
    '    not ok 1 - a subtest that fails',
    '      ---',
    "      error: 'the child said no'",
    '      ...',
    'not ok 3 - a parent with a failing child',
    '  ---',
    "  error: '1 subtest failed'",
    '  ...',
    '1..3',
  ].join('\n');

  assert.deepEqual(failuresOf(tap), [
    {
      name: 'resets make the scanner slow itself down instead of hammering',
      error: 'the worker budget was respected throughout (widest 8 in flight, budget 4)',
    },
    { name: 'the speed phase is not what was retested', error: 'the speed phase is not what was retested\n\n0 !== 42.5' },
    { name: 'a parent with a failing child', error: '1 subtest failed' },
  ]);
});

test('a test that fails in some runs is a flake; one that fails in every run is a break', () => {
  const report = classify([
    runOf([
      { name: 'resets make the scanner slow itself down instead of hammering', error: 'the worker budget was respected throughout' },
      { name: 'a test that never passes', error: 'expected 4, got 8' },
    ]),
    runOf([
      { name: 'resets make the scanner slow itself down instead of hammering', error: 'the worker budget was respected throughout' },
      { name: 'a test that never passes', error: 'expected 4, got 8' },
    ]),
    runOf([{ name: 'a test that never passes', error: 'expected 4, got 8' }]),
  ]);

  // The same name in two of three runs, with the message from the first: this is the shape the
  // hunt exists to name, and the same message says which assertion to go and read.
  assert.deepEqual(report.flaked, [
    { name: 'resets make the scanner slow itself down instead of hammering', error: 'the worker budget was respected throughout', runs: 2, of: 3 },
  ]);
  assert.deepEqual(report.consistent, [{ name: 'a test that never passes', error: 'expected 4, got 8' }]);
  assert.deepEqual({ runs: report.runs, timedOut: report.timedOut }, { runs: 3, timedOut: 0 });
});

test('a run that never finished is not evidence about any test', () => {
  const report = classify([
    runOf([{ name: 'a test that failed once', error: 'said no' }]),
    runOf([], { timedOut: true }),
    runOf([], { timedOut: true }),
  ]);

  assert.equal(report.timedOut, 2);
  // One completed run, one failure: there is no second run it could have passed in, so calling
  // it a flake would be an invention. "Failed in every run that finished" is the honest reading.
  assert.deepEqual(report.flaked, []);
  assert.deepEqual(report.consistent, [{ name: 'a test that failed once', error: 'said no' }]);
});

test('every pass leaves a row the summary table can show, timeouts included', () => {
  assert.equal(PASS_TABLE_HEADER.split('\n')[0], '| pass | result | tests | passing | failing | seconds |');
  assert.equal(passRow(3, runOf([{ name: 'a thing failed', error: 'no' }], { seconds: 12.34, total: 6, pass: 5 })), '| 3 | 1 failing | 6 | 5 | 1 | 12.3 |');
  assert.equal(passRow(4, runOf([], { seconds: 9.96, total: 6, pass: 6 })), '| 4 | ok | 6 | 6 | — | 10.0 |');
  // A timed-out pass says nothing about any test, and its row says so rather than reading as zeros.
  assert.equal(passRow(5, runOf([], { timedOut: true, seconds: 600 })), '| 5 | timed out | — | — | — | — |');
});

test('the verdict table separates what to fix from what merely happened', () => {
  const meta = { runs: 3, load: 3, files: ['test/hostile-line.test.ts'], timeout: 600 };
  const green = verdictTable(classify([runOf([]), runOf([]), runOf([])]), meta);
  assert.match(green, /Every run passed — no flake showed up in this window\./);
  assert.ok(!green.includes('|'), 'a green hunt has no failure table to fill');

  const report = classify([
    runOf([
      { name: 'resets make the scanner slow itself down instead of hammering', error: 'peak factor 1, final 1, after 72 resets' },
      { name: 'a test that never passes', error: 'expected 4, got 8\nline two' },
    ]),
    runOf([
      { name: 'resets make the scanner slow itself down instead of hammering', error: 'peak factor 1, final 1, after 72 resets' },
      { name: 'a test that never passes', error: 'expected 4, got 8' },
    ]),
    runOf([{ name: 'a test that never passes', error: 'expected 4, got 8' }]),
  ]);
  const mixed = verdictTable(report, meta);
  // Flakes name their ratio; breaks name their certainty.
  assert.match(mixed, /\| resets make the scanner slow itself down instead of hammering \| 2 \| 3 \|/);
  assert.match(mixed, /\| a test that never passes \| 3 \| 3 \|/);
  // The break's row names its certainty; the message's second line never lands in the cell.
  assert.ok(mixed.includes('| a test that never passes | 3 | 3 | expected 4, got 8 |'));
  assert.ok(!mixed.includes('line two'));
  assert.match(mixed, /failing in every run is a break/);
});

 test('timed-out passes are excluded from the verdict and said so above it', () => {
  const meta = { runs: 3, load: 3, files: ['test/hostile-line.test.ts'], timeout: 600 };
  const table = verdictTable(classify([runOf([{ name: 'one bad test', error: 'no' }]), runOf([], { timedOut: true }), runOf([], { timedOut: true })]), meta);
  assert.match(table, /2 pass\(es\) never finished and are excluded from the counts below\./);
  // One completed run, one failure: the row must say 1 of 1, not borrow a denominator it never had.
  assert.match(table, /\| one bad test \| 1 \| 1 \|/);
});

test('the evidence file holds every pass and the verdict, and skips quietly with no sink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flake-hunt-evidence-'));
  const path = join(dir, 'results.json');
  const previous = process.env.FLAKE_HUNT_RESULTS;
  process.env.FLAKE_HUNT_RESULTS = path;
  try {
    // The same discipline the hunt runs under: passes land one at a time, the verdict last.
    const record: HuntResultsFile = {
      startedAt: '2026-09-26T00:00:00.000Z',
      runs: 3,
      load: 3,
      files: ['test/hostile-line.test.ts'],
      timeoutSeconds: 600,
      passes: [runOf([])],
    };
    assert.equal(writeResultsFile(record), true, 'a set path means the file is written');
    let parsed = JSON.parse(readFileSync(path, 'utf8')) as HuntResultsFile;
    assert.equal(parsed.passes.length, 1, 'rewritten after each pass, so an interrupted hunt keeps what it measured');
    assert.equal(parsed.verdict, undefined, 'no verdict until the hunt can actually make one');

    record.passes.push(runOf([{ name: 'a thing failed', error: 'no' }]), runOf([], { timedOut: true }));
    record.verdict = classify(record.passes);
    assert.equal(writeResultsFile(record), true);
    parsed = JSON.parse(readFileSync(path, 'utf8')) as HuntResultsFile;
    assert.equal(parsed.passes.length, 3);
    assert.deepEqual(parsed.verdict?.flaked.map((f) => f.name), ['a thing failed']);
    assert.equal(parsed.verdict?.timedOut, 1);

    // A local run has no sink: a quiet skip reported honestly, not a crash.
    delete process.env.FLAKE_HUNT_RESULTS;
    assert.equal(writeResultsFile(record), false);
  } finally {
    if (previous === undefined) delete process.env.FLAKE_HUNT_RESULTS;
    else process.env.FLAKE_HUNT_RESULTS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the hunt covers every test file that drives the fake access network', () => {
  // Assembled from two pieces on purpose: written out, this gate's own file would match itself,
  // and the list would be compared against the list plus one.
  const harness = ['hostile', '-line.ts'].join('');
  const users = readdirSync(join(root, 'test'))
    .filter((file) => file.endsWith('.test.ts'))
    .filter((file) => readFileSync(join(root, 'test', file), 'utf8').includes(harness))
    .map((file) => `test/${file}`)
    .sort();

  assert.ok(users.length >= 4, `expected the integration files, found ${users.join(', ')}`);
  assert.deepEqual(
    [...INTEGRATION_FILES].sort(),
    users,
    'a file that uses the harness has to be in INTEGRATION_FILES, or the hunt is not covering it',
  );
});
