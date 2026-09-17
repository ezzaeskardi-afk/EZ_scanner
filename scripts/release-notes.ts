/**
 * Release notes for one version, lifted out of CHANGELOG.md.
 *
 * Every release so far was assembled by hand (1.1.1 typed its notes straight into the
 * GitHub form), which is how a published version ends up describing something other than
 * the commit its tag points at. This is the one source the release workflow publishes:
 *
 *   node scripts/release-notes.ts 1.3.0        # or: npm run notes -- 1.3.0
 *
 * The whole heading line is dropped (title, date and all — the release title carries the
 * version) and the note stops at the next `## ` heading, so a version can never absorb its
 * neighbour's history.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The body of the `## <version>` section, without its heading. */
export function releaseNotes(version: string, changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')): string {
  const clean = version.replace(/^v/, '');
  const heading = new RegExp(`^## ${escapeRegExp(clean)}(?:\\s|$)`, 'm');
  const found = heading.exec(changelog);
  if (!found) throw new Error(`CHANGELOG.md has no "## ${clean}" section`);
  // Skip the rest of the heading line (the `— <date>` tail), not just the matched prefix.
  const lineEnd = changelog.indexOf('\n', found.index);
  const rest = changelog.slice(lineEnd === -1 ? changelog.length : lineEnd + 1);
  const next = /^## /m.exec(rest);
  return rest.slice(0, next ? next.index : rest.length).trim();
}

if (process.argv[1]?.endsWith('release-notes.ts')) {
  const version = process.argv[2] ?? '';
  if (!version) {
    console.error('usage: node scripts/release-notes.ts <version>');
    process.exit(2);
  }
  try {
    process.stdout.write(`${releaseNotes(version)}\n`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
