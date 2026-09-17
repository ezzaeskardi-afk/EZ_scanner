/**
 * Tests for the OpenUI Lang report builder.
 *
 * There is no OpenUI parser in this repo (their `@openuidev/lang-core` ships an
 * install-time telemetry hook, so we do not depend on it), so these tests do the
 * two things a parser would catch for us:
 *
 *   1. grammar — every line is `identifier = expression`, no identifier is
 *      defined twice, every referenced identifier exists;
 *   2. library contract — only components from OpenUI's `openuiChatLibrary` are
 *      used, the root is a single `Card([...])`, table columns are the same
 *      length (the library drops columns that are not), and charts only ever get
 *      numbers.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOpenUiReport } from '../src/core/openui.ts';
import { createResult, finalize, recordAttempt } from '../src/core/scoring.ts';
import { DEFAULT_CONFIG, type IpResult, type ScanConfig, type ScanStats } from '../src/core/types.ts';

const cfg: ScanConfig = { ...DEFAULT_CONFIG, sni: 'speed.example', tries: 3, minSuccesses: 2, minScore: 0 };

const stats = (over: Partial<ScanStats> = {}): ScanStats => ({
  phase: 'done',
  total: 0,
  done: 0,
  ok: 0,
  failed: 0,
  healthy: 0,
  startedAt: 0,
  elapsedMs: 0,
  rate: 0,
  etaMs: 0,
  inflight: 0,
  paused: false,
  backoffFactor: 1,
  offline: false,
  message: '',
  failuresByKind: {},
  ...over,
});

function healthyResult(ip: string, latency: number, over: Partial<IpResult> = {}): IpResult {
  const r = createResult(ip, 443, cfg.sni);
  recordAttempt(r, { ok: true, latencyMs: latency, httpStatus: 200, colo: 'FRA' });
  recordAttempt(r, { ok: true, latencyMs: latency + 5, httpStatus: 200, colo: 'FRA' });
  finalize(r, cfg);
  return Object.assign(r, over);
}

function deadResult(ip: string, kind: 'timeout' | 'reset'): IpResult {
  const r = createResult(ip, 443, cfg.sni);
  recordAttempt(r, { ok: false, latencyMs: 4000, error: kind });
  recordAttempt(r, { ok: false, latencyMs: 4000, error: kind });
  recordAttempt(r, { ok: false, latencyMs: 4000, error: kind });
  finalize(r, cfg);
  return r;
}

/** Component names the report is allowed to emit (all from `openuiChatLibrary`). */
const ALLOWED = new Set([
  'Card',
  'CardHeader',
  'TextContent',
  'Callout',
  'Separator',
  'TagBlock',
  'Table',
  'Col',
  'BarChart',
  'Series',
  'InlineHeader',
  'SnippetCardBlock',
  'SnippetCardItem',
  'IconText',
  'Icon',
  'BoldText',
]);

/** Built-ins / literals that are not identifiers. */
const LITERALS = new Set(['true', 'false', 'null', 'root']);

function stripStrings(expr: string): string {
  return expr.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function parseDoc(code: string): Map<string, string> {
  const statements = new Map<string, string>();
  const lines = code.split('\n').filter((line) => line.trim());
  assert.ok(lines.length > 3, 'report should have several statements');
  for (const raw of lines) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(raw.trim());
    assert.ok(m, `not an OpenUI Lang statement: ${raw}`);
    assert.ok(!statements.has(m![1]), `identifier ${m![1]} defined twice`);
    statements.set(m![1], m![2]);
  }
  return statements;
}

