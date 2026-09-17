/**
 * Traffic shaping and line-watchdog tests.
 *
 * The watchdog is what parks a scan when the line dies — which also makes it the thing
 * that can park a scan *forever* when it watches endpoints the operator cannot reach.
 * A configured canary therefore has to win outright, and has to be re-read on every
 * check so a runtime reconfiguration actually takes effect.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdaptiveBackoff, NetworkWatchdog, TokenBucket } from '../src/core/ratelimit.ts';
import { startFakeTcp } from './helpers/localnet.ts';

const DEFAULT_CANARIES = ['1.1.1.1:443', '8.8.8.8:53', '9.9.9.9:443'];

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

test('a configured canary replaces the built-ins and is re-read on every check', async () => {
  const listener = await startFakeTcp();
  try {
    let canaries = ['127.0.0.1:1']; // nothing is listening there
    const watchdog = new NetworkWatchdog({ canaries: () => canaries, failureThreshold: 1, timeoutMs: 400 });

    assert.deepEqual(watchdog.canaries, canaries, 'the configured canary replaces the defaults');
    assert.equal(await watchdog.check(), false);
    assert.equal(watchdog.state.offline, true, 'no route to the only canary means offline');
    assert.equal(watchdog.state.canaries.join(), '127.0.0.1:1');

    // What `configure({canaryHost, canaryPort})` does at runtime: the next check must use it.
    canaries = [`127.0.0.1:${listener.port}`];
    assert.equal(await watchdog.check(), true);
    assert.equal(watchdog.state.offline, false, 'the line is back');
    assert.deepEqual(watchdog.state.canaries, canaries, 'the new canary is the one that was used');
  } finally {
    await listener.close();
  }
});
