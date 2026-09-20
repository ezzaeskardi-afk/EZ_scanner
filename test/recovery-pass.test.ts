/**
 * Finding the addresses the *line* took away.
 *
 * Two mechanisms the per-operator presets rely on, both measured here against the fake access
 * network rather than argued for:
 *
 *  1. a retry sent a few milliseconds after the first one is the same session to a per-second
 *     cap, so the address spends its whole `tries` budget inside one window and is lost;
 *  2. a block or a throttle lasts seconds, and every attempt an address gets inside it fails for
 *     a reason that has nothing to do with the address — so the failures are retried once the
 *     window has passed, with a fresh record.
 *
 * The second run of each pair is the control: same line, same addresses, one mechanism switched
 * off. On the block test the numbers are stark (a 3 s block over a 4 s sweep): most addresses are
 * probed inside it, so without the recovery pass they are gone until the next scan.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Scanner } from '../src/core/scanner.ts';
import { DEFAULT_CONFIG, applyPreset, type ScanConfig } from '../src/core/types.ts';
import { startHostileLine, type HostileLineOptions } from './helpers/hostile-line.ts';

let dataDir: string;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ez-scanner-recovery-'));
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const ADDRESSES = 40;
const targetsFor = (port: number) => Array.from({ length: ADDRESSES }, (_, i) => `127.0.0.${i + 1}:${port}`);

const LINE: HostileLineOptions = {
  sessionLimit: 64,
  overLimit: 'blackhole',
  baseDelayMs: 20,
  jitterMs: 20,
  listenAll: true,
};

interface Run {
  healthy: number;
  failures: number;
  log: string[];
}

/** Runs the shipped `irancell` profile against the line, blocking it for `blockMs` after 1 s. */
async function scanWithBlock(blockMs: number, recovery: boolean): Promise<Run> {
  const line = await startHostileLine(LINE);
  const scanner = new Scanner(dataDir);
  scanner.configure({
    ...DEFAULT_CONFIG,
    ...applyPreset('irancell'),
    port: line.port,
    sni: 'hostile.line',
    measureSpeed: false,
    // Parking on a dead line is a different defence (and tested on its own); here the question is
    // what happens to the addresses that were probed while the line refused them.
    autoPauseOnNetworkLoss: false,
    recoveryPass: recovery,
  });
  const block = setTimeout(() => line.drop(blockMs), 1000);
  try {
    await scanner.start({ targets: targetsFor(line.port), label: `block-${recovery}` });
  } finally {
    clearTimeout(block);
    await line.close();
  }
  return {
    healthy: scanner.getStats().healthy,
    failures: scanner.failures.length,
    log: scanner.logs.map((l) => l.text),
  };
}

test('a blocked window does not cost the addresses it covered', async () => {
  const without = await scanWithBlock(3000, false);
  const with_ = await scanWithBlock(3000, true);

  assert.ok(
    without.healthy < ADDRESSES,
    `the block must cost addresses without the recovery pass (found ${without.healthy}/${ADDRESSES})`,
  );
  assert.ok(without.failures >= 8, `and they are on the failure list (saw ${without.failures})`);

  assert.ok(
    with_.healthy > without.healthy,
    `the recovery pass must recover them (without ${without.healthy}, with ${with_.healthy})`,
  );
  assert.equal(with_.failures, 0, 'an address that was recovered is not a failure to explain any more');
  assert.ok(
    with_.log.some((line) => /retrying \d+ addresses the line turned away/.test(line)),
    'and the log says what it is doing',
  );
  assert.ok(
    with_.log.some((line) => /recovered \d+ addresses? the line had turned away/.test(line)),
    'including how many came back',
  );
});

