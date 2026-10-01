/**
 * One command for the four-place version bump.
 *
 * The version lives in four files — package.json, the CLI banner, the GUI server and the
 * OpenUI report default — and every release bumped them by hand until the version gate
 * (test/version.test.ts) started catching the misses. This is the bump itself: it rewrites
 * all four in one pass, opens the CHANGELOG section the notes gate requires, runs the
 * version gate and lands the whole thing as a single commit:
 *
 *   npm run bump -- 1.7.9          # explicit version (a leading `v` is accepted)
 *   npm run bump -- patch          # or: minor | major, computed from the current version
 *   npm run bump -- 1.7.9 --dry-run
 *
 * The literal patterns are shared with the version gate (VERSION_PLACES below), so a
 * literal that moves is fixed once and the bump and its gate move together. A red gate
 * stops the commit short: the rewritten files are left in the working tree to inspect,
 * fix or revert, and nothing is committed half-bumped.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** package.json plus the three src literals plus the README's release badge, in the same shape the version gate reads them. */
export const VERSION_PLACES: Array<{ file: string; pattern: RegExp }> = [
  { file: 'package.json', pattern: /"version": "(\d+\.\d+\.\d+)"/g },
  { file: 'src/cli/main.ts', pattern: /const VERSION = '(\d+\.\d+\.\d+)'/g },
  { file: 'src/server/server.ts', pattern: /const VERSION = '(\d+\.\d+\.\d+)'/g },
  { file: 'src/core/openui.ts', pattern: /input\.version \?\? '(\d+\.\d+\.\d+)'/g },
  { file: 'README.md', pattern: /badge\/release-(\d+\.\d+\.\d+)-blue/g },
];

/** The files one bump writes; the commit stages exactly these and nothing else. */
const BUMPED_FILES = [...VERSION_PLACES.map((place) => place.file), 'CHANGELOG.md'];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export type BumpKind = 'major' | 'minor' | 'patch';

function parseSemver(version: string): [number, number, number] {
  const found = SEMVER.exec(version);
  if (!found) throw new Error(`not a semver version: "${version}"`);
  return [Number(found[1]), Number(found[2]), Number(found[3])];
}

