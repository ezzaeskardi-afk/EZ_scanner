import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DEFAULT_CANARIES } from '../src/core/ratelimit.ts';
import { Scanner } from '../src/core/scanner.ts';
import { createResult, finalize, finalizeAll, recordAttempt } from '../src/core/scoring.ts';
import { DEFAULT_CONFIG, type IpResult, type ScanConfig } from '../src/core/types.ts';
import { startFakeEdge, startFakeTcp, type FakeEdge } from './helpers/localnet.ts';

let edge: FakeEdge;
let dataDir: string;

before(async () => {
  edge = await startFakeEdge({ status: 200 });
  dataDir = await mkdtemp(join(tmpdir(), 'ez-scanner-test-'));
});

after(async () => {
  await edge.close();
  await rm(dataDir, { recursive: true, force: true });
});

function makeScanner(): Scanner {
  const scanner = new Scanner(dataDir);
  const config: ScanConfig = {
    ...DEFAULT_CONFIG,
    mode: 'http',
    requireHttp: true,
    sni: '',
    port: edge.port,
    tries: 2,
    minSuccesses: 1,
    timeoutMs: 3000,
    workers: 4,
    minScore: 0,
    maxLossPct: 100,
    autoPauseOnNetworkLoss: false,
    adaptiveBackoff: false,
    measureSpeed: false,
    // A small per-target delay keeps a scan slow enough to be paused/stopped
    // deterministically without relying on slow (timeout-bound) addresses.
    minDelayMs: 12,
  };
  scanner.configure(config);
  return scanner;
}

test('a scan probes the target list, keeps successes and finishes', async () => {
  const scanner = makeScanner();
  const events: string[] = [];
  const results: IpResult[] = [];
  scanner.on('log', () => events.push('log'));
  scanner.on('progress', () => events.push('progress'));
  scanner.on('result', (r) => results.push(r));

  await scanner.start({
    targets: [`127.0.0.1:${edge.port}`, `127.0.0.1:${edge.port}`, '127.0.0.1:1'],
    label: 'unit test',
  });

  assert.equal(scanner.getState(), 'done');
  const stats = scanner.getStats();
  assert.equal(stats.total, 3);
  assert.equal(stats.done, 3);
  assert.equal(stats.ok, 1, 'the duplicate address is merged');
  assert.equal(stats.failed, 1);
  assert.ok(Object.keys(stats.failuresByKind).length > 0, 'failure kinds are recorded');
  assert.equal(scanner.getFailures().samples.length, 1);
  assert.equal(stats.healthy, 1);
  assert.equal(scanner.results.size, 1);
  assert.ok(events.includes('log') && events.includes('progress'));

  const result = scanner.getResults('score')[0];
  assert.equal(result.healthy, true, result.reasons.join(','));
  assert.equal(result.httpStatus, 200);
  assert.equal(result.lossPct, 0);
  assert.ok(result.score > 50);
});

test('tcp mode does not demand the gates it never checks', async () => {
  // `--mode tcp` is exactly what the CLI recommends for a hostile line, and `requireHttp`
  // defaults to true. Scoring asked for an HTTP status the tcp probe never collects, so
  // every reachable address came back unhealthy: a real sweep of 30 Cloudflare edges (90 ms,
  // 0% loss) reported "30 reachable | 0 healthy", each row rejected as "HTTP check failed".
  const tcp = await startFakeTcp();
  try {
    const scanner = makeScanner();
    scanner.configure({ mode: 'tcp', requireHttp: true, requireWs: true, stabilityMs: 500, minDelayMs: 0 });
    await scanner.start({ targets: [`127.0.0.1:${tcp.port}`], label: 'tcp mode' });

    const stats = scanner.getStats();
    const result = scanner.getResults('score', { includeFailures: true })[0];
    assert.equal(
      stats.healthy,
      1,
      `a reachable address is healthy in tcp mode (reasons: ${result?.reasons.join(', ') ?? 'none'})`,
    );
    assert.equal(result.httpStatus, 0, 'no HTTP check ran, and the verdict does not imply one');
    assert.equal(result.wsOk, null, 'no WebSocket upgrade ran either');
  } finally {
    await tcp.close();
  }
});

test('failures are not silently marked healthy', async () => {
  const scanner = makeScanner();
  await scanner.start({ targets: ['127.0.0.1:1'], label: 'dead' });
  assert.equal(scanner.results.size, 0);
  assert.equal(scanner.getStats().healthy, 0);
});

