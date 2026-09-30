/**
 * The CI contracts gate.
 *
 * Two of this cycle's failures were classes CI cannot see: a tag push dying at startup
 * because the called hunt requested a permission the caller did not grant (lesson 7), and a
 * reporter step that only fires on the event its condition names. Nothing in `npm test`
 * reads the workflows — until now. These assertions pin the YAML *text* (cheap, ordered,
 * no YAML parser needed) so a silent edit of any of these lines fails a test instead of a
 * release:
 *
 *   runners      — the linux label stays pinned to ubuntu-26.04 (the 2026-10-19 migration
 *                  must not regress the pin), and no ubuntu-latest survives anywhere;
 *   runtimes     — every action ref is v5 or v6 (the Node 20 deprecation must not come back);
 *   permissions  — the release grants everything the called hunt declares (lesson 7);
 *   reporter     — the red-hunt steps keep their schedule-only conditions and the summary
 *                  copy always runs, so a red night is never unreported;
 *   ref passthrough — the gate hunts the TAGGED tree (lesson 1), not the caller's sha;
 *   evidence     — the artifact still uploads even on failure (lesson 3's tolerance).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

const ci = read('.github/workflows/ci.yml');
const flake = read('.github/workflows/flake.yml');
const release = read('.github/workflows/release.yml');
const all = `ci.yml\n${ci}\nflake.yml\n${flake}\nrelease.yml\n${release}`;

test('runners: the linux label stays pinned, and ubuntu-latest is gone for good', () => {
  // The pin list is explicit, not counted: a moved line is a change worth reading. The
  // matrix lives in ci.yml; flake.yml and release.yml pin their single jobs directly.
  assert.ok(ci.includes('os: [ubuntu-26.04, windows-latest]'), 'ci.yml lost the pinned matrix');
  assert.ok(ci.includes('runs-on: ubuntu-26.04'), 'ci.yml lost the smoke job pin');
  assert.ok(flake.includes('runs-on: ubuntu-26.04'), 'flake.yml lost the hunt pin');
  assert.ok(release.includes('runs-on: ubuntu-26.04'), 'release.yml lost the publish pin');
  assert.ok(!/ubuntu-latest/.test(all), 'ubuntu-latest must not come back — the pin was probed and chosen');
});

test('runtimes: every action ref is on the node 24 runtime', () => {
  const refs = [...all.matchAll(/uses: (actions\/[\w-]+)@([\w.-]+)/g)].map(([, name, ref]) => `${name}@${ref}`);
  assert.ok(refs.length >= 9, `expected the full actions inventory, saw ${refs.length}`);
  for (const ref of refs) {
    assert.match(ref, /@v[56]$/, `${ref} is not on the node 24 runtime (v5/v6) — the deprecation banner returns`);
  }
});

test('permissions: the caller grants everything the called hunt declares (lesson 7)', () => {
  // Scope/level pairs, order-free: a re-ordered or commented block must still parse as the
  // same contract, while a dropped scope or a downgraded level must fail.
  const grants = (block: string): Map<string, string> =>
    new Map([...block.matchAll(/^(  |    )([\w-]+): ([\w-]+)$/gm)].map((m) => [m[2], m[3]]));
  const flakeBlock = /permissions:\n((?:[ ][ ](?:[\w-]+: .+|#.*)\n)+)/.exec(flake)![1];
  const releaseBlock = /permissions:\n((?:[ ][ ](?:[\w-]+: .+|#.*)\n)+)/.exec(release)![1];
  const LEVEL: Record<string, number> = { none: 0, read: 1, write: 2 };
  const callee = grants(flakeBlock);
  const caller = grants(releaseBlock);
  assert.ok(callee.has('contents'), 'the hunt declares contents');
  assert.ok(callee.has('issues'), 'the hunt declares issues (the reporter\'s only write)');
  for (const [scope, level] of callee) {
    assert.ok(caller.has(scope), `release.yml must grant ${scope} — without it the tag push dies at startup (lesson 7)`);
    assert.ok(
      LEVEL[caller.get(scope)!] >= LEVEL[level],
      `release.yml's ${scope} is ${caller.get(scope)}, the hunt needs ${level} — an undeclared or lower grant kills the parse (lesson 7)`,
    );
  }
});

test('reporter: a red night always opens its thread, a green one closes it, dispatches stay silent', () => {
  // The conditions are pinned as text: the reporter must fire on schedule events only, and
  // the summary copy must run even when the hunt step failed (otherwise the issue opens
  // without the table).
  assert.match(flake, /- name: Keep the summary for the issue\n        if: always\(\)/, 'the summary copy must survive a failed hunt');
  assert.match(flake, /- name: Open or update the red-hunt issue\n        if: failure\(\) && github\.event_name == 'schedule'/, 'the open step must stay schedule-only and failure-driven');
  assert.match(flake, /- name: Close the red-hunt issue\n        if: success\(\) && github\.event_name == 'schedule'/, 'the close step must stay schedule-only and success-driven');
  assert.match(flake, /run: node scripts\/report-red-hunt\.ts open/);
  assert.match(flake, /run: node scripts\/report-red-hunt\.ts close/);
  assert.match(flake, /GH_TOKEN: \$\{\{ github\.token \}\}/, 'the reporter runs on the workflow token');
});

test('ref passthrough: the gate hunts the tagged tree, not the caller\'s sha (lesson 1)', () => {
  assert.match(release, /uses: \.\/\.github\/workflows\/flake\.yml/, 'the release calls the repo\'s own hunt');
  assert.match(release, /ref: \$\{\{ github\.event\.inputs\.tag \|\| github\.ref \}\}/);
  assert.match(flake, /ref: \$\{\{ inputs\.ref \|\| github\.sha \}\}/, 'the hunt checks out the passed ref, defaulting to its own');
});

test('evidence: the artifact uploads even on failure, and a missing one only warns (lesson 3)', () => {
  assert.match(flake, /name: Keep the evidence\n        if: always\(\)/);
  assert.match(flake, /if-no-files-found: warn/, 'old tags predating the evidence file must not fail their hunt');
  assert.match(flake, /path: flake-hunt-results\.json/);
});
