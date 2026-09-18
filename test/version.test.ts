/**
 * Version-consistency gate.
 *
 * The version string lives in four places — package.json, the CLI banner, the GUI server
 * and the OpenUI report default — and every release so far was bumped by hand in all of
 * them. A release that ships one of them stale is a release whose `ezscan --version`
 * disagrees with the GUI footer, so this gate fails the build on the next miss instead.
 *
 * The literal patterns are spelled out here rather than imported, because importing
 * `src/cli/main.ts` would run the CLI (it executes on load).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string };
const SEMVER = /^\d+\.\d+\.\d+$/;

const SOURCES: Array<{ file: string; pattern: RegExp }> = [
  { file: 'src/cli/main.ts', pattern: /const VERSION = '(\d+\.\d+\.\d+)'/g },
  { file: 'src/server/server.ts', pattern: /const VERSION = '(\d+\.\d+\.\d+)'/g },
  { file: 'src/core/openui.ts', pattern: /input\.version \?\? '(\d+\.\d+\.\d+)'/g },
];

test('package.json carries a plain semver version', () => {
  assert.match(pkg.version, SEMVER, `package.json version "${pkg.version}" is not semver`);
});

test('every version literal in src/ agrees with package.json', () => {
  const found: Array<{ file: string; version: string }> = [];
  for (const { file, pattern } of SOURCES) {
    const literals = [...read(file).matchAll(pattern)].map((m) => m[1]);
    assert.equal(literals.length, 1, `${file} must carry exactly one version literal`);
    found.push({ file, version: literals[0] });
  }
  // Three literals read, so a renamed or deleted constant cannot make this pass silently.
  assert.equal(found.length, 3);
  for (const { file, version } of found) {
    assert.equal(version, pkg.version, `${file} says ${version}, package.json says ${pkg.version}`);
  }
});
