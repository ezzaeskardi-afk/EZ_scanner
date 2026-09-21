/**
 * `ezscan doctor` — the line signature.
 *
 * The per-operator presets exist because three access networks do three different things to a
 * scan. This test is the other half of that claim: the *measurement* that names a preset has to
 * see those mechanisms, and the classification has to name the right one, or the recommendation
 * is another piece of advice the user has to evaluate.
 *
 * The classifier is pinned as a pure function, and the measurement is driven against the same
 * fake access network the presets are tested with — a local HTTPS server with a session table, a
 * rate cap, a reset rate and an MTU hole — so no test here needs the internet to be in a
 * particular mood.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyLine, measureLineSignature, type LineSignature } from '../src/server/doctor.ts';
import { measureDownload } from '../src/core/probe.ts';
import { DEFAULT_CONFIG } from '../src/core/types.ts';
import { startHostileLine } from './helpers/hostile-line.ts';

/** A signature for a line that does nothing unusual, to be overridden per case. */
function signature(over: Partial<LineSignature> = {}): LineSignature {
  return {
    ip: '203.0.113.10',
    burst: { opened: 12, connected: 12, refused: 0, timedOut: 0 },
    underLoad: { attempts: 6, ok: 6, reset: 0, timedOut: 0, other: 0 },
    followUp: 'ok',
    medianConnectMs: 28,
    idle: { attempts: 2, ok: 2, reset: 0, timedOut: 0, other: 0 },
    ...over,
  };
}

test('a clean line is recommended no operator preset', () => {
  const verdict = classifyLine(signature());
  assert.equal(verdict.preset, null, 'nothing to work around, so no preset is named');
  assert.deepEqual(verdict.reasons, []);
});

test('a stalled large transfer is the fiber signature', () => {
  const verdict = classifyLine(
    signature({
      medianConnectMs: 14,
      transfer: { bytes: 65_536, targetBytes: 300_000, stale: true, idleMs: 6200, error: 'stalled' },
    }),
  );
  assert.equal(verdict.preset, 'mobin', 'a transfer that stops moving is the PPPoE/PMTU hole');
  assert.match(verdict.reasons[0]!, /stalled after 65536 bytes/);
  assert.match(verdict.reasons[0]!, /no data for 6\.2s/);
});

test('a stalled transfer outranks the other signatures', () => {
  // On fiber the cap is the ONU's table and the resets are DPI: both would be survivable with
  // the mobile presets, but only `mobin` also gives the speed phase the budget a broken PMTU
  // needs, so that is the one worth naming.
  const verdict = classifyLine(
    signature({
      burst: { opened: 12, connected: 6, refused: 0, timedOut: 6 },
      underLoad: { attempts: 6, ok: 3, reset: 0, timedOut: 3, other: 0 },
      followUp: 'timeout',
      idle: { attempts: 2, ok: 1, reset: 1, timedOut: 0, other: 0 },
      transfer: { bytes: 4096, targetBytes: 300_000, stale: true, idleMs: 8000 },
    }),
  );
  assert.equal(verdict.preset, 'mobin');
});

test('resets on an idle line name the DPI preset', () => {
  const verdict = classifyLine(
    signature({
      underLoad: { attempts: 6, ok: 0, reset: 6, timedOut: 0, other: 0 },
      idle: { attempts: 3, ok: 1, reset: 2, timedOut: 0, other: 0 },
    }),
  );
  assert.equal(verdict.preset, 'mci');
  assert.match(verdict.reasons[0]!, /2 of 3 connections were reset even with nothing else open/);
  assert.match(verdict.reasons[1]!, /6 of 6 connections under load never completed/);
});

test('one reset is not a signature', () => {
  const verdict = classifyLine(
    signature({ idle: { attempts: 4, ok: 3, reset: 1, timedOut: 0, other: 0 } }),
  );
  assert.equal(verdict.preset, null, 'a single reset is noise, not DPI');
});

