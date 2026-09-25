/**
 * Traffic shaping and line-watchdog tests.
 *
 * The watchdog is what parks a scan when the line dies — which also makes it the thing
 * that can park a scan *forever* when it watches endpoints the operator cannot reach.
 * It therefore fails open: the configured canary is tried first and the built-ins stay
 * behind it, a refusal counts as proof the path is up, and the line is only called down
 * when no canary answers at all. Canaries are re-read on every check so a runtime
 * reconfiguration actually takes effect.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AdaptiveBackoff, DEFAULT_CANARIES, NetworkWatchdog, TokenBucket, mergeCanaries } from '../src/core/ratelimit.ts';
import { startFakeTcp } from './helpers/localnet.ts';

/** RFC 5737 TEST-NET-1: never routable, so a connect there is never answered. */
const BLACKHOLE = '192.0.2.1:443';

/** Armed timers right now — what keeps a finished process from exiting. */
function armedTimers(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
}

test('stopping the watchdog abandons a dial in flight and arms no further tick', async () => {
  // Two leaks in one loop, both of which kept the CLI alive for ~4s after it had printed:
  // `stop()` could not cancel a dial that was already waiting for a canary (on a line where
  // 1.1.1.1 never answers, the normal case), and `tick` armed a fresh interval *after* its await,
  // undoing the `stop()` that had run while it waited.
  let aborted = false;
  let dialStarted = (): void => {};
  const started = new Promise<void>((resolve) => {
    dialStarted = resolve;
  });
  const watchdog = new NetworkWatchdog({
    dial: (_canary, _timeoutMs, signal) => {
      dialStarted();
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    },
    intervalMs: 60_000,
    timeoutMs: 60_000,
  });
  const before = armedTimers();
  watchdog.start();
  await started;
  watchdog.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(aborted, true, 'the dial was abandoned instead of waited out');
  assert.equal(watchdog.state.checks, 0, 'an abandoned dial is not a check, so it cannot fail one');
  assert.equal(watchdog.state.offline, false, 'and it must not park the line on the way out');
  assert.ok(armedTimers() <= before, 'no interval timer may outlive stop()');
});

test('the token bucket is unlimited at rate 0 and paces at the configured rate', async () => {
  const unlimited = new TokenBucket(0);
  const started = Date.now();
  for (let i = 0; i < 20; i++) await unlimited.acquire();
  assert.ok(Date.now() - started < 50, 'rate 0 must not pace at all');

  const limited = new TokenBucket(20, 1);
  const paced = Date.now();
  for (let i = 0; i < 3; i++) await limited.acquire();
  const elapsed = Date.now() - paced;
  assert.ok(elapsed >= 80, `three tokens at 20/s should take ~100ms, took ${elapsed}ms`);
});

test('adaptive backoff slows down on failures and recovers on success', () => {
  const backoff = new AdaptiveBackoff();
  for (let i = 0; i < 10; i++) backoff.record(false);
  assert.ok(backoff.factor > 1, 'a failure spike must raise the factor');
  for (let i = 0; i < 40; i++) backoff.record(true);
  assert.equal(backoff.factor, 1, 'a calm line must come back to 1');
  backoff.reset();
  assert.equal(backoff.factor, 1);
});

test('the decay step is exactly /1.3, taken once the failure ratio drops under 0.25', () => {
  // Ten failures raise the factor (1.25 per record past the threshold, ratio → 0.893); five
  // successes then walk the ratio down to ~0.292 without ever leaving the raise/hold band —
  // so the next success is precisely the record that crosses under 0.25, and the step it
  // takes must be exactly /1.3. The whole point of pinning this: `stats.backoffFactor` is
  // the live field this decay pulls back toward 1, which is what made the reset-churn
  // assertion in `hostile-line.test.ts` flake when it read a finished sweep's last value.
  const backoff = new AdaptiveBackoff();
  for (let i = 0; i < 10; i++) backoff.record(false);
  for (let i = 0; i < 5; i++) backoff.record(true);
  const before = backoff.factor;
  assert.ok(before > 1, 'setup: a real failure spike must have raised the factor');

  backoff.record(true);
  assert.ok(
    Math.abs(backoff.factor - before / 1.3) < 1e-9,
    `one decay step, exactly /1.3 (got ${backoff.factor}, want ${before / 1.3})`,
  );
});

test('the factor never decays below 1', () => {
  // Continue decaying past the point where /1.3 would undershoot: the floor is exact,
  // not asymptotic — a calm line reads exactly 1, the same value a fresh run starts on.
  const backoff = new AdaptiveBackoff();
  for (let i = 0; i < 10; i++) backoff.record(false);
  for (let i = 0; i < 5; i++) backoff.record(true);
  assert.ok(backoff.factor > 1, 'setup: there is something to decay');

  for (let i = 0; i < 10; i++) backoff.record(true);
  assert.equal(backoff.factor, 1, 'decays stop at 1, never below it');

  const calm = new AdaptiveBackoff();
  for (let i = 0; i < 10; i++) calm.record(true);
  assert.equal(calm.factor, 1, 'and successes alone never push it under 1 either');
});

