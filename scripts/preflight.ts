/**
 * The pre-tag checklist, one command.
 *
 * 1.7.9's first real run of the bump still reached a broken tag push, because everything a
 * release needs was checked somewhere, at some point, by hand or by another gate — and nothing
 * checked it all together, just before the one action that publishes: the tag. This is that
 * check, and it runs nothing, writes nothing and asks for nothing but the version:
 *
 *   npm run preflight -- 1.8.0        # or: patch | minor | major, against the current version
 *
 * Four findings in one pass, so one pass shows one pass's worth of fixes:
 *   versions — every literal the shared table covers says what package.json says;
 *   notes    — the changelog has a real section for the version: present, substantial, and
 *              not the placeholder the bump opens (its STUB_MARKER is the machine tell);
 *   tree     — the working tree is clean, since the tag ships the tree it is cut on;
 *   tag      — no tag for this version exists yet (both spellings), because pushing an
 *              existing tag is a no-op and re-pointing one is a rewrite of a shipped ref.
 *
 * Exits non-zero if any finding fired, after reporting all of them.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUB_MARKER, VERSION_PLACES, parseTarget } from './bump-version.ts';
import { releaseNotes } from './release-notes.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** One checklist row: what was asked, whether it held, and the detail that names the fix. */
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** The two git reads preflight makes, injectable so the tests can script every tree. */
export type GitRunner = (args: string[]) => { ok: boolean; output: string };

function defaultGit(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

/** The first version literal a place's pattern matches — zero matches is a finding, not a guess. */
export function literalOf(contents: string, place: { file: string; pattern: RegExp }): string {
  place.pattern.lastIndex = 0;
  const found = [...contents.matchAll(place.pattern)];
  if (found.length === 0) throw new Error(`${place.file}: no version literal matches the shared pattern`);
  return found[0][1];
}

/** Check 1: every literal the shared table covers says what package.json says. */
export function versionAgreement(read: (file: string) => string): Check {
  const pkgVersion = (JSON.parse(read('package.json')) as { version: string }).version;
  const places = VERSION_PLACES.filter((place) => place.file !== 'package.json');
  const wrong: string[] = [];
  for (const place of places) {
    const literal = literalOf(read(place.file), place);
    if (literal !== pkgVersion) wrong.push(`${place.file} says ${literal}`);
  }
  return {
    name: 'versions',
    ok: wrong.length === 0,
    detail: wrong.length === 0 ? `all ${places.length + 1} places say ${pkgVersion}` : `${pkgVersion} in package.json, but ${wrong.join(', ')}`,
  };
}

/** Check 2: the changelog has a real note for this version — present, substantial, not the placeholder. */
export function notesCheck(version: string, changelog: string): Check {
  let notes: string;
  try {
    notes = releaseNotes(version, changelog);
  } catch (err) {
    return { name: 'notes', ok: false, detail: (err as Error).message };
  }
  if (notes.includes(STUB_MARKER)) {
    return {
      name: 'notes',
      ok: false,
      detail: `the ## ${version} section is still the bump's placeholder — write the real note (npm run notes -- ${version} previews exactly what publishes)`,
    };
  }
  if (notes.length <= 40) {
    return { name: 'notes', ok: false, detail: `the ## ${version} section is too thin (${notes.length} chars) to be the release note` };
  }
  return { name: 'notes', ok: true, detail: `real notes under ## ${version} (${notes.length} chars)` };
}

/** status --porcelain rows, kept whole — the leading code column is the fix's own hint. */
export function dirtyFiles(porcelain: string): string[] {
  return porcelain.split('\n').map((row) => row.trim()).filter(Boolean);
}

/** Check 3: the tag ships the tree it is cut on, so the tree carries nothing uncommitted. */
export function cleanTree(porcelain: string): Check {
  const dirty = dirtyFiles(porcelain);
  return {
    name: 'tree',
    ok: dirty.length === 0,
    detail: dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.join(', ')}`,
  };
}

/** The tag forms a release push creates or collides with — both spellings count. */
export function duplicateTags(tags: string[], version: string): string[] {
  const clean = version.replace(/^v/, '');
  return tags.filter((tag) => tag === `v${clean}` || tag === clean);
}

/** Check 4: one release, one tag — a repeat push is a no-op, a re-point is a rewrite. */
export function tagCheck(version: string, tags: string[]): Check {
  const dupes = duplicateTags(tags, version);
  return {
    name: 'tag',
    ok: dupes.length === 0,
    detail: dupes.length === 0 ? `no tag for ${version} yet` : `already tagged: ${dupes.join(', ')} — push is a no-op, re-pointing a shipped tag is a rewrite`,
  };
}

/** The whole checklist against injected I/O — the CLI and the tests run the same path. */
export function runPreflight(version: string, io: { git: GitRunner; read: (file: string) => string }): Check[] {
  const tags = io.git(['tag', '--list']).output.split('\n').map((tag) => tag.trim()).filter(Boolean);
  return [
    versionAgreement(io.read),
    notesCheck(version, io.read('CHANGELOG.md')),
    cleanTree(io.git(['status', '--porcelain']).output),
    tagCheck(version, tags),
  ];
}

/** Every check reports, green or red — one pass over the checklist, the whole picture. */
export function report(checks: Check[]): string {
  return checks.map((check) => `${check.ok ? '✅' : '❌'} ${check.name}: ${check.detail}`).join('\n');
}

if (process.argv[1]?.endsWith('preflight.ts')) {
  const arg = process.argv[2] ?? '';
  if (!arg) {
    console.error('usage: node scripts/preflight.ts <version | patch | minor | major>');
    process.exit(2);
  }
  try {
    const pkgVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
    const version = parseTarget(pkgVersion, arg);
    const checks = runPreflight(version, {
      git: defaultGit,
      read: (file) => readFileSync(join(root, file), 'utf8'),
    });
    console.log(`preflight for ${version}:`);
    console.log(report(checks));
    if (checks.some((check) => !check.ok)) {
      console.error('preflight is red — fix the findings above before pushing the tag');
      process.exit(1);
    }
    console.log(`ready to tag: git tag v${version} && git push origin v${version}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
