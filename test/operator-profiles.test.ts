/**
 * Operator profiles: the same severe test, run against the three access networks this tool is
 * written for.
 *
 * A real line cannot be put in CI, but its *mechanism* can: the harness models the session
 * table (CGNAT / the ONU's conntrack table), the operator's cap on new sessions per second,
 * DPI resets, jitter and an MTU blackhole. Each profile names one network's signature and
 * then asks the only two questions that matter:
 *
 *   1. does the brutal profile break that network? (it has to, or the profile is wrong)
 *   2. does the preset the product ships for it get through untouched?
 *
 * The second run is driven by `applyPreset()`, not by local constants, so the numbers printed
 * here — and asserted below — are the numbers a user gets from `--preset irancell|mci|mobin`.
 * Change a preset and this test is what tells you whether that network can still take it.
 *
 * Why the list is longer than the table it is meant to trip: a scan's opening second is the
 * expensive one, and the token bucket starts full, so a preset that declares 12/s still opens
 * ~2x that (a burst of 12, then the refill) before it settles. The line caps here are sized
 * above that honest opening rate, so "the preset stays clean" is a claim with headroom rather
 * than luck; the burst above it is 4x the preset's worker count, which is the shape that
 * actually gets a subscriber throttled.
 *
 * Note what a list this size can and cannot show: the burst is *visible* to the access network
 * (sessions turned away, and on fiber the table tripping), and the preset keeps all of it. That
 * an over-driven line also *loses addresses* at scale is what the bigger burst in
 * `hostile-line.test.ts` demonstrates.
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
  dataDir = await mkdtemp(join(tmpdir(), 'ez-scanner-operators-'));
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const ADDRESSES = 40;
const targetsFor = (port: number) => Array.from({ length: ADDRESSES }, (_, i) => `127.0.0.${i + 1}:${port}`);

interface OperatorProfile {
  name: string;
  /** What this network does, in one line, with the issue numbers it answers for. */
  signature: string;
  /** The shipped preset for it (`--preset <name>`). */
  preset: string;
  line: HostileLineOptions;
  /** Only this network's signature includes DPI resets, so only here is one expected. */
  expectsResets?: boolean;
}

/**
 * The brutal profile is the shape of scan that makes an operator — or a home ONU — react: as
 * many sessions as it can open, as fast as it can open them, no pause, no back-off.
 */
const BRUTAL: Partial<ScanConfig> = {
  workers: 200,
  tries: 2,
  minDelayMs: 0,
  rateLimitPerSec: 0,
  adaptiveBackoff: false,
  // The burst is about what the network sees in the opening second; waiting 6s for a
  // black-holed session proves nothing extra and would triple the test's runtime.
  timeoutMs: 1200,
};

/**
 * Sessions have to be *held* for a session table or a rate cap to see a burst, so both runs
 * below are driven in `http` mode even though the shipped presets are handshake-only.
 *
 * This is not a detail: a `tcp` probe hangs up the moment it connects, and on Linux those
 * sockets are gone before the server gets a turn to accept them — the same 200-worker burst
 * that fills a table on Windows showed a peak of **2** sessions there, and the test that
 * asserted "the network must react" failed for a reason that had nothing to do with the
 * network. Holding each session until the (delayed) response arrives makes the burst visible
 * on every platform. It is also the harsher case, since a tcp-mode session lives for
 * milliseconds — which is part of why the operator presets are handshake-only.
 */
const HELD: Partial<ScanConfig> = { mode: 'http', requireHttp: true };

const PROFILES: OperatorProfile[] = [
  {
    name: 'Irancell',
    preset: 'irancell',
    signature: 'mobile CGNAT: a per-subscriber session slot and a hard cap on new sessions/second (#56, #75)',
    line: {
      sessionLimit: 128,
      // Sized above the opening second a shipped preset produces (~2x its declared rate,
      // because the bucket starts full) and far below what 200 workers fire at once.
      maxNewSessionsPerSec: 32,
      overLimit: 'blackhole', // the SYN is accepted and forgotten: the probe sees a timeout
      baseDelayMs: 60,
      jitterMs: 120,
      resetRate: 0.1,
      listenAll: true,
    },
  },
  {
    name: 'MCI / Hamrah-e Aval',
    preset: 'mci',
    expectsResets: true,
    signature: 'mobile CGNAT with DPI resets on a burst (#58, #62)',
    line: {
      sessionLimit: 96,
      maxNewSessionsPerSec: 32,
      overLimit: 'refuse', // a real RST: the probe reports `reset`
      baseDelayMs: 50,
      jitterMs: 90,
      // Moderate DPI: heavy enough that a retry storm shows up as `reset`, light enough that
      // three tries still recover nearly every address.
      resetRate: 0.15,
      listenAll: true,
    },
  },
  {
    name: 'MobinNet fiber (PPPoE ONU)',
    preset: 'mobin',
    signature:
      'a cheap ONU behind PPPoE: a small table, a weak CPU, and the whole home goes down when it is filled (#25, #96)',
    line: {
      // A cheap ONU's table, dialled down to what a held-session burst fills in a test. The
      // preset's 12 workers have to sit under it — that is the documented rule for fiber.
      sessionLimit: 16,
      outageMs: 2500, // filling the table drops every session and turns new ones away
      maxNewSessionsPerSec: 40,
      baseDelayMs: 100,
      jitterMs: 40,
      stallOverBytes: 60_000, // the MTU/MSS hole a PPPoE line with broken PMTUD shows
      listenAll: true,
    },
  },
];

