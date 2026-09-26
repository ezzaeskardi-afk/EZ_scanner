/**
 * Structural contract tests for the GUI.
 *
 * The GUI has no build step and no framework: index.html, app.js and styles.css are
 * three files that must agree with each other. Every failure mode below has actually
 * happened during development, and none of them is a type error, so `tsc` cannot see
 * them:
 *
 *   - app.js queries an id/class that the markup no longer has (or never had);
 *   - non-English text creeps back into a GUI file (the GUI is English-only, and the
 *     FA/EN layer was deleted rather than left to rot);
 *   - a runtime string the GUI composes in JS stops being rendered;
 *   - an icon is referenced with `#i-…` but no matching <symbol> exists;
 *   - a stylesheet rule is deleted while the markup still asks for the class.
 *
 * These tests read the files as text and assert the contracts between them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, applyPreset, type ScanConfig } from '../src/core/types.ts';

const guiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'gui');
const html = readFileSync(join(guiDir, 'index.html'), 'utf8');
const js = readFileSync(join(guiDir, 'app.js'), 'utf8');
const css = readFileSync(join(guiDir, 'styles.css'), 'utf8');
const report = readFileSync(join(guiDir, 'report.html'), 'utf8');

test('every preset button resolves to a real preset', () => {
  // The buttons post `data-preset` straight to /api/preset, so a preset that is renamed (or a
  // button typed wrong) fails at runtime in the GUI and nowhere else.
  const names = [...html.matchAll(/data-preset="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 7, `expected every preset as a button, saw ${names.join(', ')}`);
  for (const name of names) {
    const preset = applyPreset(name);
    assert.ok(preset, `data-preset="${name}" is not a preset`);
    for (const key of Object.keys(preset as Partial<ScanConfig>)) {
      assert.ok(key in DEFAULT_CONFIG, `preset ${name} sets an unknown config key: ${key}`);
    }
  }
});

/** The runtime string table in app.js, split into its top level and each nested group. */
function stringsTable() {
  const start = js.indexOf('const T = {');
  const end = js.indexOf('\n};', start);
  const block = js.slice(start, end);
  const group = (name: string) => {
    const from = block.indexOf(`  ${name}: {`);
    if (from === -1) return null;
    const to = block.indexOf('\n  },', from);
    return [...block.slice(from, to).matchAll(/^ {4}([a-zA-Z][\w]*):/gm)].map((m) => m[1]);
  };
  return {
    top: [...block.matchAll(/^ {2}([a-zA-Z][\w]*):/gm)].map((m) => m[1]),
    nested: {
      phase: group('phase'),
      kind: group('kind'),
      reason: group('reason'),
    },
  };
}

const STRINGS = stringsTable();

