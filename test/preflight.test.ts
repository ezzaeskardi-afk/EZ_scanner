/**
 * The pre-tag gate's contracts.
 *
 * preflight is the last check before the one action that publishes, so its own four verdicts
 * are pinned here: which findings fire, which pass, and that every check reports even when an
 * earlier one is red (one pass shows one pass's worth of fixes). The checks run against
 * injected I/O — a fake `read` over string fixtures and a scripted `git` — so the tests never
 * touch the real tree, and the CLI and the tests run the same `runPreflight` path.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STUB_MARKER, changelogStub, parseTarget, VERSION_PLACES } from '../scripts/bump-version.ts';
import {
  cleanTree,
  dirtyFiles,
  duplicateTags,
  literalOf,
  notesCheck,
  report,
  runPreflight,
  tagCheck,
  versionAgreement,
  type GitRunner,
} from '../scripts/preflight.ts';

/** A fake `read` over the four version places, each literal overridable per test. */
function fakeRead({ pkg = '1.8.0', cli = '1.8.0', server = '1.8.0', openui = '1.8.0', changelog }: {
  pkg?: string; cli?: string; server?: string; openui?: string; changelog?: string;
} = {}) {
  const files = new Map<string, string>([
    ['package.json', JSON.stringify({ version: pkg })],
    ['src/cli/main.ts', `const VERSION = '${cli}';`],
    ['src/server/server.ts', `const VERSION = '${server}';`],
    ['src/core/openui.ts', `input.version ?? '${openui}'`],
    ['CHANGELOG.md', changelog ?? '# Changelog\n\n## 1.8.0 — 2030-01-01\n\nA real note with more than enough substance to pass the thinness floor.\n'],
  ]);
  return (file: string) => {
    if (!files.has(file)) throw new Error(`fixture has no ${file}`);
    return files.get(file)!;
  };
}

function fakeGit(script: Partial<Record<'tag --list' | 'status --porcelain', { ok: boolean; output: string }>>): GitRunner {
  return (args) => {
    const key = args.join(' ') as 'tag --list' | 'status --porcelain';
    return script[key] ?? { ok: true, output: '' };
  };
}

test('version agreement reads every shared place and names the odd one out', () => {
  const ok = versionAgreement(fakeRead());
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /all 4 places say 1\.8\.0/);

  const wrong = versionAgreement(fakeRead({ server: '1.7.8' }));
  assert.equal(wrong.ok, false);
  assert.match(wrong.detail, /src\/server\/server\.ts says 1\.7\.8/);

  // A renamed constant leaves a pattern matching nothing — a finding, not a silent pass.
  const place = VERSION_PLACES.find((candidate) => candidate.file === 'src/cli/main.ts')!;
  assert.throws(() => literalOf("const APP_VERSION = '1.8.0';", place), /no version literal matches/);
});

test('the notes check accepts a real note and refuses missing, stubbed and thin ones', () => {
  const real = notesCheck('1.8.0', fakeRead()('CHANGELOG.md'));
  assert.equal(real.ok, true);
  assert.match(real.detail, /real notes under ## 1\.8\.0/);

  assert.equal(notesCheck('1.9.0', fakeRead()('CHANGELOG.md')).ok, false, 'a version with no section is a finding');
  assert.match(notesCheck('1.9.0', fakeRead()('CHANGELOG.md')).detail, /no "## 1\.9\.0" section/);

  const stubbed = notesCheck('1.8.0', changelogStub('1.8.0', '2030-01-01') + '\n# Changelog\n\n## 1.7.8 — 2026-09-26\n\nOld.\n');
  assert.equal(stubbed.ok, false, 'the bump placeholder is refused, marker recognized');
  assert.match(stubbed.detail, /still the bump's placeholder/);
  assert.ok(changelogStub('1.8.0', '2030-01-01').includes(STUB_MARKER));

  assert.equal(notesCheck('1.8.0', '# Changelog\n\n## 1.8.0 — 2030-01-01\n\ntodo\n').ok, false, 'a thin section is a finding');
});

test('the tree check lists dirty paths and passes a clean porcelain', () => {
  assert.equal(cleanTree('').ok, true);
  assert.deepEqual(dirtyFiles(' M README.md\n?? new-file.ts\n'), ['M README.md', '?? new-file.ts']);
  const dirty = cleanTree(' M README.md\n?? new-file.ts\n');
  assert.equal(dirty.ok, false);
  assert.match(dirty.detail, /uncommitted: M README\.md, \?\? new-file\.ts/);
});

test('the tag check counts both spellings and reports the collision', () => {
  assert.deepEqual(duplicateTags(['v1.7.8', 'v1.7.9'], '1.8.0'), []);
  assert.deepEqual(duplicateTags(['v1.7.8', 'v1.8.0'], '1.8.0'), ['v1.8.0'], 'the v spelling collides');
  assert.deepEqual(duplicateTags(['v1.7.8', '1.8.0'], 'v1.8.0'), ['1.8.0'], 'the version side may carry the v too');
  const dupe = tagCheck('1.8.0', ['v1.8.0']);
  assert.equal(dupe.ok, false);
  assert.match(dupe.detail, /already tagged: v1\.8\.0/);
});

test('one pass reports every check, red or green — a finding never hides the rest', () => {
  const checks = runPreflight('1.8.0', {
    git: fakeGit({ 'status --porcelain': { ok: true, output: ' M README.md' }, 'tag --list': { ok: true, output: 'v1.8.0' } }),
    read: fakeRead({ changelog: '# Changelog\n' }),
  });
  assert.deepEqual(checks.map((check) => check.name), ['versions', 'notes', 'tree', 'tag']);
  assert.equal(checks.filter((check) => !check.ok).length, 3, 'notes, tree and tag are red together');
  const text = report(checks);
  assert.match(text, /✅ versions:/);
  assert.match(text, /❌ notes:/);
  assert.match(text, /❌ tree:/);
  assert.match(text, /❌ tag:/);
});

test('the same path is all green on a ready tree', () => {
  const checks = runPreflight('1.8.0', {
    git: fakeGit({ 'tag --list': { ok: true, output: 'v1.7.8\nv1.7.9' } }),
    read: fakeRead(),
  });
  assert.ok(checks.every((check) => check.ok), report(checks));
  const text = report(checks);
  assert.equal([...text.matchAll(/✅/g)].length, 4, text);
});

test('keyword and v-prefixed arguments resolve through the bump\'s own parseTarget', () => {
  // The CLI resolves its argument with the bump's parseTarget before any check runs, so
  // `patch`, `1.8.0` and `v1.8.0` agree there too — one resolver for both tools.
  assert.equal(parseTarget('1.8.0', 'patch'), '1.8.1');
  assert.equal(parseTarget('1.8.0', 'v1.9.0'), '1.9.0');
  assert.throws(() => parseTarget('1.8.0', '1.7.9'), /does not come after/, 'preflight refuses a version already behind the tree');
});