/** The keyword bumps, computed from the current version. */
export function nextVersion(current: string, kind: BumpKind): string {
  const [major, minor, patch] = parseSemver(current);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Accepts `1.7.9`, `v1.7.9` or a bump keyword, and refuses anything not past the current version. */
export function parseTarget(current: string, arg: string): string {
  const target = /^(major|minor|patch)$/.test(arg) ? nextVersion(current, arg as BumpKind) : arg.replace(/^v/, '');
  const next = parseSemver(target);
  const curr = parseSemver(current);
  const greater =
    next[0] > curr[0] ||
    (next[0] === curr[0] && next[1] > curr[1]) ||
    (next[0] === curr[0] && next[1] === curr[1] && next[2] > curr[2]);
  if (!greater) throw new Error(`${target} does not come after the current version ${current}`);
  return target;
}

function matchLiterals(contents: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0;
  return [...contents.matchAll(pattern)].map((m) => m[1]);
}

/**
 * Replaces the single version literal a place's pattern matches. One match is the gate's
 * own expectation ("must carry exactly one version literal"), so zero or several matches
 * fail here with the file named — a renamed constant stops the bump, not the release.
 */
export function bumpPlace(contents: string, place: { file: string; pattern: RegExp }, version: string): string {
  const literals = matchLiterals(contents, place.pattern);
  if (literals.length !== 1) {
    throw new Error(`${place.file}: expected exactly one version literal, found ${literals.length}`);
  }
  place.pattern.lastIndex = 0;
  return contents.replace(place.pattern, (whole, literal: string) => whole.replace(literal, () => version));
}

/**
 * The placeholder section the notes gate (test/release-notes.test.ts) requires for a new
 * version: prose above the fold, long enough to pass, honest that it is not the real note.
 * STUB_MARKER is the machine-readable tell: preflight refuses to pass a tag over a section
 * carrying it, so "forgot to write the note" stops at the pre-tag check, not the release.
 */
export const STUB_MARKER = 'Preflight refuses to pass a tag over this placeholder.';

export function changelogStub(version: string, date: string): string {
  return [
    `## ${version} — ${date}`,
    '',
    'Cut with `npm run bump`. What follows is a placeholder: replace it with what actually changed',
    'before pushing the tag — the release workflow publishes this section as written, and',
    '`npm run notes -- <version>` prints exactly what a release would say.',
    '',
    STUB_MARKER,
    '',
  ].join('\n');
}

/** Inserts the section above the current top version — newest first, like every entry so far. */
export function prependChangelog(changelog: string, section: string): string {
  const first = /^## /m.exec(changelog);
  if (!first) throw new Error('CHANGELOG.md has no `## ` version section to prepend above');
  return `${changelog.slice(0, first.index)}${section}\n${changelog.slice(first.index)}`;
}

const COMMIT_IDENTITY = [
  '-c',
  'user.name=ezzaeskardi-afk',
  '-c',
  'user.email=ezzaeskardi-afk@users.noreply.github.com',
];

function git(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

function currentVersion(): string {
  return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
}

function wholeMatch(contents: string, pattern: RegExp): string {
  pattern.lastIndex = 0;
  return [...contents.matchAll(pattern)][0]?.[0] ?? '';
}

if (process.argv[1]?.endsWith('bump-version.ts')) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const positional = argv.filter((arg) => arg !== '--dry-run');
  if (positional.length !== 1 || positional[0] === '--help') {
    console.error('usage: node scripts/bump-version.ts <version | patch | minor | major> [--dry-run]');
    process.exit(positional.length === 1 && positional[0] === '--help' ? 0 : 2);
  }
  try {
    const current = currentVersion();
    const version = parseTarget(current, positional[0]);
    const today = new Date().toISOString().slice(0, 10);

    const rewritten = new Map<string, string>();
    for (const place of VERSION_PLACES) {
      rewritten.set(place.file, bumpPlace(readFileSync(join(root, place.file), 'utf8'), place, version));
    }
    rewritten.set(
      'CHANGELOG.md',
      prependChangelog(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), changelogStub(version, today)),
    );

    console.log(`EZ Scanner ${current} → ${version}`);
    for (const place of VERSION_PLACES) {
      console.log(`  ${place.file.padEnd(20)} ${wholeMatch(rewritten.get(place.file)!, place.pattern)}`);
    }
    console.log(`  ${'CHANGELOG.md'.padEnd(20)} new \`## ${version} — ${today}\` section (placeholder — fill it in)`);

    if (dryRun) {
      console.log('dry run — nothing written, nothing committed');
      process.exit(0);
    }

    const status = git(['status', '--porcelain']);
    if (!status.ok) throw new Error(`git status failed: ${status.output}`);
    if (status.output) {
      throw new Error('the working tree is not clean — a bump commit must carry the bump alone; commit or stash first');
    }

    for (const [file, contents] of rewritten) writeFileSync(join(root, file), contents);

    console.log('  version gate: node --test test/version.test.ts');
    const gate = spawnSync('node', ['--test', 'test/version.test.ts'], { cwd: root, stdio: 'inherit' });
    if (gate.status !== 0) {
      console.error(
        `the version gate is red — nothing was committed; ${BUMPED_FILES.join(', ')} are rewritten in the working tree to inspect, fix or revert`,
      );
      process.exit(1);
    }

    const added = git(['add', ...BUMPED_FILES]);
    if (!added.ok) throw new Error(`git add failed: ${added.output}`);
    const commit = git([...COMMIT_IDENTITY, 'commit', '-m', `chore: EZ Scanner ${version}`]);
    if (!commit.ok) throw new Error(`git commit failed: ${commit.output}`);
    console.log(`  committed ${git(['rev-parse', '--short', 'HEAD']).output} — chore: EZ Scanner ${version}`);
    console.log(
      `next: write the real ${version} entry in CHANGELOG.md (the release publishes it), then npm run preflight -- ${version} and push the tag`,
    );
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