interface Run {
  healthy: number;
  elapsed: number;
  line: { peakConcurrent: number; refused: number; rateLimited: number; outages: number; resets: number; stalls: number };
  failures: Record<string, number>;
}

async function run(profile: OperatorProfile, config: Partial<ScanConfig>): Promise<Run> {
  const line = await startHostileLine(profile.line);
  const scanner = new Scanner(dataDir);
  scanner.configure({
    ...DEFAULT_CONFIG,
    ...HELD,
    sni: '',
    port: line.port,
    minSuccesses: 1,
    timeoutMs: 3000,
    minScore: 0,
    maxLossPct: 100,
    measureSpeed: false,
    // Parking on a dropped line is tested on its own; here the question is what the traffic
    // profile does to the network.
    autoPauseOnNetworkLoss: false,
    ...config,
  });
  const started = Date.now();
  await scanner.start({ targets: targetsFor(line.port), label: `${profile.name} ${config.workers}w` });
  const { peakConcurrent, refused, rateLimited, outages, resets, stalls } = line.stats;
  await line.close();
  return {
    healthy: scanner.getStats().healthy,
    elapsed: Date.now() - started,
    line: { peakConcurrent, refused, rateLimited, outages, resets, stalls },
    failures: scanner.getStats().failuresByKind,
  };
}

for (const profile of PROFILES) {
  test(`${profile.name}: the brutal profile breaks it, --preset ${profile.preset} gets through`, async () => {
    const preset = applyPreset(profile.preset);
    assert.ok(preset, `--preset ${profile.preset} must exist`);
    assert.ok((preset!.workers ?? 0) <= ADDRESSES / 3, 'an operator preset stays well inside a home ONU budget');
    assert.ok((preset!.rateLimitPerSec ?? 0) > 0, 'and it caps the session rate: workers alone cannot');
    assert.equal(preset!.mode, 'tcp', 'the shipped preset is handshake-only, the kindest mode for a session table');

    const brutal = await run(profile, BRUTAL);
    // The preset's own numbers (workers/rate/delay/tries), deliberately driven in the held
    // mode: handshake-only sessions barely exist, so `tcp` would flatter the preset right past
    // the table it has to respect. `assert.equal(preset!.mode, 'tcp')` below keeps the shipped
    // mode on record.
    const safe = await run(profile, { ...preset!, ...HELD });
    const report = (label: string, r: Run) =>
      `${label}: found ${r.healthy}/${ADDRESSES} · peak ${r.line.peakConcurrent} sessions · ` +
      `${r.line.refused} turned away (${r.line.rateLimited} by the rate cap) · ${r.line.outages} outages · ` +
      `${r.line.resets} resets · ${r.elapsed}ms · failures ${JSON.stringify(r.failures)}`;

    // What the network sees, printed as the evidence behind the preset.
    console.log(`\n${profile.name} — ${profile.signature}\n  ${report('brutal  ', brutal)}\n  ${report(`--preset ${profile.preset}`, safe)}`);

    // 1. The network really does react to the burst — otherwise this profile proves nothing.
    assert.ok(
      brutal.line.rateLimited + brutal.line.refused > 0 || brutal.line.outages > 0,
      `${profile.name} must react to the burst (peak ${brutal.line.peakConcurrent} sessions)`,
    );

    // 2. The shipped preset is within the network's budget and still finds the list.
    assert.equal(safe.line.outages, 0, `${profile.name}: the preset must never trip the line`);
    assert.equal(safe.line.rateLimited, 0, `${profile.name}: it must stay under the operator's rate cap`);
    assert.ok(
      safe.line.peakConcurrent <= preset!.workers!,
      `${profile.name}: peak ${safe.line.peakConcurrent} sessions must stay inside the preset's ${preset!.workers} workers`,
    );
    assert.ok(
      safe.healthy >= Math.ceil(ADDRESSES * 0.9),
      `${profile.name}: the preset must find the line (found ${safe.healthy}/${ADDRESSES}, ${JSON.stringify(safe.failures)})`,
    );
    assert.ok(brutal.healthy <= safe.healthy, 'the burst cannot find more than the calm sweep');

    // 3. The signature failure is attributed, not swallowed as a vague error.
    if (profile.expectsResets) {
      assert.ok(brutal.line.resets + safe.line.resets > 0, 'the network really did reset sessions');
      const kinds = new Set([...Object.keys(brutal.failures), ...Object.keys(safe.failures)]);
      assert.ok(!kinds.has('other'), `a reset is never attributed to "other" (saw ${[...kinds].join(', ')})`);
    }
  });
}
