/**
 * Release tooling tests.
 *
 * The release workflow publishes whatever `scripts/release-notes.ts` prints, so a broken
 * extractor ships a wrong release rather than failing a test. These assertions run against
 * the real CHANGELOG.md.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { releaseNotes } from '../scripts/release-notes.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

test('every changelog version yields notes without swallowing the next section', () => {
  const versions = [...changelog.matchAll(/^## (\S+)/gm)].map((m) => m[1]);
  assert.ok(versions.length >= 4, 'expected the whole release history');
  for (const version of versions) {
    const notes = releaseNotes(version, changelog);
    assert.ok(notes.length > 40, `notes for ${version} are too thin`);
    assert.ok(!/^## /m.test(notes), `notes for ${version} leaked the next section`);
  }
});

test('the heading line is dropped whole, not left at the top of the notes', () => {
  const synthetic = '# Changelog\n\n## 2.0.0 — 2030-01-01\n\nFirst line.\n\n### Added\n- thing\n\n## 1.0.0 — 2029-01-01\n\nOlder.\n';
  assert.equal(releaseNotes('2.0.0', synthetic), 'First line.\n\n### Added\n- thing');
  assert.equal(releaseNotes('v2.0.0', synthetic), 'First line.\n\n### Added\n- thing', 'a leading v is tolerated');
  assert.equal(releaseNotes('1.0.0', synthetic), 'Older.');
});

test('the package version has its own notes and unknown versions are rejected', () => {
  const notes = releaseNotes(pkg.version, changelog);
  assert.ok(notes.length > 40, `no notes for ${pkg.version}`);
  assert.ok(!notes.startsWith('—'), 'the heading tail must not leak into the notes');
  assert.match(notes, /^\*\*|^## |^[A-Z-]/, 'notes start with prose or a section heading');
  assert.throws(() => releaseNotes('0.0.0-nope', changelog), /no "## 0\.0\.0-nope" section/);
});
