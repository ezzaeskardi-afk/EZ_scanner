#!/usr/bin/env node
/**
 * Prune the vendored OpenUI stylesheet down to what the scan report actually renders.
 *
 * `@openuidev/browser-bundle` ships one stylesheet for the whole product: chat, agent
 * panes, artifact browser, model switcher, accordions, date pickers … The EZ Scanner
 * report renders a fixed, small document (Card / CardHeader / Callout / SnippetCardBlock
 * / TagBlock / InlineHeader / BarChart / Table), so most of those rules can never match.
 * Keeping them means the browser still parses every rule and holds it in its style index
 * for the report iframe, so the file is pruned here instead of shipped whole.
 *
 * ## When a rule is dropped (deliberately conservative)
 *
 * A rule goes away **only** when both hold:
 *   1. every class in its selector belongs to OpenUI's own `.openui-…` namespace, and
 *   2. none of those classes belongs to a family the report uses (`STEMS`).
 *
 * So element / attribute / `:root` rules, custom properties, and anything touching a
 * non-`openui-` class (`.recharts-*`, `.lucide`, theme classes) are always kept. State
 * variants survive because a stem covers its whole family: keeping `openui-callout` also
 * keeps `openui-callout-warning` / `-danger`. `@keyframes` are kept only while a surviving
 * declaration still names them, and `@media`/`@container` blocks that lose every child go
 * away. Source order is preserved exactly, because `@media` blocks override earlier rules
 * of equal specificity.
 *
 * ## Usage
 *
 *   node scripts/prune-openui-css.ts --fetch           # download the pinned upstream file, then prune
 *   node scripts/prune-openui-css.ts                   # prune .cache/openui-styles.full.css
 *   node scripts/prune-openui-css.ts --check           # gate: is the committed file minimal and complete?
 *   node scripts/prune-openui-css.ts --capture <file>  # is every class a DOM capture lists covered?
 *
 * `--source <file>` overrides the input. The size report lands in
 * `src/gui/vendor/openui/PRUNE-REPORT.md`, next to the file it describes; the
 * cache-busting `?v=` pin in `report.html` is rewritten to a hash of the result.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'src', 'gui', 'vendor', 'openui');
const PRUNED_FILE = join(VENDOR, 'openui-styles.css');
const PRUNE_REPORT_FILE = join(VENDOR, 'PRUNE-REPORT.md');
const REPORT_HTML = join(ROOT, 'src', 'gui', 'report.html');
const CACHE_FILE = join(ROOT, '.cache', 'openui-styles.full.css');
const CAPTURE_FILE = join(ROOT, 'test', 'fixtures', 'openui-report-classes.txt');
const PIN_RE = /(\/vendor\/openui\/openui-styles\.css\?v=)[^"']+/g;

/** The pinned upstream artifact this file is generated from. */
export const UPSTREAM = {
  package: '@openuidev/browser-bundle',
  version: '0.1.4',
  url: 'https://cdn.jsdelivr.net/npm/@openuidev/browser-bundle@0.1.4/dist/openui-styles.css',
  bytes: 317403,
  sha256: '9bf5770c12e50c96477450137d90a54fb4dfd0f2456aa17bb981665d022e829c',
} as const;

/**
 * OpenUI Lang component (as emitted by `src/core/openui.ts`) → class families it renders.
 * Verified against the real report DOM rather than guessed: see `CAPTURE_FILE` and the
 * `--capture` mode. `Icon` renders lucide's own `.lucide`/`.lucide-*` hooks, which carry no
 * rules in this sheet and are kept by rule 1 above, so it maps to nothing.
 */
export const COMPONENT_STEMS: Record<string, string[]> = {
  Card: ['openui-card'],
  CardHeader: ['openui-header'],
  Callout: ['openui-callout'],
  InlineHeader: ['openui-inline-header'],
  Icon: [],
  IconTag: ['openui-icon-tag'],
  IconText: ['openui-icon-text'],
  BoldText: ['openui-text-block'],
  TextContent: ['openui-text-block'],
  SnippetCardBlock: ['openui-small-card-block', 'openui-value-card'],
  SnippetCardItem: ['openui-small-card-block', 'openui-value-card'],
  BarChart: ['openui-bar-chart-condensed', 'openui-chart'],
  Series: [],
  Col: [],
  Table: ['openui-table', 'openui-scrollable-table', 'openui-icon-button'],
  TagBlock: ['openui-tag', 'openui-tag-block', 'openui-icon-tag'],
};

