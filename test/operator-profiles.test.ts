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
 * Note what 24 addresses can and cannot show: the burst is *visible* to the access network
 * (sessions turned away, and on fiber the table tripping), but at this size a retry usually
 * rescues the address. Losing addresses at scale is what the bigger burst in
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

const ADDRESSES = 24;
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
};

const PROFILES: OperatorProfile[] = [
  {
    name: 'Irancell',
    preset: 'irancell',
    signature: 'mobile CGNAT: a per-subscriber session slot and a hard cap on new sessions/second (#56, #75)',
    line: {
      sessionLimit: 128,
      // Dialled down so a 24-address test burst reaches a cap a real per-subscriber one would
      // only meet under a much bigger scan: the ratio is what the test needs.
      maxNewSessionsPerSec: 20,
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
      maxNewSessionsPerSec: 15,
      overLimit: 'refuse', // a real RST: the probe reports `reset`
      baseDelayMs: 50,
      jitterMs: 90,
      resetRate: 0.3,
      listenAll: true,
    },
  },
  {
    name: 'MobinNet fiber (PPPoE ONU)',
    preset: 'mobin',
    signature:
      'a cheap ONU behind PPPoE: a small table, a weak CPU, and the whole home goes down when it is filled (#25, #96)',
    line: {
      // A cheap ONU's table, dialled down to what a 24-address burst can fill in a test.
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
    mode: 'tcp',
    requireHttp: false,
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
    assert.ok((preset!.workers ?? 0) <= 24, 'an operator preset stays well inside a home ONU budget');
    assert.ok((preset!.rateLimitPerSec ?? 0) > 0, 'and it caps the session rate: workers alone cannot');

    const brutal = await run(profile, BRUTAL);
    const safe = await run(profile, preset!);
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
