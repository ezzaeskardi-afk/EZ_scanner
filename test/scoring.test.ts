import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createResult,
  finalize,
  finalizeAll,
  median,
  recordAttempt,
  sortResults,
  stddev,
} from '../src/core/scoring.ts';
import { DEFAULT_CONFIG, type ScanConfig } from '../src/core/types.ts';

const cfg: ScanConfig = { ...DEFAULT_CONFIG, sni: 'x.example', tries: 3, minSuccesses: 2, minScore: 0 };

function ok(latency: number, extra: Partial<import('../src/core/types.ts').ProbeAttempt> = {}) {
  return { ok: true, latencyMs: latency, httpStatus: 200, ...extra };
}

const fail = (error: import('../src/core/types.ts').ProbeErrorKind) => ({ ok: false, latencyMs: 3000, error });

test('median/stddev handle odd, even and empty inputs', () => {
  assert.equal(median([]), 0);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 3);
  assert.equal(stddev([2, 2, 2]), 0);
  assert.ok(stddev([1, 3]) > 0.9);
});

test('two of three successes pass the default gate (the old bug was needing all)', () => {
  const r = createResult('1.2.3.4', 443, 'x.example');
  recordAttempt(r, ok(120));
  recordAttempt(r, ok(140));
  recordAttempt(r, fail('timeout'));
  finalize(r, cfg);
  assert.equal(r.successes, 2);
  assert.equal(r.lossPct, 33);
  assert.equal(r.healthy, true, r.reasons.join(','));
  assert.equal(r.medianLatency, 130);
});

test('one of three successes fails the min-successes gate', () => {
  const r = createResult('1.2.3.4', 443, 'x.example');
  recordAttempt(r, ok(120));
  recordAttempt(r, fail('reset'));
  recordAttempt(r, fail('timeout'));
  finalize(r, cfg);
  assert.equal(r.healthy, false);
  assert.ok(r.reasons.some((x) => /successes 1 < 2/.test(x)), r.reasons.join(','));
});

test('a single attempt (early exit) can still be healthy', () => {
  const single: ScanConfig = { ...cfg, tries: 1, minSuccesses: 1 };
  const r = createResult('1.2.3.4', 443, 'x.example');
  recordAttempt(r, ok(90));
  finalize(r, single);
  assert.equal(r.healthy, true, r.reasons.join(','));
  assert.equal(r.lossPct, 0);
});

test('disabled gates never reject, enabled gates do', () => {
  const twice = (r: ReturnType<typeof createResult>, extra: Partial<import('../src/core/types.ts').ProbeAttempt>) => {
    recordAttempt(r, ok(100, extra));
    recordAttempt(r, ok(120, extra));
  };

  // WebSocket off (default) → wsOk false is not a failure.
  const a = createResult('1.2.3.4', 443, 'x.example');
  twice(a, { wsOk: false });
  finalize(a, cfg);
  assert.equal(a.healthy, true, a.reasons.join(','));

  // WebSocket on → explicit failure.
  const b = createResult('1.2.3.4', 443, 'x.example');
  twice(b, { wsOk: false });
  finalize(b, { ...cfg, requireWs: true });
  assert.equal(b.healthy, false);
  assert.ok(b.reasons.some((r) => /WebSocket/.test(r)));

  // Idle hold off → stable false is only a score penalty.
  const c = createResult('1.2.3.4', 443, 'x.example');
  twice(c, { stable: false });
  finalize(c, cfg);
  assert.equal(c.healthy, true, c.reasons.join(','));

  // Idle hold on → rejection.
  const d = createResult('1.2.3.4', 443, 'x.example');
  twice(d, { stable: false });
  finalize(d, { ...cfg, stabilityMs: 1500 });
  assert.equal(d.healthy, false);
  assert.ok(d.reasons.some((r) => /idle hold/.test(r)));
});

test('latency, loss and score thresholds are enforced', () => {
  const slow = createResult('1.2.3.4', 443, 'x.example');
  recordAttempt(slow, ok(5000));
  recordAttempt(slow, ok(5000));
  recordAttempt(slow, ok(5000));
  finalize(slow, cfg);
  assert.equal(slow.healthy, false);
  assert.ok(slow.reasons.some((r) => /median 5000ms/.test(r)));

  const scored = createResult('1.2.3.4', 443, 'x.example');
  recordAttempt(scored, ok(1500));
  recordAttempt(scored, ok(1500));
  recordAttempt(scored, ok(1500));
  finalize(scored, { ...cfg, minScore: 99 });
  assert.equal(scored.healthy, false);
  assert.ok(scored.reasons.some((r) => /score \d+ < 99/.test(r)));
});

test('an address with no success reports its dominant error', () => {
  const r = createResult('1.2.3.4', 443, 'x.example');
  recordAttempt(r, fail('timeout'));
  recordAttempt(r, fail('timeout'));
  recordAttempt(r, fail('reset'));
  finalize(r, cfg);
  assert.equal(r.healthy, false);
  assert.ok(r.reasons[0].includes('timeout ×2'), r.reasons.join(','));
});

test('speed only re-weights addresses that were actually measured', () => {
  const fast = createResult('1.1.1.1', 443, 'x.example');
  const slow = createResult('2.2.2.2', 443, 'x.example');
  const unmeasured = createResult('3.3.3.3', 443, 'x.example');
  for (const r of [fast, slow, unmeasured]) {
    recordAttempt(r, ok(200));
    recordAttempt(r, ok(200));
  }
  fast.downMbps = 50;
  slow.downMbps = 5;
  finalizeAll([fast, slow, unmeasured], { ...cfg, measureSpeed: true, topN: 2 });
  assert.ok(fast.score > slow.score, `${fast.score} should beat ${slow.score}`);
  assert.ok(unmeasured.score > slow.score, 'an unmeasured address must not look worse than a slow one');
  assert.equal(unmeasured.healthy, true);
});

test('sortResults orders by the requested key', () => {
  const a = createResult('10.0.0.2', 443, 'x');
  const b = createResult('10.0.0.1', 443, 'x');
  a.score = 10;
  b.score = 90;
  a.medianLatency = 40;
  b.medianLatency = 400;
  assert.equal(sortResults([a, b], 'score')[0].ip, '10.0.0.1');
  assert.equal(sortResults([a, b], 'latency')[0].ip, '10.0.0.2');
  assert.equal(sortResults([a, b], 'ip')[0].ip, '10.0.0.1');
});
