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
  // A rate and the verdict that it may rank are written together (`applySpeedVerdict`); a number
  // with no verdict is the one shape the ranking may not read at all.
  fast.downMbps = 50;
  fast.downTrust = 'measured';
  slow.downMbps = 5;
  slow.downTrust = 'measured';
  finalizeAll([fast, slow, unmeasured], { ...cfg, measureSpeed: true, topN: 2 });
  assert.ok(fast.score > slow.score, `${fast.score} should beat ${slow.score}`);
  assert.ok(unmeasured.score > slow.score, 'an unmeasured address must not look worse than a slow one');
  assert.equal(unmeasured.healthy, true);
});

test('a transfer that failed cannot outrank one that was measured', () => {
  // "No measurement" and "the measurement failed" both leave the throughput column empty, and
  // treating them alike made the failed one the *safer* address: its speed term was dropped while
  // the address that completed a slow transfer had it counted, so "we could not find out" beat
  // "we found out, and it is slow". Every distrust is the path refusing a payload the endpoint had
  // agreed to send, so it scores the floor against anything that was measured.
  const measured = (mbps: number) => {
    const r = createResult('1.0.0.1', 443, 'x.example');
    recordAttempt(r, ok(200));
    recordAttempt(r, ok(210));
    r.downMbps = mbps;
    r.downTrust = 'measured';
    return r;
  };
  const fast = measured(50);
  const slow = measured(5);
  for (const trust of ['cut', 'stalled', 'partial'] as const) {
    const failed = createResult(`2.0.0.${trust.length}`, 443, 'x.example');
    recordAttempt(failed, ok(200));
    recordAttempt(failed, ok(210));
    failed.downTrust = trust;
    finalizeAll([fast, slow, failed], { ...cfg, measureSpeed: true, topN: 3 });
    assert.ok(
      failed.score < slow.score,
      `a ${trust} transfer (${failed.score}) must not beat a measured slow one (${slow.score})`,
    );
  }
});

test('a batch where no transfer completed makes no speed claim at all', () => {
  // Every address on a stalled PPPoE line looks like every other one, so the term is dropped
  // rather than turning the whole scan red over a fault none of these addresses caused — the
  // `mobin` preset's job is to give that line a longer speed budget, not to lose its addresses.
  const stalled = (ip: string) => {
    const r = createResult(ip, 443, 'x.example');
    recordAttempt(r, ok(200));
    recordAttempt(r, ok(210));
    r.downTrust = 'stalled';
    return r;
  };
  const rows = [stalled('1.0.0.1'), stalled('1.0.0.2')];
  finalizeAll(rows, { ...cfg, measureSpeed: true, topN: 2, minScore: 45 });
  for (const r of rows) assert.equal(r.healthy, true, r.reasons.join(', '));
});

test('only a trusted number sets the baseline the others are scored against', () => {
  // A number that may not rank an address may not raise the bar for the ones that may either.
  const distrusted = createResult('1.0.0.9', 443, 'x.example');
  recordAttempt(distrusted, ok(200));
  recordAttempt(distrusted, ok(210));
  distrusted.downMbps = 900; // a leftover from a transfer the path cut: it is not a baseline
  distrusted.downTrust = 'cut';
  const real = createResult('1.0.0.1', 443, 'x.example');
  recordAttempt(real, ok(200));
  recordAttempt(real, ok(210));
  real.downMbps = 10;
  real.downTrust = 'measured';
  finalizeAll([distrusted, real], { ...cfg, measureSpeed: true, topN: 2 });
  // Against its own 10 Mbps the measured address takes the full speed part; against 900 it would
  // have been scored as if the line were unusable.
  const alone = createResult('1.0.0.2', 443, 'x.example');
  recordAttempt(alone, ok(200));
  recordAttempt(alone, ok(210));
  alone.downMbps = 10;
  alone.downTrust = 'measured';
  finalizeAll([alone], { ...cfg, measureSpeed: true, topN: 1 });
  assert.equal(real.score, alone.score, `baseline was taken from a distrusted number (${real.score} vs ${alone.score})`);
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
