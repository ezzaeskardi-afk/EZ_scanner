/**
 * The flake hunt's judgements, pinned.
 *
 * `scripts/flake-hunt.ts` runs on a schedule, against a runner nobody is watching, and it is the
 * thing that decides whether a red test is a race or a break. The fixtures below are that
 * reporter's real output, captured in the three shapes this project produces: an assertion whose
 * message is the whole error (inline), one with a diff (a block), and a subtest.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classify, failuresOf, INTEGRATION_FILES, type RunResult } from '../scripts/flake-hunt.ts';

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
