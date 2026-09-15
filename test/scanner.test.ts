import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Scanner } from '../src/core/scanner.ts';
import { DEFAULT_CONFIG, type IpResult, type ScanConfig } from '../src/core/types.ts';
import { startFakeEdge, type FakeEdge } from './helpers/localnet.ts';

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
  const targets = Array.from({ length: 300 }, (_v, i) => `10.0.${Math.floor(i / 250)}.${i % 250}:${edge.port}`);
  const done = scanner.start({ targets, label: 'stop test' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await scanner.stop();
  await done;
  assert.equal(scanner.getState(), 'stopped');

  const snapshot = JSON.parse(await readFile(join(dataDir, 'sessions', `${scanner.sessionId}.json`), 'utf8'));
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.targets.length, 300);
  assert.ok(snapshot.cursor > 0 && snapshot.cursor < 300, `cursor=${snapshot.cursor}`);
  assert.equal(snapshot.stats.phase, 'stopped');
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
  second.configure({ ...scanner.config, minDelayMs: 0 });
  await second.start({ resumeFrom: snapshot });
  assert.equal(second.getState(), 'done');
  assert.equal(second.getStats().total, targets.length);
  assert.equal(second.getStats().done, targets.length - snapshot.cursor, 'only the remaining addresses were probed');
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

test('network watchdog pauses nothing when disabled and reports state', async () => {
  const scanner = makeScanner();
  await scanner.start({ targets: [`127.0.0.1:${edge.port}`], label: 'watchdog' });
  const network = scanner.getNetwork();
  assert.equal(network.offline, false);
  assert.ok(network.lastCheckAt >= 0);
});
