/**
 * Version-consistency gate.
 *
 * The version string lives in four places — package.json, the CLI banner, the GUI server
 * and the OpenUI report default — and a release that ships one of them stale is a release
 * whose `ezscan --version` disagrees with the GUI footer. `scripts/bump-version.ts` rewrites
 * all four in one commit and shares this file's literal table (VERSION_PLACES), so the bump
 * and the gate can never disagree about where a literal lives; the bump runs this gate
 * before committing.
 *
 * Importing `src/cli/main.ts` would run the CLI (it executes on load), so the literals are
 * read as text.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bumpPlace, changelogStub, nextVersion, parseTarget, prependChangelog, STUB_MARKER, VERSION_PLACES } from '../scripts/bump-version.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string };
const SEMVER = /^\d+\.\d+\.\d+$/;

function literalsOf(file: string): string[] {
  const place = VERSION_PLACES.find((candidate) => candidate.file === file);
  if (!place) throw new Error(`no literal pattern recorded for ${file}`);
  place.pattern.lastIndex = 0;
  return [...read(file).matchAll(place.pattern)].map((m) => m[1]);
}

test('package.json carries a plain semver version', () => {
  assert.match(pkg.version, SEMVER, `package.json version "${pkg.version}" is not semver`);
});

test('the shared literal table covers all four places', () => {
  // The bump rewrites exactly this table, so a place dropped from it is a place the bump
  // silently stops touching — hence the file list itself is pinned, not just its length.
  assert.equal(VERSION_PLACES.length, 4);
  assert.deepEqual(
    VERSION_PLACES.map((place) => place.file),
    ['package.json', 'src/cli/main.ts', 'src/server/server.ts', 'src/core/openui.ts'],
  );
});

test('every version literal in src/ agrees with package.json', () => {
  const found = VERSION_PLACES.filter((place) => place.file !== 'package.json').map((place) => ({
    file: place.file,
    version: literalsOf(place.file)[0] ?? '',
  }));
  // Three literals read, so a renamed or deleted constant cannot make this pass silently.
  assert.equal(found.length, 3);
  for (const { file, version } of found) {
    assert.equal(version, pkg.version, `${file} says ${version}, package.json says ${pkg.version}`);
  }
});

test('each place carries exactly one version literal', () => {
  // The bump refuses to guess when a pattern matches zero or several literals; this is the
  // same expectation, checked here on the shipped tree so a refactor trips a test first.
  for (const place of VERSION_PLACES) {
    assert.equal(literalsOf(place.file).length, 1, `${place.file} must carry exactly one version literal`);
  }
});

test('the bump helpers agree with the gate', () => {
  assert.equal(nextVersion('1.7.8', 'patch'), '1.7.9');
  assert.equal(nextVersion('1.7.8', 'minor'), '1.8.0');
  assert.equal(nextVersion('1.7.8', 'major'), '2.0.0');
  assert.equal(parseTarget('1.7.8', 'v1.8.0'), '1.8.0', 'a leading v is accepted and stripped');
  assert.throws(() => parseTarget('1.7.8', '1.7.8'), /does not come after/);
  assert.throws(() => parseTarget('1.7.8', '1.6.0'), /does not come after/);
  assert.throws(() => parseTarget('1.7.8', '1.7'), /not a semver/);
});

test('the bump rewrites exactly the matched literal', () => {
  const place = VERSION_PLACES.find((candidate) => candidate.file === 'src/cli/main.ts')!;
  assert.equal(bumpPlace("const VERSION = '1.7.8';", place, '1.9.0'), "const VERSION = '1.9.0';");
  assert.throws(
    () => bumpPlace('const VERSION = process.env.VERSION ?? "1.7.8";', place, '1.9.0'),
    /expected exactly one version literal, found 0/,
  );
});

test('the changelog stub lands above the current top section', () => {
  const changelog = read('CHANGELOG.md');
  const top = /^## (\S+)/m.exec(changelog)![1]!;
  const bumped = prependChangelog(changelog, changelogStub('9.9.9', '2030-01-01'));
  assert.ok(bumped.indexOf('## 9.9.9 — 2030-01-01') > -1, 'the stub section is present');
  assert.ok(bumped.indexOf('## 9.9.9') < bumped.indexOf(`## ${top}`), 'newest first, like every entry so far');
});

test('the stub carries the machine marker preflight refuses a tag over', () => {
  // The bump and preflight agree on this one string: it is how "forgot to write the note"
  // is told apart from a short but real note, without either tool parsing the other.
  assert.ok(changelogStub('9.9.9', '2030-01-01').includes(STUB_MARKER), 'the stub must carry the marker');
  assert.ok(!read('CHANGELOG.md').includes(STUB_MARKER), 'the shipped changelog must not carry it');
});