test('a recovered address is judged on the attempt that worked', async () => {
  // The failures belonged to the line, not to the address, so the retry starts a fresh record:
  // merging them would report `loss 75%` for an address that is perfectly reachable, and a loss
  // gate — the strict one below — would then throw it out for the outage's crime.
  const line = await startHostileLine(LINE);
  const scanner = new Scanner(dataDir);
  scanner.configure({
    ...DEFAULT_CONFIG,
    ...applyPreset('irancell'),
    port: line.port,
    sni: 'hostile.line',
    measureSpeed: false,
    autoPauseOnNetworkLoss: false,
    recoveryPass: true,
    maxLossPct: 10,
  });
  const block = setTimeout(() => line.drop(3000), 1000);
  try {
    await scanner.start({ targets: targetsFor(line.port), label: 'fresh-record' });
  } finally {
    clearTimeout(block);
    await line.close();
  }

  const recovered = scanner.getResults('score').filter((r) => r.recovered);
  assert.ok(recovered.length >= 8, `addresses were recovered (saw ${recovered.length})`);
  const logged = Number(/recovered (\d+) addresses? the line had turned away/.exec(scanner.logs.map((l) => l.text).join('\n'))?.[1]);
  assert.equal(recovered.length, logged, 'and every one of them is flagged on the result');
  for (const r of recovered) {
    assert.equal(r.attempts, 1, `${r.ip} starts from a fresh record`);
    assert.equal(r.lossPct, 0, `${r.ip} keeps only the attempt that worked`);
    assert.ok(r.healthy, `${r.ip} is healthy despite the block (loss ${r.lossPct}%)`);
  }
});

test('an address that answered wrongly is not retried', async () => {
  // These addresses complete TLS and answer HTTP, then refuse the WebSocket upgrade. That is a
  // property of the address, not something the line did to it, so a retry would spend probes
  // proving the same thing again. The recovery pass only accepts the network's kinds
  // (timeout/reset/refused) and must sit this one out.
  const line = await startHostileLine({ ...LINE });
  const scanner = new Scanner(dataDir);
  scanner.configure({
    ...DEFAULT_CONFIG,
    mode: 'http',
    requireHttp: true,
    requireWs: true,
    tries: 1,
    minSuccesses: 1,
    workers: 6,
    timeoutMs: 800,
    minDelayMs: 0,
    rateLimitPerSec: 0,
    recoveryPass: true,
    autoPauseOnNetworkLoss: false,
    port: line.port,
    sni: 'hostile.line',
    measureSpeed: false,
  });
  try {
    await scanner.start({ targets: targetsFor(line.port), label: 'wrong-answer' });
  } finally {
    await line.close();
  }
  assert.equal(scanner.getStats().healthy, 0, 'an address that refuses the upgrade is not healthy');
  assert.ok(
    scanner.failures.some((f) => f.errorKinds?.ws),
    'and the failure is attributed to the upgrade, not to the line',
  );
  assert.ok(
    !scanner.logs.some((l) => l.text.startsWith('retrying')),
    'so the recovery pass spends no probes on it',
  );
});

test('spacing the retries is what gets an address through a rate cap', async () => {
  // Three attempts at one address are three sessions against a cap that counts sessions per
  // second across the whole scan. Sent back to back they land in one window and all fail; spaced
  // out they can each use a different window. Measured on the same line: 4/24 tight, 21/24 spaced.
  const run = async (betweenTriesMs: number): Promise<{ healthy: number; refused: number }> => {
    const line = await startHostileLine({
      sessionLimit: 64,
      maxNewSessionsPerSec: 4,
      overLimit: 'refuse',
      baseDelayMs: 20,
      listenAll: true,
    });
    const scanner = new Scanner(dataDir);
    scanner.configure({
      ...DEFAULT_CONFIG,
      mode: 'tls',
      requireHttp: false,
      tries: 3,
      minSuccesses: 1,
      workers: 4,
      minDelayMs: 0,
      rateLimitPerSec: 0,
      timeoutMs: 2000,
      maxLatencyMs: 100_000,
      maxLossPct: 100,
      minScore: 0,
      port: line.port,
      sni: 'hostile.line',
      measureSpeed: false,
      autoPauseOnNetworkLoss: false,
      recoveryPass: false,
      betweenTriesMs,
    } satisfies Partial<ScanConfig>);
    try {
      await scanner.start({ targets: targetsFor(line.port), label: `gap-${betweenTriesMs}` });
    } finally {
      await line.close();
    }
    return { healthy: scanner.getStats().healthy, refused: line.stats.refused };
  };

  const tight = await run(0);
  const spaced = await run(400);
  assert.ok(
    tight.healthy < ADDRESSES / 2,
    `back-to-back retries lose most of the list under a cap (found ${tight.healthy}/${ADDRESSES})`,
  );
  assert.ok(
    spaced.healthy >= tight.healthy * 2,
    `spacing them recovers most of it (tight ${tight.healthy}, spaced ${spaced.healthy})`,
  );
  assert.ok(
    spaced.refused < tight.refused,
    `and asks the line for fewer sessions (tight ${tight.refused}, spaced ${spaced.refused})`,
  );
});
