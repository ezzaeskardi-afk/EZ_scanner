/**
 * Integration tests against a hostile access network (`helpers/hostile-line.ts`).
 *
 * The unit tests prove the pieces; these prove the *behaviour the claims rest on*:
 *
 *   1. a worker burst really does trip a session table and drop the line, while the same
 *      addresses on the same line are all found under a worker budget that fits in it;
 *   2. a response slower than the timeout turns a working line all-red — and the failure
 *      is attributed to the timeout, not to the addresses;
 *   3. a line that resets a share of sessions makes the scanner slow itself down instead of
 *      hammering;
 *   4. a PPPoE-style MTU blackhole stalls the transfer without hanging the scan or
 *      poisoning the verdict on a healthy address;
 *   5. a line that disappears *mid-sweep* parks the scan on the spot, is reported as down,
 *      and the scan finishes on its own once the line is back — with no address lost and
 *      none probed twice.
 *
 * Everything is loopback; no test here touches the internet.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Scanner } from '../src/core/scanner.ts';
import { DEFAULT_CONFIG, type ScanConfig } from '../src/core/types.ts';
import { startHostileLine, waitUntilLineUp } from './helpers/hostile-line.ts';

let dataDir: string;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ez-scanner-hostile-'));
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * The gates are widened on purpose: these tests are about the *line*, not about the
 * score/loss thresholds, which have their own tests in `scoring.test.ts`.
 */
function config(linePort: number, overrides: Partial<ScanConfig> = {}): ScanConfig {
  return {
    ...DEFAULT_CONFIG,
    mode: 'http',
    requireHttp: true,
    sni: '',
    port: linePort,
    tries: 2,
    minSuccesses: 1,
    timeoutMs: 1500,
    workers: 4,
    minScore: 0,
    maxLossPct: 100,
    autoPauseOnNetworkLoss: false,
    adaptiveBackoff: false,
    measureSpeed: false,
    minDelayMs: 0,
    ...overrides,
  };
}

const newScanner = () => new Scanner(dataDir);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it passes, so a test never asserts on a race it created itself. */
async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
  return true;
}

test('a burst past the session limit drops the line; a worker budget that fits does not', async () => {
  const line = await startHostileLine({ sessionLimit: 12, outageMs: 800, listenAll: true, baseDelayMs: 25 });
  const targets = Array.from({ length: 24 }, (_, i) => `127.0.0.${i + 1}:${line.port}`);
  try {
    // The shape of scan that makes an operator (or a home ONU) react: as many sessions as
    // the box can hold, no pause between them, no back-off.
    const abusive = newScanner();
    abusive.configure(config(line.port, { workers: 20, tries: 2, minDelayMs: 0 }));

    line.resetStats();
    await abusive.start({ targets, label: 'abusive' });
    const abusiveStats = abusive.getStats();

    assert.equal(abusiveStats.phase, 'done', 'the scan still finishes when the line drops under it');
    assert.ok(
      line.stats.peakConcurrent >= 12,
      `the burst has to fill the session table for this test to mean anything (peak ${line.stats.peakConcurrent})`,
    );
    assert.ok(line.stats.outages > 0, 'filling the table is what drops the line');
    assert.ok(line.stats.refused > 0, 'the sessions past the limit are turned away');
    assert.ok(
      abusiveStats.healthy < targets.length,
      'the addresses probed while the line was down are lost — the cost of the burst',
    );

    // The line comes back (the outage is temporary, exactly like a real drop), and the same
    // addresses on the same line are then found under a budget that stays inside the table.
    await waitUntilLineUp(line);
    const budgeted = newScanner();
    budgeted.configure(config(line.port, { workers: 6, tries: 2, minDelayMs: 15, adaptiveBackoff: true }));

    line.resetStats();
    await budgeted.start({ targets, label: 'budgeted' });

    assert.equal(line.stats.outages, 0, 'a sweep that never fills the table never drops the line');
    assert.ok(
      line.stats.peakConcurrent <= 6,
      `peak ${line.stats.peakConcurrent} must stay inside the worker budget (and the session limit)`,
    );
    assert.equal(line.stats.refused, 0, 'nothing was turned away');
    assert.equal(budgeted.getStats().healthy, targets.length, 'all 24 addresses are found on a line that stayed up');
  } finally {
    await line.close();
  }
});

test('a response slower than the timeout is the whole difference between all-red and all-green', async () => {
  const line = await startHostileLine({ sessionLimit: 32, listenAll: true, baseDelayMs: 300, jitterMs: 120 });
  const targets = Array.from({ length: 8 }, (_, i) => `127.0.0.${i + 1}:${line.port}`);
  try {
    const impatient = newScanner();
    impatient.configure(config(line.port, { timeoutMs: 120, tries: 2 }));
    await impatient.start({ targets, label: 'impatient' });

    const tight = impatient.getStats();
    assert.equal(tight.healthy, 0, 'every row is red while the timeout is under the line delay');
    const kinds = Object.keys(tight.failuresByKind);
    assert.deepEqual(
      kinds.filter((kind) => kind !== 'http' && kind !== 'timeout'),
      [],
      `nothing is wrong with the line itself, only with the timeout (saw: ${kinds.join(', ')})`,
    );

    const patient = newScanner();
    patient.configure(config(line.port, { timeoutMs: 1500, tries: 3 }));
    await patient.start({ targets, label: 'patient' });

    assert.equal(patient.getStats().healthy, targets.length, 'the same addresses are healthy with a viable timeout');
    const latencies = patient.getResults('score').map((r) => r.medianLatency);
    assert.ok(
      Math.min(...latencies) >= 300,
      `the delay shows up in the measurement, so it was never a probe bug: ${latencies.join(', ')}ms`,
    );
  } finally {
    await line.close();
  }
});

