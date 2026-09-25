/**
 * Gates for the pruned OpenUI stylesheet.
 *
 * `scripts/prune-openui-css.ts` drops the ~76% of OpenUI's stylesheet that the scan report
 * can never match. That is only safe while three things stay true, and each one is a test
 * here rather than a one-off audit:
 *
 *   1. **minimal** — nothing left in the file would be dropped by another run;
 *   2. **complete** — every class family the report renders is still present, and every
 *      component `src/core/openui.ts` can emit is mapped to a family, so a new component
 *      cannot quietly lose its styling;
 *   3. **fresh** — the `?v=` pin in `report.html` matches the file, because the server
 *      caches a pinned URL for a week (a stale pin would keep serving the unpruned file).
 *
 * Everything here is offline: `test/fixtures/openui-report-classes.txt` records the class
 * surface captured from a real rendered report, and the upstream file is not needed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { buildOpenUiReport } from '../src/core/openui.ts';
import { createResult, finalize, recordAttempt } from '../src/core/scoring.ts';
import { DEFAULT_CONFIG, type IpResult, type ScanConfig, type ScanStats } from '../src/core/types.ts';
import {
  CAPTURE_FIXTURE,
  COMPONENT_STEMS,
  PINNED_REPORT_HTML,
  PRUNED_STYLESHEET,
  PRUNE_REPORT_DOC,
  STEMS,
  UPSTREAM,
  checkPruned,
  cssPin,
  pruneCss,
  readCapture,
  sha256,
} from '../scripts/prune-openui-css.ts';

const css = readFileSync(PRUNED_STYLESHEET, 'utf8');
const capture = readCapture(CAPTURE_FIXTURE);

test('the committed OpenUI stylesheet is minimal, complete and pinned to its own hash', () => {
  assert.deepEqual(checkPruned(css, capture), []);
});

test('pruning is idempotent, so --check cannot pass on a half-pruned file', () => {
  const again = pruneCss(css).css;
  assert.equal(again, css, 'a second prune changed the file');
});

test('the pruned stylesheet stays inside its size budget', () => {
  const raw = Buffer.byteLength(css);
  const gzip = gzipSync(Buffer.from(css)).length;
  // Budgets sit just above the current size (102 KB / 9.1 KB) so a re-vendored or
  // un-pruned stylesheet fails loudly instead of silently undoing the win.
  assert.ok(raw < 120 * 1024, `pruned stylesheet grew to ${(raw / 1024).toFixed(1)} KB`);
  assert.ok(gzip < 11 * 1024, `pruned stylesheet gzips to ${(gzip / 1024).toFixed(1)} KB`);
  assert.ok(raw < UPSTREAM.bytes * 0.5, 'pruning should remove at least half of the upstream file');
});

test('the size report describes this exact file', () => {
  const doc = readFileSync(PRUNE_REPORT_DOC, 'utf8');
  assert.ok(doc.includes(sha256(css)), 'PRUNE-REPORT.md is stale — rerun scripts/prune-openui-css.ts');
  assert.ok(doc.includes(UPSTREAM.sha256), 'PRUNE-REPORT.md lost the upstream hash');
  assert.ok(doc.includes(`?v=${cssPin(css)}`), 'PRUNE-REPORT.md lost the pin');
  for (const stem of STEMS) {
    assert.ok(doc.includes(`\`${stem}\``), `PRUNE-REPORT.md does not list ${stem}`);
  }
});

test('report.html asks for the pruned stylesheet under the pinned URL', () => {
  const html = readFileSync(PINNED_REPORT_HTML, 'utf8');
  assert.match(html, new RegExp(`/vendor/openui/openui-styles\\.css\\?v=${cssPin(css)}`));
  assert.ok(/openui-bundle\.min\.js\?v=/.test(html), 'the renderer bundle keeps its own pin');
  assert.ok(!/openui-styles\.css\?v=0\.1\.4"/.test(html), 'the stylesheet must not use the bare upstream pin');
});

/* ── component coverage ────────────────────────────────────────────────────────── */

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
  peakBackoffFactor: 1,
  offline: false,
  message: '',
  failuresByKind: {},
  ...over,
});