test('a control that failed disqualifies the burst finding', () => {
  // The idle probes are the control, and they have to be able to disagree: if not one of them
  // completed with nothing else open, the burst is not what failed. Measured on a filtered line
  // (all four idle probes timed out, five of six under load), this was reported as "the line caps
  // how many sessions you may hold at once", which points the user at `--workers` for a line that
  // does not carry the request at all.
  const verdict = classifyLine(
    signature({
      underLoad: { attempts: 6, ok: 1, reset: 0, timedOut: 5, other: 0 },
      followUp: 'timeout',
      idle: { attempts: 4, ok: 0, reset: 0, timedOut: 4, other: 0 },
    }),
  );
  assert.equal(verdict.preset, null, 'the line is not carrying probes, capped or not');
  assert.match(verdict.reasons[0]!, /not one probe completed even with an idle line/);
  assert.doesNotMatch(verdict.reasons.join(' '), /--workers/, 'so it must not blame concurrency');
});

test('one idle success is enough to make the burst answer count', () => {
  // The control only overrides the finding when it really failed: a probe that works on an idle
  // line proves the path carries the request, so probes failing under the burst are a cap.
  const verdict = classifyLine(
    signature({
      underLoad: { attempts: 6, ok: 2, reset: 0, timedOut: 4, other: 0 },
      idle: { attempts: 4, ok: 1, reset: 0, timedOut: 3, other: 0 },
    }),
  );
  assert.equal(verdict.preset, 'irancell');
  assert.match(verdict.reasons[0]!, /4 of 6 probes attempted while 12 other sessions were held open/);
});

test('resets only under load are the cap, not DPI', () => {
  const verdict = classifyLine(
    signature({
      underLoad: { attempts: 6, ok: 4, reset: 2, timedOut: 0, other: 0 },
      idle: { attempts: 2, ok: 2, reset: 0, timedOut: 0, other: 0 },
    }),
  );
  assert.equal(verdict.preset, 'irancell', 'a clean idle line rules DPI out');
});

test('a full session table names the CGNAT preset, and says which cap it is', () => {
  const table = classifyLine(
    signature({
      underLoad: { attempts: 6, ok: 4, reset: 0, timedOut: 2, other: 0 },
      followUp: 'ok',
    }),
  );
  assert.equal(table.preset, 'irancell');    assert.match(table.reasons[0]!, /2 of 6 probes attempted while 12 other sessions were held open never completed/);
  assert.match(table.reasons[0]!, /the cap is on concurrency and `--workers` is the lever/);

  const rate = classifyLine(
    signature({
      burst: { opened: 12, connected: 4, refused: 8, timedOut: 0 },
      underLoad: { attempts: 6, ok: 1, reset: 5, timedOut: 0, other: 0 },
      followUp: 'refused',
    }),
  );    assert.equal(rate.preset, 'irancell');
  assert.match(rate.reasons[0]!, /5 of 6 probes attempted while 4 other sessions were held open never completed/);
  assert.match(rate.reasons[0]!, /the cap is on new sessions per second and `--rate` is the lever/);
});