test('resets make the scanner slow itself down instead of hammering', async () => {
  // 85% of sessions killed and five tries each. The test needs *both* tails of that coin, so the
  // arithmetic has to hold in both directions: an address loses all five tries with
  // P = 0.85^5 ≈ 0.44, and it survives all five with P = 1 − 0.44 ≈ 0.56. Twelve addresses was
  // enough for neither — P(not one address lost every try) was 0.56^12 ≈ 8.5e-4, which is how this
  // test failed in CI ("a reset is reported as a reset … saw: " with an empty breakdown: every
  // address had found a session). With 24 both tails fall below 1e-6.
  const addresses = 24;
  const line = await startHostileLine({ sessionLimit: 32, resetRate: 0.85, listenAll: true, baseDelayMs: 10 });
  const targets = Array.from(
    { length: addresses },
    (_, i) => `127.0.0.${(i % 250) + 1}:${line.port}`,
  );
  try {
    const scanner = newScanner();
    scanner.configure(config(line.port, { tries: 5, minSuccesses: 1, workers: 4, adaptiveBackoff: true }));
    await scanner.start({ targets, label: 'resets' });

    const stats = scanner.getStats();
    assert.ok(line.stats.resets > 0, 'the line really was resetting a share of the sessions');
    assert.ok(
      (stats.failuresByKind.reset ?? 0) > 0,
      `a reset is reported as a reset, not as a vague failure (saw: ${Object.keys(stats.failuresByKind).join(', ')})`,
    );
    assert.ok(stats.backoffFactor > 1, 'the failure ratio raised the inter-probe delay');
    assert.ok(stats.healthy > 0, 'the addresses that survived the resets are still found');
    assert.equal(line.stats.refused, 0, 'the line never ran out of sessions');
    assert.equal(line.stats.outages, 0, 'and it was never dropped');
    assert.ok(line.stats.peakConcurrent <= 4, 'the worker budget was respected throughout');
  } finally {
    await line.close();
  }
});

test('an MTU blackhole stalls the transfer, never the scan or the verdict', async () => {
  const lines = [
    await startHostileLine({ sessionLimit: 32, listenAll: true, stallOverBytes: 60_000 }),
    await startHostileLine({ sessionLimit: 32, listenAll: true }),
  ];
  const [blackholed, clean] = lines;
  const targetsFor = (port: number) => Array.from({ length: 3 }, (_, i) => `127.0.0.${i + 1}:${port}`);
  const speedUrlFor = (port: number) => `https://127.0.0.1:${port}/__down?bytes=%BYTES%`;
  const speedConfig = (port: number): Partial<ScanConfig> => ({
    measureSpeed: true,
    speedUrl: speedUrlFor(port),
    speedBytes: 400_000,
    speedTimeoutMs: 700,
    topN: 3,
    timeoutMs: 2000,
  });

  try {
    const stalled = newScanner();
    stalled.configure(config(blackholed.port, speedConfig(blackholed.port)));
    const started = Date.now();
    await stalled.start({ targets: targetsFor(blackholed.port), label: 'blackhole' });
    const elapsed = Date.now() - started;

    assert.ok(blackholed.stats.stalls > 0, 'the response really was black-holed');
    assert.equal(
      stalled.getStats().healthy,
      3,
      'the addresses stay healthy: TLS and the HTTP headers were never the problem',
    );
    assert.ok(elapsed < 8000, `the run is bounded by speedTimeoutMs, took ${elapsed}ms`);
    const throttled = stalled.getResults('score').map((r) => r.downMbps);
    for (const mbps of throttled) assert.ok(mbps < 5, `a black-holed transfer must not read as a fast one (${mbps} Mbps)`);

    // Control: the same transfer on a line without the blackhole. The number belongs to the
    // transfer, not to the address — this is what makes the low reading above meaningful.
    const control = newScanner();
    control.configure(config(clean.port, speedConfig(clean.port)));
    await control.start({ targets: targetsFor(clean.port), label: 'clean' });

    assert.equal(control.getStats().healthy, 3);
    const controlMbps = Math.max(...control.getResults('score').map((r) => r.downMbps));
    const stalledMbps = Math.max(...throttled);
    assert.ok(
      controlMbps > Math.max(2, stalledMbps * 3),
      `an unblocked transfer is far faster (${controlMbps} vs ${stalledMbps} Mbps)`,
    );
  } finally {
    await Promise.all(lines.map((line) => line.close()));
  }
});