const ids = (text: string) => new Set([...text.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

test('every element app.js selects by id exists in the markup', () => {
  const present = ids(html);
  const wanted = new Set([...js.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]));
  const missing = [...wanted].filter((id) => !present.has(id));
  assert.deepEqual(missing, [], `app.js selects ids that index.html does not define: ${missing.join(', ')}`);
});

test('every address-source block and dock panel has its element and tab', () => {
  const present = ids(html);
  for (const kind of [...js.matchAll(/data-kind="([\w-]+)"/g)].map((m) => m[1])) {
    assert.ok(present.has(`src-${kind}`), `tab data-kind="${kind}" has no #src-${kind} block`);
  }
  assert.deepEqual(
    [...html.matchAll(/data-kind="([\w-]+)"/g)].map((m) => m[1]).sort(),
    [...present].filter((id) => id.startsWith('src-')).map((id) => id.slice(4)).sort(),
    'each source tab needs exactly one matching block',
  );
  assert.deepEqual(
    [...html.matchAll(/data-dock="([\w-]+)"/g)].map((m) => m[1]).sort(),
    [...html.matchAll(/data-dock-panel="([\w-]+)"/g)].map((m) => m[1]).sort(),
    'each dock tab needs exactly one matching panel',
  );
});

test('every icon reference resolves to a sprite symbol', () => {
  const symbols = new Set([...html.matchAll(/<symbol id="([\w-]+)"/g)].map((m) => m[1]));
  assert.ok(symbols.size >= 20, 'the sprite should hold the whole icon set');
  const used = new Set([...`${html}${js}${report}`.matchAll(/href="#(i-[\w-]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !symbols.has(id));
  assert.deepEqual(missing, [], `icons used but not defined: ${missing.join(', ')}`);
});

test('the GUI is English-only', () => {
  // 1.2.x shipped a FA/EN layer with a language switch. It was deleted rather than left
  // half-wired, so this gate keeps any non-English text from creeping back into the
  // four build-free GUI files (and the font files it used to need).
  for (const [name, text] of [
    ['index.html', html],
    ['app.js', js],
    ['styles.css', css],
    ['report.html', report],
  ] as const) {
    const found = [...new Set(text.match(/[\u0600-\u06FF]/g) ?? [])];
    assert.deepEqual(found, [], `${name} contains non-English text`);
  }
  assert.ok(!/data-i18n|dir=["']rtl|\blang=["']fa/.test(`${html}${js}${report}`), 'the i18n layer is gone — nothing may ask for it');
});

test('scanner phases and probe error kinds are all named in the string table', () => {
  const types = readFileSync(join(guiDir, '..', 'core', 'types.ts'), 'utf8');
  const phaseBlock = types.slice(types.indexOf('phase:'), types.indexOf(';', types.indexOf('phase:')));
  const phases = [...phaseBlock.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(phases.length >= 6, 'expected the full ScanStats phase union');
  assert.deepEqual(phases.filter((p) => !STRINGS.nested.phase?.includes(p)), [], 'unnamed scanner phase');

  const kindBlock = types.slice(types.indexOf('export type ProbeErrorKind ='), types.indexOf(';', types.indexOf('export type ProbeErrorKind =')));
  const kinds = [...kindBlock.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 8, 'expected the full ProbeErrorKind union');
  assert.deepEqual(kinds.filter((k) => !STRINGS.nested.kind?.includes(k)), [], 'unnamed probe error kind');
});

test('the status line reads the backoff peak next to the live factor', () => {
  // Pinned on the source on purpose (app.js is not imported anywhere testable): the status
  // line must keep both numbers side by side — the live factor decays back toward 1 as the
  // line recovers, so without the sweep's own high-water mark next to it the operator sees
  // only where the line is NOW, not how far it pushed the scan (the 1.7.6/1.7.7 story).
  const detail = js.slice(js.indexOf('detail: (o) =>'), js.indexOf('\n', js.indexOf('detail: (o) =>')));
  assert.match(detail, /backoff ×\$\{o\.backoff\} \(peak ×\$\{o\.peak\}\)/, `status-line template lost the peak: ${detail}`);
  assert.match(js, /peak: dec\(st\.peakBackoffFactor \?\? st\.backoffFactor \?\? 1, 2\)/, 'the peak must fall back across snapshot ages instead of rendering NaN');
});

test('rejection reasons from scoring.ts all have a reader', () => {
  const scoring = readFileSync(join(guiDir, '..', 'core', 'scoring.ts'), 'utf8');
  // Every `reasons.push(...)` template must be matched by a branch in reasonLabel().
  const pushes = [...scoring.matchAll(/reasons\.push\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(pushes.length >= 7, 'expected the scoring reasons to still be there');
  const label = js.slice(js.indexOf('function reasonLabel('), js.indexOf('function messageLabel('));
  for (const push of pushes) {
    const literal = /^'([^']+)'$/.exec(push.trim())?.[1] ?? /^`([^`]+)`$/.exec(push.trim())?.[1];
    if (!literal) continue;
    assert.ok(label.includes(literal.split(' ')[0]), `reasonLabel() does not handle: ${literal}`);
  }
});

test('live status messages from scanner.ts all have a reader', () => {
  const scanner = readFileSync(join(guiDir, '..', 'core', 'scanner.ts'), 'utf8');
  const literals = [...scanner.matchAll(/stats\.message = (.*)$/gm)].flatMap((m) =>
    [...m[1].matchAll(/'([^']+)'|`([^`]+)`/g)].map((s) => (s[1] ?? s[2]).replace(/\$\{[^}]*\}/g, '1')),
  );
  assert.ok(literals.length >= 5, 'expected the scanner status messages to still be there');
  const label = js.slice(js.indexOf('function messageLabel('), js.indexOf('/**', js.indexOf('function messageLabel(')));
  for (const literal of literals) {
    assert.ok(label.includes(literal.split(' ')[0]), `messageLabel() does not handle: ${literal}`);
  }
});

test('styles referenced from the markup exist in the stylesheet', () => {
  const classes = new Set([...css.matchAll(/\.([a-z][\w-]*)/g)].map((m) => m[1]));
  const used = new Set(
    [...`${html}`.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean),
  );
  // `hidden` is the one class used as a state hook; everything else must be styled.
  const missing = [...used].filter((c) => c !== 'hidden' && !classes.has(c));
  assert.deepEqual(missing, [], `classes used in index.html but not in styles.css: ${missing.join(', ')}`);
});

// "defined but never read" is a dead-code concern (test/deadcode.test.ts); this one is
// about the two themes staying in step.
test('both themes theme the same colours', () => {
  const dark = css.slice(css.indexOf(':root {'), css.indexOf(":root[data-theme='light']"));
  const light = css.slice(css.indexOf(":root[data-theme='light']"), css.indexOf('*,\n*::before'));
  const tokens = (block: string) => new Set([...block.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
  // Scale, type and motion tokens only need to exist once; colours must be themed.
  const scale = /^--(s-|r-|row-|control-|fs-|font-|t$|t-|ease|rail-)/;
  const colors = [...tokens(dark)].filter((t) => !scale.test(t));
  const missing = colors.filter((t) => !tokens(light).has(t));
  assert.deepEqual(missing, [], `light theme is missing colours: ${missing.join(', ')}`);
});

test('the GUI loads nothing from a CDN', () => {
  // A URL in a *fetching* position is the failure mode (CDN fonts, scripts, styles).
  // Data values such as the default speed-test download URL are user-visible config,
  // not assets, and the attacker-facing scanner itself depends on them.
  const fetchy = /(?:src|href)=["']https?:\/\/(?!127\.0\.0\.1|localhost|www\.w3\.org)|@import|url\(\s*["']?https?:\/\//i;
  for (const [name, text] of [
    ['index.html', html],
    ['app.js', js],
    ['styles.css', css],
    ['report.html', report],
  ] as const) {
    assert.ok(!fetchy.test(text), `${name} must not pull assets from an external origin`);
  }
  // No webfonts at all: the UI is English-only, so the platform font stack carries it
  // and the GUI ships zero font bytes (it used to self-host four Vazirmatn weights).
  assert.ok(!/@font-face|url\(\s*['"]?\/fonts\//.test(css), 'the GUI must not ship webfonts');
  assert.ok(!/Vazirmatn/.test(css), 'the Persian webfont is gone and must not come back');
});
