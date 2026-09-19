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
