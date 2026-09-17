/**
 * Dead-code gate.
 *
 * Every previous cleanup pass in this repo (1.1.1, 1.2.0) was found with a throwaway
 * script that then got deleted — so the same three kinds of rot came back. These tests
 * are those scripts, kept:
 *
 *   1. exported symbols in `src/` that no other file imports (the private-helper-that-
 *      stayed-public case, e.g. the 13 helpers un-exported in 1.1.1);
 *   2. CSS custom properties that are defined but never read with `var()` (the 10 tokens
 *      removed in 1.1.1, plus the three this check caught again in 1.2.0);
 *   3. runtime strings the GUI never renders (a key in app.js's string table with no
 *      `T.<key>` reader anywhere).
 *
 * The checks are deliberately conservative — a name counts as "used" if it appears
 * anywhere else in the tree, even in a comment, and string keys are matched with a
 * dotted-name search. That means they can miss a dead symbol, but they will not fail on
 * a live one, which is what a CI gate needs.
 *
 * Consumers are the whole project (src + test), so an export that only tests use is fine.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
      out.push(...walk(full, keep));
    } else if (keep(full)) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Comments are dropped so that a symbol merely *mentioned* in prose does not count as a
 * consumer. Only whole-line `//` comments and block comments are removed: stripping
 * trailing comments would eat the `//` inside string literals such as `https://…`.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const read = (file: string) => stripComments(readFileSync(file, 'utf8'));

const srcFiles = walk(join(root, 'src'), (f) => f.endsWith('.ts'));
const testFiles = walk(join(root, 'test'), (f) => f.endsWith('.ts'));
const sources = new Map<string, string>([...srcFiles, ...testFiles].map((f) => [f, read(f)]));

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Names an `export` statement makes visible outside its own file. */
function exportedNames(code: string): string[] {
  const names: string[] = [];
  for (const m of code.matchAll(
    /^export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.push(m[1]);
  }
  // `export { a, b as c }` and `export type { X } from './y.ts'`
  for (const m of code.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const exported = part.includes(' as ') ? part.split(' as ')[1] : part;
      const clean = exported.trim().replace(/^type\s+/, '');
      if (/^[A-Za-z_$][\w$]*$/.test(clean)) names.push(clean);
    }
  }
  return [...new Set(names)];
}

test('no exported symbol is used only inside its own module', () => {
  const dead: string[] = [];
  for (const file of srcFiles) {
    for (const name of exportedNames(sources.get(file)!)) {
      const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`);
      const usedElsewhere = [...sources.entries()].some(
        ([other, code]) => other !== file && pattern.test(code),
      );
      if (!usedElsewhere) dead.push(`${relative(root, file)} → ${name}`);
    }
  }
  assert.deepEqual(
    dead,
    [],
    `exported but never imported anywhere — delete it or drop the \`export\`:\n  ${dead.join('\n  ')}`,
  );
});

test('every design token is actually read', () => {
  const css = readFileSync(join(root, 'src', 'gui', 'styles.css'), 'utf8');
  // No line anchor: a token declared inline (`:root { --x: 1px; }`) must be seen too.
  const defined = [...new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))];
  const read_ = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const unused = defined.filter((token) => !read_.has(token));
  assert.deepEqual(
    unused,
    [],
    `tokens defined in styles.css but never used with var():\n  ${unused.join('\n  ')}`,
  );
});

test('every runtime string is actually rendered', () => {
  const js = readFileSync(join(root, 'src', 'gui', 'app.js'), 'utf8');

  // The GUI is English-only, so all UI strings composed in JS live in one table and are
  // read through `T` member access — nested groups are validated against the core enums
  // by gui.test.ts instead.
  const block = js.slice(js.indexOf('const T = {'), js.indexOf('\n};', js.indexOf('const T = {')));
  const keys = [...new Set([...block.matchAll(/^ {2}([a-zA-Z][\w]*):/gm)].map((m) => m[1]))];
  assert.ok(keys.length >= 15, 'expected the full runtime string table');
  const unused = keys.filter((key) => !new RegExp(`\\.${escapeRegExp(key)}\\b`).test(js));

  assert.deepEqual(
    unused,
    [],
    `runtime strings the GUI never renders:\n  ${unused.join('\n  ')}`,
  );
});

test('the project carries no non-English text', () => {
  // The GUI, the CLI, the core and the docs are English-only by decision (1.3.0 removed
  // the FA/EN layer). This gate is what keeps a stray Persian string from creeping back
  // in unnoticed — the same reason the other gates in this file exist.
  const files = [
    ...walk(join(root, 'src'), (f) => /\.(ts|js|html|css)$/.test(f)),
    ...walk(join(root, 'test'), (f) => /\.(ts|js|html)$/.test(f)),
    ...walk(join(root, 'scripts'), (f) => /\.(ts|js)$/.test(f)),
    ...walk(join(root, 'docs'), (f) => f.endsWith('.md')),
    ...['README.md', 'CHANGELOG.md', 'package.json'].map((f) => join(root, f)),
  ];
  const offenders = files
    .map((file) => [relative(root, file), (readFileSync(file, 'utf8').match(/[\u0600-\u06FF]/g) ?? []).length] as const)
    .filter(([, count]) => count > 0);
  assert.deepEqual(
    offenders.map(([file, count]) => `${file} (${count} chars)`),
    [],
    'non-English text found — the project is English-only',
  );
});