test('a ratio between 0.25 and the threshold holds the factor still', () => {
  // Ten failures, then successes until the ratio lands in the band (0.457) with the factor
  // well above 1. Two more successes keep the ratio inside (0.366, 0.292) — the factor must
  // not move a hair either way: this band is why a recovering sweep keeps its slowdown even
  // while its failure ratio no longer qualifies as a spike.
  const held = new AdaptiveBackoff();
  for (let i = 0; i < 10; i++) held.record(false);
  held.record(true); // ratio 0.714 — above the threshold, still raising
  held.record(true); // ratio 0.571 — above the threshold, still raising
  held.record(true); // ratio 0.457 — inside the band
  const frozen = held.factor;
  assert.ok(frozen > 1, 'setup: the factor is elevated while the ratio is not a spike');

  for (let i = 0; i < 2; i++) {
    held.record(true);
    assert.equal(held.factor, frozen, 'the band holds the factor still');
  }

  held.record(true); // ratio 0.234 — under 0.25: the hold ends, the decay step begins
  assert.ok(held.factor < frozen, 'and decay resumes the moment the ratio leaves the band');
});

test('without a configured canary the built-ins are used', () => {
  assert.deepEqual(new NetworkWatchdog().canaries, DEFAULT_CANARIES);
  assert.deepEqual(new NetworkWatchdog({ canaries: () => [] }).canaries, DEFAULT_CANARIES);
});

test('the watch list is configured canary first, built-ins behind it, deduped', () => {
  assert.deepEqual(mergeCanaries(['my.endpoint:8443']), ['my.endpoint:8443', ...DEFAULT_CANARIES]);
  // The default config watches 1.1.1.1, which is already a built-in: nothing extra is dialled.
  assert.deepEqual(mergeCanaries(['1.1.1.1:443']), DEFAULT_CANARIES);
  assert.deepEqual(mergeCanaries(['  ', 'a:1', 'a:1']), ['a:1', ...DEFAULT_CANARIES]);
  assert.deepEqual(mergeCanaries([], []), [], 'an empty fallback list leaves only what was configured');
});

test('a blocked canary does not park the scan — the next one decides', async () => {
  const listener = await startFakeTcp();
  try {
    const healthy = `127.0.0.1:${listener.port}`;
    const watchdog = new NetworkWatchdog({
      canaries: () => [BLACKHOLE],
      fallbackCanaries: [healthy],
      failureThreshold: 1,
      timeoutMs: 300,
    });
    assert.deepEqual(watchdog.canaries, [BLACKHOLE, healthy]);
    assert.equal(await watchdog.check(), true, 'the unanswered canary falls through to the healthy one');
    assert.equal(watchdog.state.offline, false, 'a canary the operator blocks must not pause the scan');
    assert.deepEqual(watchdog.state.canaries, [BLACKHOLE, healthy], 'the state names every canary that got a turn');
  } finally {
    await listener.close();
  }
});

test('a refused canary proves the path is up', async () => {
  const listener = await startFakeTcp();
  const port = listener.port;
  await listener.close(); // nothing listens there any more

  const watchdog = new NetworkWatchdog({
    canaries: () => [`127.0.0.1:${port}`],
    fallbackCanaries: [],
    failureThreshold: 1,
    timeoutMs: 400,
  });
  assert.equal(await watchdog.check(), true, 'ECONNREFUSED means a remote answered, so the line is up');
  assert.equal(watchdog.state.offline, false);
  assert.match(watchdog.state.message, /refused the connection/);
});

test('the line is only called down when no canary answers at all', async () => {
  const watchdog = new NetworkWatchdog({
    canaries: () => [BLACKHOLE],
    fallbackCanaries: [],
    failureThreshold: 2,
    timeoutMs: 300,
  });
  assert.equal(await watchdog.check(), false);
  assert.equal(watchdog.state.offline, false, 'one unanswered round is not enough');
  assert.equal(await watchdog.check(), false);
  assert.equal(watchdog.state.offline, true);
  assert.match(watchdog.state.message, /no answer from any canary \(192\.0\.2\.1:443\)/);
});

test('reset() clears a stale line verdict so a new scan starts clean', async () => {
  const watchdog = new NetworkWatchdog({
    canaries: () => [BLACKHOLE],
    fallbackCanaries: [],
    failureThreshold: 2,
    timeoutMs: 300,
  });
  await watchdog.check();
  await watchdog.check();
  assert.equal(watchdog.state.offline, true, 'two failed checks mean the line is down');

  watchdog.reset();
  assert.equal(watchdog.state.offline, false, 'a new scan must not inherit the old verdict');
  assert.equal(watchdog.state.checks, 0);
  assert.equal(watchdog.state.failures, 0);
  assert.equal(watchdog.state.message, 'ok');

  // The failure counter starts from scratch too: one failed check after the reset is not
  // enough to re-flag the line (the old 2/2 would otherwise trip it again immediately).
  assert.equal(await watchdog.check(), false);
  assert.equal(watchdog.state.offline, false, 'the threshold counts from scratch, not from before the reset');
});

test('canaries are re-read on every check', async () => {
  const listener = await startFakeTcp();
  try {
    let canaries = [BLACKHOLE];
    const watchdog = new NetworkWatchdog({
      canaries: () => canaries,
      fallbackCanaries: [],
      failureThreshold: 1,
      timeoutMs: 300,
    });

    assert.equal(await watchdog.check(), false);
    assert.equal(watchdog.state.offline, true, 'nothing answered, so the scan parks');
    assert.deepEqual(watchdog.state.canaries, canaries);

    // What `configure({canaryHost, canaryPort})` does at runtime: the next check must use it.
    canaries = [`127.0.0.1:${listener.port}`];
    assert.equal(await watchdog.check(), true);
    assert.equal(watchdog.state.offline, false, 'the line is back');
    assert.deepEqual(watchdog.state.canaries, canaries, 'the new canary is the one that was used');
  } finally {
    await listener.close();
  }
});