test('a line that drops mid-sweep parks the scan, and the scan finishes on its own once it is back', async () => {
  const line = await startHostileLine({ sessionLimit: 16, listenAll: true, baseDelayMs: 20 });
  const targetCount = 60;
  const targets = Array.from({ length: targetCount }, (_, i) => `127.0.0.${i + 1}:${line.port}`);

  /**
   * The line verdict is driven from here. A loopback socket cannot be made to drop a SYN —
   * a port with nothing behind it answers with a RST, and this watchdog deliberately counts
   * a refusal as proof the path is up — so the *dial* is replaced, not the packets. The
   * traffic itself is real: the addresses, the session table and every result asserted
   * below come from the fake access network.
   */
  let lineUp = true;
  let dials = 0;
  const scanner = new Scanner(dataDir, {
    // Nothing but the canary below decides: the built-ins answer on an ordinary machine,
    // so the outage could never be observed with them still in the watch list.
    fallbackCanaries: [],
    intervalMs: 120,
    timeoutMs: 200,
    failureThreshold: 2,
    dial: async () => {
      dials += 1;
      if (lineUp) return;
      const err = new Error('connect ETIMEDOUT') as NodeJS.ErrnoException;
      err.code = 'ETIMEDOUT';
      throw err; // what a dropped line looks like from here: nothing comes back at all
    },
  });
  scanner.configure(
    config(line.port, {
      tries: 1,
      workers: 2,
      minDelayMs: 60,
      autoPauseOnNetworkLoss: true,
      canaryHost: '127.0.0.1',
      canaryPort: line.port,
    }),
  );

  const network: Array<{ offline: boolean; message: string }> = [];
  scanner.on('network', (state) => network.push(state));
  let probed = 0;
  scanner.on('result', () => {
    probed += 1;
    // The line dies while the sweep is running, not before it starts — and only once: a
    // line that keeps dropping every few addresses would just be a different test.
    if (probed === 6) lineUp = false;
  });

  const running = scanner.start({ targets, label: 'outage' });
  try {
    // 1. The drop is noticed and reported: the scan parks.
    assert.ok(
      await waitFor(() => scanner.getState() === 'offline', 5000),
      `the scan must park when the line dies (state: ${scanner.getState()})`,
    );
    assert.ok(network.some((state) => state.offline), 'the line going down is announced to the UI');
    assert.equal(scanner.getStats().offline, true, 'the stats carry the line state');
    assert.match(scanner.getNetwork().message, /no answer from any canary \(127\.0\.0\.1:\d+\)/);
    assert.ok(
      scanner.getLogs().some((log) => log.level === 'warn' && log.text.startsWith('network:')),
      'the log says why the scan stopped moving',
    );

    // 2. Parked means parked: the address list stops being consumed, no probe is left in
    //    flight, and the outage is never charged to the addresses.
    await sleep(400);
    const parked = scanner.getStats();
    await sleep(500);
    const still = scanner.getStats();
    assert.ok(
      parked.done > 0 && parked.done < targetCount,
      `there has to be sweep left to lose for this test to mean anything (${parked.done}/${targetCount})`,
    );
    assert.equal(still.done, parked.done, `no address is probed while parked (done went ${parked.done} → ${still.done})`);
    assert.equal(still.inflight, 0, 'the workers let go of an address instead of holding it through the outage');
    assert.equal(still.failed, parked.failed, 'a line outage must not be recorded as an address failure');
    assert.match(
      parked.message,
      /waiting for the line to come back/,
      'the scan says what it is waiting for, not just that it stopped',
    );

    // 3. It keeps watching while parked — that is what makes the resume automatic.
    const dialsWhenParked = dials;
    await sleep(600);
    assert.ok(dials > dialsWhenParked, 'the watchdog keeps checking the line while the scan is parked');

    // 4. The line comes back and the scan resumes by itself: nobody calls resume().
    lineUp = true;
    assert.ok(await waitFor(() => scanner.getState() === 'running', 5000), 'the scan resumes on its own');
    const recovery = network.find((state) => !state.offline);
    assert.ok(recovery, 'the recovery is announced too');
    assert.equal(recovery.message, 'line is back');
    assert.ok(
      await waitFor(() => scanner.getStats().done > still.done, 5000),
      `the sweep itself continues from where it stopped (${still.done} → ${scanner.getStats().done})`,
    );

    await running;
    const stats = scanner.getStats();
    assert.equal(stats.phase, 'done');
    assert.equal(stats.total, targetCount);
    assert.equal(stats.done, targetCount, 'every address in the list was probed');
    assert.equal(stats.healthy, targetCount, 'and the outage cost none of them');
    const keys = scanner.getResults('score').map((r) => `${r.ip}:${r.port}`);
    assert.deepEqual(new Set(keys), new Set(targets), 'no address was probed twice, and none was skipped');
  } finally {
    if (scanner.getState() !== 'done') await scanner.stop();
    await running;
    await line.close();
  }
});
