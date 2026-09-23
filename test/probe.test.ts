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

test('a refused handshake is attributed to TLS, not to "other"', async () => {
  // OpenSSL errors arrive with no `code` at all, so the text is the only clue: a real sweep of 60
  // edges reported `other: 81` for what was entirely a wrong/missing SNI. A plain-text server is
  // the same shape from the client's side (the record header is not TLS).
  const plain = await startFakeTcp();
  try {
    const attempt = await probeOnce(
      { ip: '127.0.0.1', port: plain.port, sni: 'hostile.line' },
      { ...base, mode: 'tls', requireHttp: false },
      controller.signal,
    );
    assert.equal(attempt.ok, false);
    assert.equal(attempt.error, 'tls', `saw ${attempt.error}: ${attempt.errorMessage}`);
  } finally {
    await plain.close();
  }
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
  assert.equal(result.trust, 'measured', 'the payload arrived, so the rate is a real one');
  assert.equal(result.ok, result.trust === 'measured', 'the verdict and the boolean are one fact');
  assert.equal(result.targetBytes, 300_000);
  assert.ok(result.bytes >= 300_000, `got ${result.bytes} bytes`);
  assert.ok(result.mbps > 1, `mbps=${result.mbps}`);
  await server.close();
});

test('a transfer our own deadline ended is still a measurement', async () => {
  // The other side of `partial`: here the stream is still delivering when the window closes, so
  // the stop is ours and the rate describes the path. Without this the fix for a cut transfer
  // could be "doubt every transfer that did not finish", which would throw away exactly the
  // numbers a slow line produces.
  const server = await startFakeEdge({ downloadBytes: 400_000, downloadRate: 50_000 });
  try {
    const result = await measureDownload(
      { ip: '127.0.0.1', port: server.port, sni: 'speed.example' },
      { ...base, speedBytes: 300_000, speedTimeoutMs: 600 },
      controller.signal,
    );
    assert.equal(result.trust, 'measured', `a live stream cut by the deadline (${result.error ?? ''})`);
    assert.ok(result.mbps > 0, `mbps=${result.mbps}`);
    assert.ok(result.bytes < 300_000, `and the payload never finished (${result.bytes} bytes)`);
    assert.ok((result.idleMs ?? 0) < 1500, 'the stream was still moving when the deadline hit');
  } finally {
    await server.close();
  }
});

test('an endpoint that ends the stream early is not a throughput number either', async () => {
  // The polite half of the same shape as a reset: a gateway that stops sending at its byte cap and
  // closes *cleanly* — a rate limit on the endpoint, a proxy in the path, a DPI box reacting to
  // volume without a RST. `drainBytes` calls that `close`, which is also how a completed transfer
  // ends, so 64 KB of a requested 300 KB used to be reported as a finished download: the *best*
  // looking number in the scan, because the first congestion window is where a transfer is fastest.
  const server = await startFakeEdge({ downloadBytes: 64_000 });
  try {
    const result = await measureDownload(
      { ip: '127.0.0.1', port: server.port, sni: 'speed.example' },
      { ...base, speedBytes: 300_000, speedTimeoutMs: 8000 },
      controller.signal,
    );
    assert.equal(result.ok, false, `a short transfer must not be a measurement (mbps=${result.mbps})`);
    // Checked before the verdict is narrowed, because the two views are one fact.
    assert.equal(result.ok, result.trust === 'measured', 'the verdict and the boolean are one fact');
    assert.equal(result.trust, 'partial', 'the endpoint ended it — not the path, and not us');
    assert.equal(result.mbps, 0, 'no throughput may be derived from a fraction of the payload');
    assert.equal(result.targetBytes, 300_000);
    assert.ok(result.bytes > 0 && result.bytes < 300_000, `the bytes that did arrive (${result.bytes})`);
    assert.match(result.error ?? '', /after \d+ bytes of 300000 requested \(\d+%\)/);
  } finally {
    await server.close();
  }
});

test('an error page is not a download: the status decides', async () => {
  // A Cloudflare edge that does not serve the speed host answers `403 error code: 1034`
  // with a small HTML body. Counting those bytes used to produce a *green* transfer on a
  // real line ("0.69 Mbps over 8271 bytes"), and that number ranked every address in the
  // speed phase — the phase the scan exists for.
  const server = await startFakeEdge({ status: 403 });
  try {
    const result = await measureDownload(
      { ip: '127.0.0.1', port: server.port, sni: 'speed.example' },
      { ...base, speedBytes: 300_000, speedTimeoutMs: 2000 },
      controller.signal,
    );
    assert.equal(result.ok, false, `a 403 must not be a measurement (mbps=${result.mbps})`);
    assert.equal(result.error, 'HTTP 403');
    assert.equal(result.trust, 'rejected', 'the endpoint answered, but not with a transfer');
    assert.equal(result.mbps, 0, 'no throughput may be derived from an error page');
  } finally {
    await server.close();
  }
});

test('a transfer the path cuts is not a throughput number', async () => {
  // `drainBytes` reported "reading stopped before the deadline", which is a *cut* stream and a
  // *slow* one at once, so a socket error mid-transfer was counted like a finished download: the
  // endpoint promised 400 KB, the path reset after 64 KB, and those 64 KB became an Mbps number
  // that then ranked addresses in the speed phase. Only the quiet half of that shape (a stall) was
  // caught before, and the loud half is what a DPI/NAT box does when it reacts to volume.
  const server = await startFakeEdge({ downloadBytes: 400_000, cutDownloadAfterBytes: 64_000 });
  try {
    const result = await measureDownload(
      { ip: '127.0.0.1', port: server.port, sni: 'speed.example' },
      { ...base, speedBytes: 300_000, speedTimeoutMs: 8000 },
      controller.signal,
    );
    assert.equal(result.ok, false, `a cut transfer must not be a measurement (mbps=${result.mbps})`);
    assert.equal(result.mbps, 0, 'no throughput may be derived from a transfer that never arrived');
    assert.equal(result.trust, 'cut', 'and the reason has to be nameable, not just "failed"');
    assert.ok(result.bytes > 0 && result.bytes < 300_000, `the partial bytes stay for the message (${result.bytes})`);
    assert.match(result.error ?? '', /cut after \d+ bytes/);
  } finally {
    await server.close();
  }
});