function healthy(ip: string, latency: number, over: Partial<IpResult> = {}): IpResult {
  const r = createResult(ip, 443, cfg.sni);
  recordAttempt(r, { ok: true, latencyMs: latency, httpStatus: 200, colo: 'FRA' });
  recordAttempt(r, { ok: true, latencyMs: latency + 5, httpStatus: 200, colo: 'FRA' });
  finalize(r, cfg);
  return Object.assign(r, over);
}

/** Reached the edge, but missed a gate: one success where `minSuccesses` is two. */
function gated(ip: string): IpResult {
  const r = createResult(ip, 443, cfg.sni);
  recordAttempt(r, { ok: true, latencyMs: 300, httpStatus: 200, colo: 'AMS' });
  recordAttempt(r, { ok: false, latencyMs: 3000, error: 'timeout' });
  recordAttempt(r, { ok: false, latencyMs: 3000, error: 'timeout' });
  finalize(r, cfg);
  return r;
}

function dead(ip: string, kind: 'timeout' | 'reset'): IpResult {
  const r = createResult(ip, 443, cfg.sni);
  for (let i = 0; i < 3; i += 1) recordAttempt(r, { ok: false, latencyMs: 4000, error: kind });
  finalize(r, cfg);
  return r;
}

/** Component identifiers used by an OpenUI Lang document. */
const componentsOf = (code: string): string[] => [...new Set([...code.matchAll(/\b([A-Z][A-Za-z]+)\(/g)].map((m) => m[1]))];

test('every OpenUI component the report can emit is mapped to a class family', () => {
  const clean = [healthy('104.16.1.1', 80), healthy('104.16.1.2', 210, { downMbps: 42.5 })];
  const scenarios: Array<Record<string, unknown>> = [
    { stats: stats({ total: 10, done: 10, ok: 4, healthy: 2 }), results: clean },
    { stats: stats({ total: 10, done: 10, ok: 3, healthy: 0 }), results: [gated('104.16.2.1')] },
    {
      stats: stats({ total: 10, done: 10, ok: 0, healthy: 0, failuresByKind: { timeout: 7, reset: 3 } }),
      results: [],
      failures: [dead('104.16.3.1', 'timeout'), dead('104.16.3.2', 'reset')],
    },
    { stats: stats({ phase: 'idle', total: 0, done: 0 }), results: [] },
    { stats: stats({ total: 10, done: 4, ok: 1, healthy: 1, inflight: 3, rate: 6, etaMs: 1000 }), results: [healthy('104.16.4.1', 95)] },
  ];

  const emitted = new Set<string>();
  for (const scenario of scenarios) {
    for (const language of ['fa', 'en'] as const) {
      const report = buildOpenUiReport({ ...scenario, config: cfg, language, topN: 20 } as never);
      for (const name of componentsOf(report.code)) emitted.add(name);
    }
  }

  assert.ok(emitted.size >= 10, `expected the scenarios to exercise the report, saw ${[...emitted].sort().join(', ')}`);
  const unmapped = [...emitted].filter((name) => !(name in COMPONENT_STEMS)).sort();
  assert.deepEqual(
    unmapped,
    [],
    `add these components to COMPONENT_STEMS in scripts/prune-openui-css.ts: ${unmapped.join(', ')}`,
  );
});

test('the captured report surface only uses families the manifest knows about', () => {
  const known = new Set(STEMS);
  const unknown = capture.required.filter((cls) => /^openui-/.test(cls) && ![...known].some((stem) => cls === stem || cls.startsWith(`${stem}-`) || cls.startsWith(`${stem}__`)));
  assert.deepEqual(unknown, []);
  assert.ok(capture.required.length >= 60, 'the fixture looks truncated');
  assert.ok(capture.hooks.length > 0, 'the hook section documents OpenUI classes with no rules');
});