test('strict gates reject an address the gentle config accepts', async () => {
  const scanner = makeScanner();
  scanner.configure({ requireWs: true });
  await scanner.start({ targets: [`127.0.0.1:${edge.port}`], label: 'strict' });
  const failures = scanner.getResults('score', { includeFailures: true });
  const result = failures[0];
  assert.ok(result, 'the failed address is kept as a sample');
  assert.equal(result.healthy, false);
  assert.ok(result.reasons.some((r) => /WebSocket/.test(r)), result.reasons.join(','));

  const lenient = makeScanner();
  await lenient.start({ targets: [`127.0.0.1:${edge.port}`], label: 'lenient' });
  assert.equal(lenient.getResults('score')[0].healthy, true);
});

test('pause then resume keeps the scan going', async () => {
  const scanner = makeScanner();
  // Long enough that the pause always lands mid-scan, even on a loaded machine.
  const targets = Array.from({ length: 400 }, () => `127.0.0.1:${edge.port}`);
  const finished = scanner.start({ targets, label: 'pause test' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    scanner.pause();
    assert.equal(scanner.getState(), 'paused');
    // In-flight probes are allowed to land, then the counter must freeze.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const settled = scanner.getStats().done;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(scanner.getStats().done, settled, 'nothing progresses while paused');
    assert.ok(settled < 400, 'the scan was still running when it was paused');
    scanner.resume();
    assert.equal(scanner.getState(), 'running');
  } finally {
    if (scanner.getState() === 'paused') scanner.resume();
    await finished;
  }
  assert.equal(scanner.getState(), 'done');
  assert.equal(scanner.getStats().done, 400);
});

test('stop aborts a long scan and still writes a resumable snapshot', async () => {
  const scanner = makeScanner();
  const targets = Array.from({ length: 400 }, () => `127.0.0.1:${edge.port}`);
  const done = scanner.start({ targets, label: 'stop test' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await scanner.stop();
  await done;
  assert.equal(scanner.getState(), 'stopped');

  const snapshot = JSON.parse(await readFile(join(dataDir, 'sessions', `${scanner.sessionId}.json`), 'utf8'));
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.targets.length, 400);
  assert.ok(snapshot.cursor > 0 && snapshot.cursor < 400, `cursor=${snapshot.cursor}`);
  assert.equal(snapshot.stats.phase, 'stopped');
});

test('a stop mid-probe neither fails nor consumes the addresses still in flight', async () => {
  const scanner = makeScanner();
  // 10.0.0.0/8 is unroutable here, so nothing finishes before the stop: every worker is
  // mid-probe when the abort lands (the case the old accounting got wrong).
  const targets = Array.from({ length: 300 }, (_v, i) => `10.0.${Math.floor(i / 250)}.${i % 250}:${edge.port}`);
  const done = scanner.start({ targets, label: 'inflight test' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await scanner.stop();
  await done;

  // An aborted probe used to be recorded as a failure (poisoning the failure breakdown and
  // the snapshot) while its index stayed consumed, so a resume skipped it for good.
  assert.equal(scanner.getStats().failed, 0, 'aborted probes are not failures');
  assert.deepEqual(scanner.getStats().failuresByKind, {}, 'an abort must not invent failure kinds');
  const snapshot = await scanner.loadSnapshot(scanner.sessionId);
  assert.equal(snapshot.cursor, 0, 'nothing was consumed, so a resume probes the whole list');
});

test('a session resumes from its cursor instead of starting over', async () => {
  const scanner = makeScanner();
  const targets = Array.from({ length: 400 }, () => `127.0.0.1:${edge.port}`);
  const done = scanner.start({ targets, label: 'resume test' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await scanner.stop();
  await done;

  const snapshot = await scanner.loadSnapshot(scanner.sessionId);
  assert.ok(snapshot.cursor > 0 && snapshot.cursor < targets.length, `cursor=${snapshot.cursor}`);

  const second = new Scanner(dataDir);
  // Throttled hard enough that the resumed run can be sampled while it works.
  second.configure({ ...scanner.config, minDelayMs: 0, rateLimitPerSec: 300, workers: 1 });
  const seen: number[] = [];
  const sampler = setInterval(() => seen.push(second.getStats().done), 2);
  await second.start({ resumeFrom: snapshot });
  clearInterval(sampler);

  assert.equal(second.getState(), 'done');
  assert.equal(second.getStats().total, targets.length);
  assert.ok(seen.length > 0, 'the resumed run was sampled');
  // The counter continues from the snapshot. It used to restart at 0, which reported a
  // 90 %-done session as 10 % done — and the progress bar, rate and ETA all followed it.
  assert.ok(
    Math.min(...seen) >= snapshot.cursor,
    `progress restarted at ${Math.min(...seen)} (cursor=${snapshot.cursor})`,
  );
  assert.equal(second.getStats().done, targets.length, 'every address is accounted for at the end');
  const sessions = await second.listSessions();
  assert.ok(sessions.some((s) => s.id === snapshot.id));
});

test('retest refreshes selected results in place', async () => {
  const scanner = makeScanner();
  await scanner.start({ targets: [`127.0.0.1:${edge.port}`], label: 'retest' });
  const key = `127.0.0.1:${edge.port}`;
  const before = scanner.results.get(key);
  assert.ok(before);
  before.score = 1;
  const updated = await scanner.retest([key], 'probe');
  assert.equal(updated.length, 1);
  assert.ok(scanner.results.get(key)!.score > 1);
});

test('a re-probe keeps the throughput the row already paid for', async () => {
  // A re-probe is the probe phase, not the speed phase: writing a fresh record over the row took
  // the row's throughput with it (a fresh record has none, and `finalize` scored it with the speed
  // term switched off), so pressing "Re-probe" emptied the Mbps column and *raised* the score of
  // the row it had just re-measured.
  const scanner = makeScanner();
  await scanner.start({ targets: [`127.0.0.1:${edge.port}`], label: 'reprobe' });
  const key = `127.0.0.1:${edge.port}`;
  const row = scanner.results.get(key)!;
  row.downMbps = 42.5;
  row.downTrust = 'measured';
  row.upMbps = 7.2;
  row.upTrust = 'measured';
  // A second address in the batch, so the speed term has a baseline that is not the row itself:
  // the row is scored against this, and scored against nobody, differently.
  const witness = createResult('198.51.100.7', 443, 'w.example');
  recordAttempt(witness, { ok: true, latencyMs: 100, httpStatus: 200, colo: 'FRA' });
  recordAttempt(witness, { ok: true, latencyMs: 105, httpStatus: 200, colo: 'FRA' });
  witness.downMbps = 100;
  witness.downTrust = 'measured';
  scanner.results.set('198.51.100.7:443', witness);
  finalizeAll([...scanner.results.values()], scanner.config);

  await scanner.retest([key], 'probe');

  assert.equal(row.downMbps, 42.5, 'the speed phase is not what was retested');
  assert.equal(row.downTrust, 'measured');
  assert.equal(row.upMbps, 7.2);
  assert.equal(row.upTrust, 'measured');
  assert.equal(row.healthy, true, 'the re-probe itself succeeded');
  // Scored alone the row is its own fastest download, so its speed term is full marks; scored in
  // the batch it is 42.5 of the witness's 100. The batch pass has to have run — the fresh record's
  // score was computed with no baseline at all.
  const alone = finalize({ ...row }, scanner.config, row.downMbps).score;
  assert.ok(
    row.score < alone,
    `the row must be scored against the batch's fastest trusted download (${alone} alone vs ${row.score} in the batch)`,
  );
});

test('network watchdog pauses nothing when disabled and reports state', async () => {
  const scanner = makeScanner();
  await scanner.start({ targets: [`127.0.0.1:${edge.port}`], label: 'watchdog' });
  const network = scanner.getNetwork();
  assert.equal(network.offline, false);
  assert.ok(network.lastCheckAt >= 0);
});

test('a configured canary reaches the running watchdog', async () => {
  const scanner = makeScanner();
  // The canary used to be frozen into the watchdog at construction time, so neither the
  // CLI flag nor the setting ever reached it.
  scanner.configure({ canaryHost: '127.0.0.1', canaryPort: edge.port, autoPauseOnNetworkLoss: true });
  const done = scanner.start({ targets: Array.from({ length: 60 }, () => `127.0.0.1:${edge.port}`), label: 'canary' });
  for (let i = 0; i < 50 && scanner.getNetwork().checks === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const network = scanner.getNetwork();
  assert.ok(network.checks > 0, 'the watchdog ran a check');
  assert.deepEqual(
    network.canaries,
    [`127.0.0.1:${edge.port}`, ...DEFAULT_CANARIES],
    'the configured canary is watched first, with the built-ins as the fallback',
  );
  assert.equal(network.offline, false, 'the local canary answered');
  await done;
});