test('an upload the endpoint rejects is not throughput either', async () => {
  const server = await startFakeEdge({ uploadStatus: 503 });
  try {
    const result = await measureUpload(
      { ip: '127.0.0.1', port: server.port, sni: 'speed.example' },
      { ...base, uploadBytes: 65_536, uploadUrl: `https://127.0.0.1:${server.port}/__up`, speedTimeoutMs: 4000 },
      controller.signal,
    );
    assert.equal(result.ok, false, `a 503 must not be a measurement (mbps=${result.mbps})`);
    assert.equal(result.error, 'HTTP 503');
    assert.equal(result.ok, result.trust === 'measured');
    assert.equal(result.trust, 'rejected');
  } finally {
    await server.close();
  }
});

test('upload measurement reports throughput', async () => {
  const result = await measureUpload(
    { ip: '127.0.0.1', port: edge.port, sni: 'speed.example' },
    { ...base, uploadBytes: 65_536, uploadUrl: `https://127.0.0.1:${edge.port}/__up`, speedTimeoutMs: 8000 },
    controller.signal,
  );
  assert.equal(result.ok, true, result.error);
  assert.equal(result.trust, 'measured');
  assert.ok(result.mbps > 0);
});

test("a stopped measurement is not the path's verdict", async () => {
  // `drainBytes` reports `abort` when the scan is stopped, and reading that as a cut would stamp
  // "the path cut this transfer" onto a row because the *user* pressed Ctrl-C.
  const server = await startFakeEdge({ downloadBytes: 8_000_000, downloadRate: 100_000 });
  const aborter = new AbortController();
  try {
    const promise = measureDownload(
      { ip: '127.0.0.1', port: server.port, sni: 'speed.example' },
      {
        ...base,
        speedBytes: 8_000_000,
        speedTimeoutMs: 8000,
        speedUrl: `https://127.0.0.1:${server.port}/__down?bytes=%BYTES%`,
      },
      aborter.signal,
    );
    setTimeout(() => aborter.abort(), 40);
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.trust, 'untested', `nothing was learned about this path (${result.error ?? ''})`);
    assert.equal(result.mbps, 0);
  } finally {
    await server.close();
  }
});

test('a speed URL that is not a URL is not a measurement of this path', async () => {
  // The URL used to be resolved with a `catch` that fell back to Cloudflare's own endpoint, so
  // `--speed-url "https://"` (or any value the sanitizer's `/^https?:\/\//` test let through but the
  // URL parser refused) quietly measured a host the user never named — with that host as the SNI,
  // since the SNI is derived from the URL. The row has to say what happened instead, and it must not
  // be a `cut`: nothing about this address was measured, and a cut is a verdict *about the path*.
  const asked = edge.requests.length;
  const down = await measureDownload(
    { ip: '127.0.0.1', port: edge.port, sni: 'speed.example' },
    { ...base, speedUrl: 'https://', speedBytes: 100_000, speedTimeoutMs: 1000 },
    controller.signal,
  );
  assert.equal(down.ok, false);
  assert.equal(down.trust, 'rejected', `saw ${down.trust}: ${down.error}`);
  assert.match(down.error ?? '', /not a URL/);
  assert.equal(edge.requests.length, asked, 'no request was sent to the endpoint at all');
});

test('an upload URL that is not a URL is not the path cutting a transfer', async () => {
  const up = await measureUpload(
    { ip: '127.0.0.1', port: edge.port, sni: 'speed.example' },
    { ...base, uploadUrl: 'https://', speedTimeoutMs: 1000 },
    controller.signal,
  );
  assert.equal(up.trust, 'rejected', `a config typo must not be filed as a path verdict (${up.error})`);
  assert.match(up.error ?? '', /upload URL is not a URL/);
});

test('an endpoint that will not speak TLS is not a mid-transfer cut', async () => {
  // The transport is wrong, not the path: a port that answers but cannot complete a handshake (the
  // wrong SNI, or a listener that is not TLS) fails the same way for every address on the line, so
  // it takes the same verdict an error page takes — `rejected`, which neither ranks nor penalises.
  // Reading it as `cut` sent the user to `--speed-bytes` after a DPI box that was never there.
  const plain = await startFakeTcp();
  try {
    const down = await measureDownload(
      { ip: '127.0.0.1', port: plain.port, sni: 'speed.example' },
      { ...base, speedBytes: 100_000, speedTimeoutMs: 2000, timeoutMs: 1500 },
      controller.signal,
    );
    assert.equal(down.ok, false);
    assert.equal(down.trust, 'rejected', `saw ${down.trust}: ${down.error}`);
    assert.equal(down.mbps, 0);
  } finally {
    await plain.close();
  }
});

test('aborting mid-probe resolves instead of hanging', async () => {
  const aborter = new AbortController();
  const promise = probeOnce({ ip: '10.255.255.1', port: 443, sni: '' }, { ...base, timeoutMs: 8000 }, aborter.signal);
  setTimeout(() => aborter.abort(), 60);
  const attempt = await promise;
  assert.equal(attempt.ok, false);
});