test('the measurement sees a session table', async () => {
  // A table of 8, a burst of 12, and 4 probes on top — run twice on the same line, once with the
  // burst and once without. That pair is the assertion: the probes themselves are identical and
  // fit any table this size, so the only thing that can turn them away is what the burst left
  // behind. It is the end-to-end form of the claim the preset rests on ("the line caps how many
  // sessions you may hold at once") rather than an assertion about the model's timing.
  //
  // On loopback the measurement cannot be pinned tighter than that: everything here happens
  // inside one tick window, so a slot freed by a closing socket is available again as fast as the
  // next connection arrives. On a real line the equivalent gap is an RTT wide, which is why the
  // measurement holds the burst open instead of probing just after it. A bare TCP connect would
  // see none of this either way: an over-limit session can complete its handshake first and only
  // be reset afterwards, so it reads as "connected" while the table is refusing it.
  const line = await startHostileLine({ sessionLimit: 8, overLimit: 'refuse', baseDelayMs: 5 });
  const target = { ip: '127.0.0.1', port: line.port, sni: 'hostile.line' };
  const options = { probeAttempts: 4, connectTimeoutMs: 1200, probeTimeoutMs: 900 };
  try {
    const sig = await measureLineSignature(target, new AbortController().signal, { ...options, burst: 12 });
    const alone = await measureLineSignature(target, new AbortController().signal, { ...options, burst: 0 });

    assert.equal(sig.burst.opened, 12);
    assert.ok(sig.burst.connected >= 8, `the table's slots connected (saw ${sig.burst.connected})`);
    assert.ok(sig.medianConnectMs > 0, 'connect times were measured from the sessions that connected');
    assert.equal(
      alone.underLoad.ok,
      alone.underLoad.attempts,
      'without a burst the same probes all complete, so the line itself is fine',
    );
    assert.ok(
      sig.underLoad.reset + sig.underLoad.timedOut >= 1,
      `with the burst held, probes were turned away (saw ${JSON.stringify(sig.underLoad)})`,
    );
    assert.equal(sig.idle.ok, sig.idle.attempts, 'and the line is perfect once nothing else is held open');
    assert.equal(sig.followUp, 'ok', 'a single connection after the burst works: the cap is on concurrency');
    assert.equal(classifyLine(sig).preset, 'irancell', 'and it names the CGNAT preset');
    assert.equal(classifyLine(alone).preset, null, 'while the same line with no burst shows no signature');
  } finally {
    await line.close();
  }
});

test('the measurement sees resets that happen on their own', async () => {
  const line = await startHostileLine({ sessionLimit: 64, resetRate: 1, baseDelayMs: 5 });
  try {
    const sig = await measureLineSignature(
      { ip: '127.0.0.1', port: line.port, sni: 'hostile.line' },
      new AbortController().signal,
      { burst: 2, probeAttempts: 4, connectTimeoutMs: 1200, probeTimeoutMs: 900 },
    );
    assert.equal(sig.idle.reset, sig.idle.attempts, 'every probe on the idle line was reset');
    assert.equal(sig.idle.ok, 0);
    assert.ok(sig.idle.attempts >= 2, 'and it stopped as soon as the answer was clear');
    assert.equal(classifyLine(sig).preset, 'mci');
  } finally {
    await line.close();
  }
});

test('the transfer measurement sees an MTU hole, and the preset that follows', async () => {
  // The blackhole signature: headers arrive promising a whole response, the first bytes follow,
  // and then nothing ever does. A scan that counts those bytes as throughput reports a real
  // number for a transfer that never happened.
  const line = await startHostileLine({ sessionLimit: 64, stallOverBytes: 32_768 });
  try {
    const cfg = {
      ...DEFAULT_CONFIG,
      speedUrl: `https://127.0.0.1:${line.port}/__down?bytes=%BYTES%`,
      speedSni: 'hostile.line',
      speedBytes: 400_000,
      speedTimeoutMs: 4000,
      timeoutMs: 3000,
    };
    const down = await measureDownload(
      { ip: '127.0.0.1', port: line.port, sni: 'hostile.line' },
      cfg,
      new AbortController().signal,
    );
    assert.equal(down.ok, false, 'a stalled transfer is not a transfer');
    assert.equal(down.stale, true, 'and it is reported as stalled, not as a slow line');
    // The count includes the response headers, so it lands just past the stall point.
    const stalledAfter = Number(/stalled after (\d+) bytes/.exec(down.error!)?.[1]);
    assert.ok(
      stalledAfter >= 32_768 && stalledAfter < 40_000,
      `the stall is reported at the point the stream went quiet (saw ${stalledAfter})`,
    );

    const sig = await measureLineSignature(
      { ip: '127.0.0.1', port: line.port, sni: 'hostile.line' },
      new AbortController().signal,
      { burst: 2, probeAttempts: 1, connectTimeoutMs: 1200, probeTimeoutMs: 900 },
    );
    sig.transfer = {
      bytes: down.bytes,
      targetBytes: cfg.speedBytes,
      stale: down.stale === true,
      idleMs: down.idleMs ?? 0,
    };
    assert.equal(classifyLine(sig).preset, 'mobin');
  } finally {
    await line.close();
  }
});
