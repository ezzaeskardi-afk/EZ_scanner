import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { measureDownload, measureUpload, probeOnce } from '../src/core/probe.ts';
import { DEFAULT_CONFIG, type ScanConfig } from '../src/core/types.ts';
import { startFakeEdge, startFakeTcp, type FakeEdge } from './helpers/localnet.ts';

const base: ScanConfig = {
  ...DEFAULT_CONFIG,
  sni: '',
  mode: 'http',
  requireHttp: true,
  tries: 1,
  minSuccesses: 1,
  timeoutMs: 3000,
};

let edge: FakeEdge;
let wsEdge: FakeEdge;
let dyingEdge: FakeEdge;
let garbageEdge: FakeEdge;
let silentEdge: FakeEdge;
let closedPort = 0;

before(async () => {
  edge = await startFakeEdge({ status: 200 });
  wsEdge = await startFakeEdge({ websocket: true });
  dyingEdge = await startFakeEdge({ killAfterMs: 150 });
  garbageEdge = await startFakeEdge({ garbage: true });
  silentEdge = await startFakeEdge({ silent: true });
  const tmp = createServer();
  closedPort = await new Promise<number>((resolve) => {
    tmp.listen(0, '127.0.0.1', () => {
      const { port } = tmp.address() as AddressInfo;
      tmp.close(() => resolve(port));
    });
  });
});

after(async () => {
  await Promise.all([edge, wsEdge, dyingEdge, garbageEdge, silentEdge].map((s) => s.close()));
});

const controller = new AbortController();

test('http probe succeeds and reports status, colo and latency', async () => {
  const attempt = await probeOnce({ ip: '127.0.0.1', port: edge.port, sni: '' }, base, controller.signal);
  assert.equal(attempt.ok, true, attempt.errorMessage);
  assert.equal(attempt.httpStatus, 200);
  assert.equal(attempt.colo, 'FRA');
  assert.ok(attempt.latencyMs >= 0);
  assert.ok(edge.requests.some((r) => r.startsWith('GET /')));
});

test('tcp mode only needs the handshake', async () => {
  const server = await startFakeTcp();
  const attempt = await probeOnce({ ip: '127.0.0.1', port: server.port, sni: '' }, { ...base, mode: 'tcp' }, controller.signal);
  assert.equal(attempt.ok, true, attempt.errorMessage);
  await server.close();
});

test('closed port is reported as a failure, not a crash', async () => {
  const attempt = await probeOnce({ ip: '127.0.0.1', port: closedPort, sni: '' }, base, controller.signal);
  assert.equal(attempt.ok, false);
  assert.ok(['refused', 'timeout', 'other'].includes(attempt.error ?? ''));
});

test('silent edge (handshake then RST) is a failure', async () => {
  const attempt = await probeOnce({ ip: '127.0.0.1', port: silentEdge.port, sni: '' }, base, controller.signal);
  assert.equal(attempt.ok, false);
});

test('garbage payload fails the HTTP gate', async () => {
  const attempt = await probeOnce({ ip: '127.0.0.1', port: garbageEdge.port, sni: '' }, base, controller.signal);
  assert.equal(attempt.ok, false);
  assert.equal(attempt.error, 'http');
});

test('requireWs rejects a server without upgrades and accepts one with them', async () => {
  const bad = await probeOnce({ ip: '127.0.0.1', port: edge.port, sni: '' }, { ...base, requireWs: true }, controller.signal);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'ws');

  const good = await probeOnce({ ip: '127.0.0.1', port: wsEdge.port, sni: '' }, { ...base, requireWs: true }, controller.signal);
  assert.equal(good.ok, true, good.errorMessage);
  assert.equal(good.wsOk, true);
  assert.ok(wsEdge.requests.some((r) => r.startsWith('UPGRADE /')));
});

test('idle hold detects a connection killed while idle', async () => {
  const attempt = await probeOnce(
    { ip: '127.0.0.1', port: dyingEdge.port, sni: '' },
    { ...base, stabilityMs: 1200 },
    controller.signal,
  );
  assert.equal(attempt.ok, false);
  assert.equal(attempt.error, 'unstable');
  assert.equal(attempt.stable, false);
});

test('idle hold passes on a healthy server', async () => {
  const attempt = await probeOnce(
    { ip: '127.0.0.1', port: edge.port, sni: '' },
    { ...base, stabilityMs: 300 },
    controller.signal,
  );
  assert.equal(attempt.ok, true, attempt.errorMessage);
  assert.equal(attempt.stable, true);
});

test('download measurement reports throughput in Mbps', async () => {
  const server = await startFakeEdge({ downloadBytes: 400_000 });
  const result = await measureDownload(
    { ip: '127.0.0.1', port: server.port, sni: 'speed.example' },
    { ...base, speedBytes: 300_000, speedTimeoutMs: 8000 },
    controller.signal,
  );
  assert.equal(result.ok, true, result.error);
  assert.ok(result.bytes >= 300_000, `got ${result.bytes} bytes`);
  assert.ok(result.mbps > 1, `mbps=${result.mbps}`);
  await server.close();
});

test('upload measurement reports throughput', async () => {
  const result = await measureUpload(
    { ip: '127.0.0.1', port: edge.port, sni: 'speed.example' },
    { ...base, uploadBytes: 65_536, uploadUrl: `https://127.0.0.1:${edge.port}/__up`, speedTimeoutMs: 8000 },
    controller.signal,
  );
  assert.equal(result.ok, true, result.error);
  assert.ok(result.mbps > 0);
});

test('aborting mid-probe resolves instead of hanging', async () => {
  const aborter = new AbortController();
  const promise = probeOnce({ ip: '10.255.255.1', port: 443, sni: '' }, { ...base, timeoutMs: 8000 }, aborter.signal);
  setTimeout(() => aborter.abort(), 60);
  const attempt = await promise;
  assert.equal(attempt.ok, false);
});