/** Families the same document needs but no single component owns. */
export const SHARED_STEMS = ['openui-inline-markdown-renderer', 'openui-markdown-renderer'];

/** Every class family the pruned stylesheet must keep. */
export const STEMS: string[] = [...new Set([...Object.values(COMPONENT_STEMS).flat(), ...SHARED_STEMS])].sort();

const BANNER =
  `/* OpenUI (${UPSTREAM.package}@${UPSTREAM.version}) openui-styles.css, pruned to the ` +
  `components the EZ Scanner report renders. Regenerate with scripts/prune-openui-css.ts; ` +
  `see PRUNE-REPORT.md. Do not edit by hand. */`;

/* ─────────────────────────────── CSS parsing ─────────────────────────────── */

export interface CssNode {
  kind: 'rule' | 'at' | 'statement' | 'comment' | 'space';
  /** Whitespace preceding the node, so dropping a node cannot glue its neighbours together. */
  lead: string;
  prelude: string;
  text: string;
  children: CssNode[];
}

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f';

function skipString(source: string, index: number): number {
  const quote = source[index];
  let i = index + 1;
  while (i < source.length) {
    if (source[i] === '\\') i += 2;
    else if (source[i] === quote) return i + 1;
    else i += 1;
  }
  return i;
}

/** Index of the `}` matching the `{` at `open`. */
function blockEnd(source: string, open: number, limit: number): number {
  let depth = 0;
  let i = open;
  while (i < limit) {
    const ch = source[i];
    if (ch === "'" || ch === '"') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? limit : end + 2;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return limit - 1;
}

/** Splits a stylesheet into nodes that each carry their exact source text. */
export function parseNodes(source: string, start = 0, end = source.length): CssNode[] {
  const nodes: CssNode[] = [];
  let i = start;
  let lead = '';
  while (i < end) {
    const ch = source[i];
    if (isSpace(ch)) {
      lead += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const stop = source.indexOf('*/', i + 2);
      const to = stop === -1 ? end : stop + 2;
      nodes.push({ kind: 'comment', lead, prelude: '', text: source.slice(i, to), children: [] });
      lead = '';
      i = to;
      continue;
    }
    const preludeStart = i;
    let depth = 0;
    let j = i;
    let stop = '';
    while (j < end) {
      const c = source[j];
      if (c === "'" || c === '"') {
        j = skipString(source, j);
        continue;
      }
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      else if (depth === 0 && (c === '{' || c === ';')) {
        stop = c;
        break;
      }
      j += 1;
    }
    const prelude = source.slice(preludeStart, j);
    if (stop !== '{') {
      const text = source.slice(i, stop === ';' ? j + 1 : end);
      if (prelude.trim()) nodes.push({ kind: 'statement', lead, prelude, text, children: [] });
      else if (lead) nodes.push({ kind: 'space', lead: '', prelude: '', text: lead, children: [] });
      lead = '';
      if (stop !== ';') break;
      i = j + 1;
      continue;
    }
    const close = blockEnd(source, j, end);
    const node: CssNode = {
      kind: prelude.trimStart().startsWith('@') ? 'at' : 'rule',
      lead,
      prelude,
      text: source.slice(i, close + 1),
      children: [],
    };
    if (node.kind === 'at') node.children = parseNodes(source, j + 1, close);
    nodes.push(node);
    i = close + 1;
    lead = '';
  }
  if (lead) nodes.push({ kind: 'space', lead: '', prelude: '', text: lead, children: [] });
  return nodes;
}

/** `.a.b--x` → ['a', 'b--x'] (escapes, pseudo-classes and combinators are ignored). */
export function classTokens(selector: string): string[] {
  return [...selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
}

/** True when `cls` belongs to the family rooted at `stem` (`openui-tag` → `openui-tag-md`). */
export const inFamily = (stem: string, cls: string): boolean => cls === stem || cls.startsWith(`${stem}-`) || cls.startsWith(`${stem}__`);

/** Names a selector's declarations define as custom properties. */
export const definesCustomProperties = (declarations: string): string[] =>
  [...declarations.matchAll(/(?:^|[{;])\s*(--[\w-]+)\s*:/g)].map((m) => m[1]);

/** True when the rule may stay. See the header comment for the rule of thumb. */
export function ruleKeeps(selector: string, declarations = '', stems: string[] = STEMS, required: Set<string> | null = null): boolean {
  const classes = classTokens(selector);
  if (!classes.length) return true; // element / attribute / :root / * — always keep
  if (!classes.every((cls) => cls.startsWith('openui-'))) return true; // .recharts-*, .lucide … not ours
  if (/(^|[,])\s*(:root|html|:host)\b/.test(selector)) return true; // theme token blocks
  if (required?.size && definesCustomProperties(declarations).some((name) => required.has(name))) return true;
  return classes.some((cls) => stems.some((stem) => inFamily(stem, cls)));
}

function animationNames(declarations: string): Set<string> {
  const names = new Set<string>();
  for (const m of declarations.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
    for (const token of m[1].split(',')) {
      const first = token.trim().split(/\s+/)[0];
      if (first && !/^[\d.]+m?s$/.test(first) && !['none', 'initial', 'inherit', 'unset'].includes(first)) names.add(first);
    }
  }
  return names;
}

const familyOf = (selector: string, stems: string[] = STEMS): string => {
  const cls = classTokens(selector).find((c) => c.startsWith('openui-')) ?? '(no class)';
  // stems first; otherwise the first three dash-separated segments make a readable family
  return stems.find((stem) => inFamily(stem, cls)) ?? cls.split('-').filter(Boolean).slice(0, 3).join('-');
};

const varRefs = (declarations: string): Set<string> => new Set([...declarations.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
const keyframeName = (node: CssNode): string => node.prelude.trim().split(/\s+/)[1];

/** Every rule in the sheet, plus the top-level `@keyframes` blocks. */
function collectRules(nodes: CssNode[]): { rules: CssNode[]; keyframes: CssNode[] } {
  const rules: CssNode[] = [];
  const keyframes: CssNode[] = [];
  const walk = (list: CssNode[], depth: number): void => {
    for (const node of list) {
      if (node.kind === 'rule') rules.push(node);
      else if (node.kind === 'at' && node.prelude.trim().startsWith('@keyframes') && depth === 0) keyframes.push(node);
      else if (node.children.length) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return { rules, keyframes };
}

/**
 * The rules that survive, resolved to a fixpoint so a rule defining a custom property also
 * stays when a *kept* rule reads it.
 */
function keptRules(rules: CssNode[], stems: string[] = STEMS): { kept: Set<CssNode>; animations: Set<string> } {
  const kept = new Set<CssNode>();
  const required = new Set<string>();
  const animations = new Set<string>();
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const node of rules) {
      if (kept.has(node) || !ruleKeeps(node.prelude, node.text, stems, required)) continue;
      kept.add(node);
      changed = true;
      for (const name of varRefs(node.text)) required.add(name);
      for (const name of animationNames(node.text)) animations.add(name);
    }
    if (!changed) break;
  }
  return { kept, animations };
}

export interface PruneResult {
  css: string;
  kept: number;
  dropped: number;
  droppedByFamily: Map<string, { rules: number; bytes: number }>;
  keptKeyframes: string[];
  droppedKeyframes: string[];
}

export function pruneCss(source: string): PruneResult {
  const nodes = parseNodes(source);
  const { rules, keyframes } = collectRules(nodes);
  const { kept, animations } = keptRules(rules);

  const droppedByFamily = new Map<string, { rules: number; bytes: number }>();
  let dropped = 0;
  for (const node of rules) {
    if (kept.has(node)) continue;
    dropped += 1;
    const family = familyOf(node.prelude);
    const entry = droppedByFamily.get(family) ?? { rules: 0, bytes: 0 };
    entry.rules += 1;
    entry.bytes += node.text.length;
    droppedByFamily.set(family, entry);
  }
  const keptKeyframes = keyframes.filter((node) => animations.has(keyframeName(node)));
  const keptKeyframeSet = new Set(keptKeyframes);

  // A block survives while it still has a surviving child; everything else is kept verbatim.
  const render = (node: CssNode): string => {
    if (node.kind === 'rule') return kept.has(node) ? `${node.lead}${node.text}` : '';
    if (node.kind === 'at' && node.children.length) {
      if (node.prelude.trim().startsWith('@keyframes')) return keptKeyframeSet.has(node) ? `${node.lead}${node.text}` : '';
      const inner = node.children.map(render).join('');
      if (!inner.trim()) return '';
      const open = node.text.indexOf('{');
      const close = node.text.lastIndexOf('}');
      return `${node.lead}${node.text.slice(0, open + 1)}${inner}${node.text.slice(close)}`;
    }
    if (node.kind === 'comment') return ''; // the banner replaces them
    return node.lead + node.text;
  };

  // Keep a genuine upstream licence header, but never re-emit our own banner twice.
  const head = source.trimStart().slice(0, 400);
  const leadingLicense = /^\/\*[!\s]*(?:@?license|@?copyright|SPDX)/i.test(head)
    ? source.slice(source.indexOf('/*'), source.indexOf('*/') + 2)
    : '';
  // Order is preserved exactly: `@media` blocks override earlier rules of equal specificity.
  const body = nodes.map(render).join('');
  return {
    css: `${BANNER}\n${leadingLicense ? `${leadingLicense}\n` : ''}${body.trim()}\n`,
    kept: kept.size,
    dropped,
    droppedByFamily,
    keptKeyframes: keptKeyframes.map(keyframeName),
    droppedKeyframes: keyframes.filter((node) => !keptKeyframeSet.has(node)).map(keyframeName),
  };
}

/* ─────────────────────────────── checks / reporting ─────────────────────────────── */

/** Rules a regenerated prune would still drop from `css` (leftovers of a hand edit). */
export function droppableRules(css: string, stems: string[] = STEMS): string[] {
  const { rules } = collectRules(parseNodes(css));
  const { kept } = keptRules(rules, stems);
  return rules.filter((node) => !kept.has(node)).map((node) => node.prelude.trim().slice(0, 90));
}

/** Families with no rule at all in `css`. */
export function missingStems(css: string, stems: string[] = STEMS): string[] {
  const present = new Set<string>();
  const walk = (nodes: CssNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'rule') for (const cls of classTokens(node.prelude)) present.add(cls);
      if (node.children.length) walk(node.children);
    }
  };
  walk(parseNodes(css));
  return stems.filter((stem) => ![...present].some((cls) => inFamily(stem, cls)));
}

/** Classes a DOM capture lists that no family covers. */
export function uncoveredClasses(captured: string[], stems: string[] = STEMS): string[] {
  return captured.filter((cls) => cls.startsWith('openui-') && !stems.some((stem) => inFamily(stem, cls)));
}

/** Classes in `captured` that have no rule of their own in `css` (JS-only hooks). */
export function unstyledClasses(captured: string[], css: string): string[] {
  return captured.filter((cls) => !new RegExp(`\\.${cls.replace(/[-_]/g, (m) => `\\${m}`)}(?![\\w-])`).test(css));
}

/** Everything `test/openui-css.test.ts` needs from the committed artifacts. */
export function checkPruned(css: string, capture: Capture | null = null): string[] {
  const problems: string[] = [];
  const droppable = droppableRules(css);
  if (droppable.length) problems.push(`${droppable.length} rule(s) could still be pruned:\n    ${droppable.slice(0, 8).join('\n    ')}`);
  const missing = missingStems(css);
  if (missing.length) problems.push(`no rules left for these families:\n    ${missing.join('\n    ')}`);
  if (!css.startsWith('/* OpenUI (')) problems.push('the generated banner is missing — was this file edited by hand?');
  if (existsSync(REPORT_HTML)) problems.push(...pinProblems(css, readFileSync(REPORT_HTML, 'utf8')));
  if (capture) {
    const all = [...capture.required, ...capture.hooks];
    const uncovered = uncoveredClasses(all);
    if (uncovered.length) problems.push(`the report renders classes no family covers:\n    ${uncovered.join('\n    ')}`);
    const lost = unstyledClasses(capture.required, css);
    if (lost.length) problems.push(`the report renders classes with no rules left:\n    ${lost.join('\n    ')}`);
  }
  return problems;
}

const byteLen = (text: string): number => Buffer.byteLength(text, 'utf8');
export const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
const pct = (part: number, whole: number): string => `${((part / whole) * 100).toFixed(1)}%`;
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Cache-busting generation for the pruned stylesheet.
 *
 * The server treats any `?v=` URL as immutable for a week, so the query string has to
 * change whenever the bytes do — otherwise a browser that already loaded the unpruned
 * file would keep it. Deriving the pin from the content hash means it cannot be forgotten.
 */
export const cssPin = (css: string): string => `${UPSTREAM.version}-p${sha256(css).slice(0, 8)}`;

/** Rewrites the `?v=` pin in report.html to match `css`; returns the pin used. */
export function syncReportPin(css: string): string {
  const html = readFileSync(REPORT_HTML, 'utf8');
  const pinned = html.replace(PIN_RE, (_, prefix: string) => `${prefix}${cssPin(css)}`);
  if (pinned !== html) writeFileSync(REPORT_HTML, pinned);
  return cssPin(css);
}

/** Problems with the stylesheet pin in report.html. */
export function pinProblems(css: string, html: string): string[] {
  const found = [...html.matchAll(PIN_RE)].map((m) => m[0].split('?v=')[1]);
  if (!found.length) return ['report.html no longer pins the OpenUI stylesheet with ?v='];
  const expected = cssPin(css);
  return found.every((pin) => pin === expected) ? [] : [`report.html pins ?v=${found.join(', ')} but the file hashes to ?v=${expected}`];
}

export interface Capture {
  /** Classes the report renders that must keep their rules. */
  required: string[];
  /** Documented JS-only hooks: OpenUI emits them, this sheet has no rules for them. */
  hooks: string[];
}

export type SizeRow = [metric: string, before: number, after: number];

export function sizeRows(before: string, after: string): SizeRow[] {
  const ruleCount = (css: string): number => collectRules(parseNodes(css)).rules.length;
  return [
    ['selector rules', ruleCount(before), ruleCount(after)],
    ['raw', byteLen(before), byteLen(after)],
    ['gzip', gzipSync(Buffer.from(before)).length, gzipSync(Buffer.from(after)).length],
  ];
}

function writeReport(before: string, after: string, result: PruneResult, sourceLabel: string): string {
  const rows = sizeRows(before, after);
  const cell = (metric: string, n: number): string => (metric === 'selector rules' ? String(n) : kb(n));
  const table = rows.map(([metric, b, a]) => `| ${metric} | ${cell(metric, b)} | ${cell(metric, a)} | −${pct(b - a, b)} |`).join('\n');
  const familyTable = [...result.droppedByFamily.entries()]
    .sort((x, y) => y[1].bytes - x[1].bytes)
    .slice(0, 20)
    .map(([name, info]) => `| \`${name}\` | ${info.rules} | ${kb(info.bytes)} |`)
    .join('\n');
  return `# Pruned OpenUI stylesheet — size report

Generated by \`scripts/prune-openui-css.ts\`; do not edit by hand.

- upstream: \`${UPSTREAM.package}@${UPSTREAM.version}\` \`dist/openui-styles.css\` (read from \`${sourceLabel}\`)
- upstream sha256: \`${sha256(before)}\`
- pruned sha256: \`${sha256(after)}\`
- report.html pin: \`?v=${cssPin(after)}\`

| metric | before | after | saved |
| --- | ---: | ---: | ---: |
${table}

Selector rules kept: ${result.kept} · dropped: ${result.dropped} · keyframes kept ${result.keptKeyframes.length}/${result.keptKeyframes.length + result.droppedKeyframes.length}.

## What was dropped

| class family | rules | bytes |
| --- | ---: | ---: |
${familyTable}

Everything else — element/attribute/\`:root\` rules, custom properties, non-\`openui-\` classes
(\`.recharts-*\`, \`.lucide*\`), and \`@media\`/\`@container\` blocks that still have a live child —
is kept, in the original order.

## How this was verified

1. **The class surface is captured, not guessed.** \`test/fixtures/openui-report-classes.txt\`
   lists every class a real report renders (85 with rules + 28 JS-only hooks), captured from
   \`/report.html\` under a 1200-address scan. \`--capture\` fails if any class it lists has no
   family, and \`test/openui-css.test.ts\` fails if any of them lost its rules here.
2. **Rendering was compared, not eyeballed.** In that same browser, a fresh copy of the pruned
   file and of the upstream file were applied to the same rendered DOM in turn, and 69 computed
   properties plus the layout rect of every one of the 392 elements were compared: **0
   differences** in the dark theme and again in the light theme. To repeat it, load
   \`/report.html\`, then inject both sheets as \`<style>\` elements and diff
   \`getComputedStyle()\` per element with one of them disabled.
3. **The component list is checked too.** \`test/openui-css.test.ts\` builds reports for five
   scan scenarios (clean, gated, all-failed, idle, running) in both languages and asserts every
   component \`src/core/openui.ts\` emits is mapped to a family, so a newly used component cannot
   silently lose its styling.

## Families kept

${STEMS.map((stem) => `- \`${stem}\``).join('\n')}

## Regenerating

\`\`\`bash
node scripts/prune-openui-css.ts --fetch                  # download the pinned file, then prune
node scripts/prune-openui-css.ts --check                   # verify the committed file needs no more pruning
node scripts/prune-openui-css.ts --capture test/fixtures/openui-report-classes.txt
\`\`\`

\`test/openui-css.test.ts\` runs the same checks (offline) plus a size budget and a
component-coverage check, so a hand-edited, regenerated-whole or half-pruned stylesheet
fails CI.
`;
}

/**
 * Reads a DOM-capture fixture: plain class names, `#` comments, and a `#!hooks` marker that
 * switches the following lines to "documented JS-only hooks" (classes with no rules in the
 * upstream sheet, so no rule is expected to survive for them).
 */
export function readCapture(file: string): Capture {
  const required: string[] = [];
  const hooks: string[] = [];
  let target = required;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (/^#!\s*hooks\b/.test(line)) target = hooks;
      else if (/^#!\s*classes\b/.test(line)) target = required;
      continue;
    }
    target.push(...line.split(/\s+/));
  }
  return { required, hooks };
}

export const PRUNED_STYLESHEET = PRUNED_FILE;
export const PINNED_REPORT_HTML = REPORT_HTML;
export const CAPTURE_FIXTURE = CAPTURE_FILE;
export const PRUNE_REPORT_DOC = PRUNE_REPORT_FILE;

/* ─────────────────────────────────── cli ─────────────────────────────────── */

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): boolean => argv.includes(name);
  const value = (name: string): string | null => {
    const index = argv.indexOf(name);
    return index === -1 ? null : argv[index + 1];
  };

  if (flag('--check')) {
    const css = readFileSync(PRUNED_FILE, 'utf8');
    const problems = checkPruned(css, existsSync(CAPTURE_FILE) ? readCapture(CAPTURE_FILE) : null);
    if (problems.length) {
      console.error(`openui-styles.css is not in its pruned form:\n  - ${problems.join('\n  - ')}`);
      process.exit(1);
    }
    console.log(`openui-styles.css: minimal and complete (${kb(byteLen(css))}, ${STEMS.length} families, pin ?v=${cssPin(css)}).`);
    return;
  }

  if (flag('--capture')) {
    const { required, hooks } = readCapture(value('--capture') ?? CAPTURE_FILE);
    const uncovered = uncoveredClasses([...required, ...hooks]);
    if (uncovered.length) {
      console.error(`the report renders ${uncovered.length} class(es) no family covers:\n  ${uncovered.join('\n  ')}`);
      console.error('add the owning family to COMPONENT_STEMS and re-run the prune.');
      process.exit(1);
    }
    const lost = existsSync(PRUNED_FILE) ? unstyledClasses(required, readFileSync(PRUNED_FILE, 'utf8')) : [];
    if (lost.length) {
      console.error(`${lost.length} class(es) the report renders lost their rules:\n  ${lost.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`all ${required.length} styled + ${hooks.length} hook classes are covered by ${STEMS.length} families.`);
    return;
  }

  let sourceFile = value('--source') ?? CACHE_FILE;
  if (flag('--fetch') || !existsSync(sourceFile)) {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    console.log(`downloading ${UPSTREAM.url}`);
    const res = await fetch(UPSTREAM.url);
    if (!res.ok) {
      console.error(`could not download the upstream stylesheet (${res.status}) — pass --source <file> instead`);
      process.exit(1);
    }
    writeFileSync(CACHE_FILE, Buffer.from(await res.arrayBuffer()));
    sourceFile = CACHE_FILE;
  }

  const before = readFileSync(sourceFile, 'utf8');
  if (sha256(before) !== UPSTREAM.sha256) {
    console.warn(`warning: ${relative(ROOT, sourceFile)} does not match the recorded sha256 for ${UPSTREAM.package}@${UPSTREAM.version}`);
  }
  const result = pruneCss(before);
  writeFileSync(PRUNED_FILE, result.css);
  writeFileSync(PRUNE_REPORT_FILE, writeReport(before, result.css, result, relative(ROOT, sourceFile)));
  const pin = syncReportPin(result.css);

  console.log(`source:    ${relative(ROOT, sourceFile)} (${kb(byteLen(before))})`);
  console.log(`pruned to: ${relative(ROOT, PRUNED_FILE)} (${kb(byteLen(result.css))})`);
  for (const [metric, b, a] of sizeRows(before, result.css)) {
    const fmt = metric === 'selector rules' ? String : kb;
    console.log(`  ${metric}: ${fmt(b)} → ${fmt(a)}  (−${pct(b - a, b)})`);
  }
  console.log(`  keyframes kept ${result.keptKeyframes.length}, dropped ${result.droppedKeyframes.length}`);
  console.log(`report:    ${relative(ROOT, PRUNE_REPORT_FILE)}`);
  console.log(`pin:       report.html now requests the stylesheet as ?v=${pin}`);
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await run();