function assertWellFormed(code: string): Map<string, string> {
  const statements = parseDoc(code);
  const body = stripStrings(code);

  // balanced brackets/braces/parens
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    const opens = body.split(open).length - 1;
    const closes = body.split(close).length - 1;
    assert.equal(opens, closes, `unbalanced ${open}${close} in report`);
  }

  // every referenced identifier is defined
  for (const [id, expr] of statements) {
    for (const match of stripStrings(expr).matchAll(/([A-Za-z_][A-Za-z0-9_]*)(\s*\()?/g)) {
      const [, name, call] = match;
      if (call) {
        assert.ok(ALLOWED.has(name), `unknown component ${name} in ${id}`);
        continue;
      }
      if (LITERALS.has(name)) continue;
      assert.ok(statements.has(name), `${id} references undefined identifier ${name}`);
    }
  }

  // root contract: one Card([...]) listing defined children
  const root = statements.get('root');
  assert.ok(root, 'report must define root');
  assert.match(root!, /^Card\(\[/);
  const rootRefs = root!.slice(root!.indexOf('[') + 1, root!.lastIndexOf(']')).split(',').map((s) => s.trim());
  assert.ok(rootRefs.length >= 2, 'root Card should have children');
  for (const ref of rootRefs) assert.ok(statements.has(ref), `root references missing ${ref}`);

  return statements;
}

test('healthy scan builds a well-formed dashboard with chart + table', () => {
  const results = [
    healthyResult('104.16.1.1', 80),
    healthyResult('104.16.1.2', 210),
    healthyResult('104.16.1.3', 640),
    healthyResult('104.16.1.4', 1700),
  ];
  const report = buildOpenUiReport({
    stats: stats({ total: 100, done: 100, ok: 12, healthy: 4 }),
    config: cfg,
    results,
    generatedAt: 0,
    version: '1.0.0',
  });
  const statements = assertWellFormed(report.code);

  assert.deepEqual(report.counts, { addresses: 100, reachable: 4, healthy: 4, failures: 0, rows: 4 });
  assert.match(statements.get('verdict')!, /^Callout\("success"/);
  assert.match(statements.get('chart')!, /^BarChart\(chartLabels, \[chartSeries\]/);
  assert.match(statements.get('topTable')!, /^Table\(\[Col\(/);

  // chart series must be numbers, and the histogram must cover every address
  const series = [...statements.get('chartSeries')!.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]));
  assert.equal(series.length, 6, 'six latency buckets');
  assert.equal(
    series.reduce((a, b) => a + b, 0),
    4,
  );

  // every table column has one cell per row
  const cols = [...statements.get('topTable')!.matchAll(/Col\("(?:[^"\\]|\\.)*",\s*\[([^\]]*)\]/g)];
  assert.equal(cols.length, 6, 'no throughput column when no speed test ran');
  for (const col of cols) assert.equal(col[1].split(',').length, 4);
});

test('the throughput column appears once a speed test has run', () => {
  const measured = healthyResult('104.16.5.1', 110, { downMbps: 42.5, upMbps: 7.2 });
  const report = buildOpenUiReport({
    stats: stats({ total: 1, done: 1, ok: 1, healthy: 1 }),
    config: cfg,
    results: [measured],
    generatedAt: 0,
  });
  const statements = assertWellFormed(report.code);
  assert.match(statements.get('topTable')!, /Col\("Down", \["42\.5Mbps"\]\)/);
});

test('no clean addresses produces a warning verdict that names the gates', () => {
  const blocked = [deadResult('104.16.9.1', 'reset'), deadResult('104.16.9.2', 'reset')];
  blocked[0].reasons = ['loss 100% > 50%'];
  blocked[1].reasons = ['loss 100% > 50%', 'latency 4000ms > 1800ms'];
  const report = buildOpenUiReport({
    stats: stats({ total: 2, done: 2, failed: 2 }),
    config: cfg,
    results: blocked,
    generatedAt: 0,
  });
  const statements = assertWellFormed(report.code);
  assert.match(statements.get('verdict')!, /^Callout\("warning"/);
  assert.match(statements.get('verdict')!, /loss 100% > 50% ×2/);
  assert.equal(statements.has('chart'), false, 'no chart without clean addresses');
  assert.match(statements.get('topTable') ?? '', /^$/);
});

test('no answers at all produces an error verdict plus the failure breakdown', () => {
  const report = buildOpenUiReport({
    stats: stats({ total: 50, done: 50, failed: 50, failuresByKind: { timeout: 48, reset: 2 } }),
    config: cfg,
    results: [],
    failures: [deadResult('1.2.3.4', 'timeout'), deadResult('1.2.3.5', 'timeout')],
    generatedAt: 0,
  });
  const statements = assertWellFormed(report.code);
  assert.match(statements.get('verdict')!, /^Callout\("error"/);
  // two sampled addresses x three attempts each
  assert.match(statements.get('verdict')!, /timeout ×6/);
  assert.match(statements.get('failsTable')!, /^Table\(\[Col\(".*", \["timeout"/);
});

test('an untouched scanner renders the idle state without fake numbers', () => {
  const report = buildOpenUiReport({
    stats: stats(),
    config: cfg,
    results: [],
    generatedAt: 0,
  });
  const statements = assertWellFormed(report.code);
  assert.match(statements.get('verdict')!, /^Callout\("neutral"/);
  assert.equal(statements.has('chart'), false);
  assert.equal(statements.has('topTable'), false);
});

test('string payloads are escaped and never break the document', () => {
  const evil = healthyResult('104.16.2.1', 120, { colo: 'FR"A\\B', sni: 'x' });
  const report = buildOpenUiReport({
    stats: stats({ total: 1, done: 1, ok: 1, healthy: 1 }),
    config: { ...cfg, sni: 'he said "hi"\nnext' },
    results: [evil],
    generatedAt: 0,
  });
  assertWellFormed(report.code);
  assert.ok(!report.code.includes('\nnext'), 'newlines inside strings are stripped');
  assert.match(report.code, /FR\\"A\\\\B/);
});

test('the table honours the requested row cap', () => {
  const results = Array.from({ length: 40 }, (_, i) => healthyResult(`104.16.3.${i + 1}`, 100 + i));
  const report = buildOpenUiReport({
    stats: stats({ total: 40, done: 40, healthy: 40 }),
    config: cfg,
    results,
    topN: 5,
    generatedAt: 0,
  });
  assert.equal(report.counts.rows, 5);
  assert.match(report.code, /Cleanest addresses/);
  assertWellFormed(report.code);
});

test('the report is deterministic for the same input', () => {
  const input = {
    stats: stats({ total: 3, done: 3, healthy: 2 }),
    config: cfg,
    results: [healthyResult('104.16.4.1', 90), healthyResult('104.16.4.2', 300), deadResult('104.16.4.3', 'timeout')],
    generatedAt: 1_700_000_000_000,
  };
  assert.equal(buildOpenUiReport(input).code, buildOpenUiReport(input).code);
});
