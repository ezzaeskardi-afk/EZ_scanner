/**
 * `tcpConnect` / `tlsConnect` cleanup tests.
 *
 * Where this comes from: `ezscan scan` on a short run printed its results and then sat there for
 * another ~4 seconds before the process actually exited (measured: 4.26s wall for a one-address
 * scan whose work took under 200ms). Two leaks did it, and both are asserted here because neither
 * shows up in the scan's own output:
 *
 *   1. a *failed* connect left its timeout armed — on success the timer was cleared, on every
 *      failure path (refused, reset, aborted) it stayed scheduled and held the event loop open for
 *      the rest of `timeoutMs`;
 *   2. the line watchdog armed a fresh interval timer after an `await` that `stop()` had already
 *      run through, which is covered in `ratelimit.test.ts` because it is the watchdog's own loop.
 *
 * The check is the number of armed timers before and after, which is what "the process can exit"
 * means in-process. A child process is spawned for the same reason from the outside, so the test
 * would fail even if the resource counters changed shape.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Socket } from 'node:net';
import { drainBytes, tcpConnect, tlsConnect } from '../src/core/net.ts';

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Armed timers right now — the resource that keeps a process from exiting. */
function armedTimers(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
}

async function settled(): Promise<void> {
  // One macrotask turn, so anything the connect left behind has had the chance to show up.
  await new Promise((resolve) => setTimeout(resolve, 5));
}

test('a refused connect leaves no timer behind', async () => {
  await settled();
  const before = armedTimers();
  await assert.rejects(() => tcpConnect('127.0.0.1', 1, { timeoutMs: 30_000 }), /ECONNREFUSED/);
  await settled();
  assert.equal(
    armedTimers(),
    before,
    'a failed connect must not keep its 30s timeout armed — that is what kept the CLI alive after the scan',
  );
});

test('an aborted connect leaves no timer behind', async () => {
  await settled();
  const before = armedTimers();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => tcpConnect('192.0.2.1', 443, { timeoutMs: 30_000, signal: controller.signal }));
  await settled();
  assert.equal(armedTimers(), before, 'an abandoned dial must clean up after itself');
});

test('a refused TLS handshake leaves no timer behind either', async () => {
  await settled();
  const before = armedTimers();
  await assert.rejects(() => tlsConnect('127.0.0.1', 1, { timeoutMs: 30_000, sni: 'example.com' }));
  await settled();
  assert.equal(armedTimers(), before);
});

test('a successful connect leaves no timer behind', async () => {
  const { createServer } = await import('node:net');
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await settled();
    const before = armedTimers();
    const conn = await tcpConnect('127.0.0.1', port, { timeoutMs: 30_000 });
    conn.socket.destroy();
    await settled();
    assert.equal(armedTimers(), before, 'the success path was always the one that cleared it');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('drainBytes names the way reading stopped', async () => {
  // `ended` was a single boolean for "not the deadline", which lumped a *finished* transfer and a
  // *cut* one together: the speed phase read the second as a measurement of whatever bytes had
  // made it (see `measureDownload`). The three ways a transfer can end are pinned here, because
  // the caller's verdict depends on telling them apart.
  const { createServer } = await import('node:net');
  const sockets: Socket[] = [];
  // The server's side of the connection, handed over as a promise: the client's `connect` can
  // resolve before this process runs the server's `connection` handler, so "the socket that just
  // arrived" is not addressable by position.
  let arrived: ((socket: Socket) => void) | null = null;
  const server = createServer((socket) => {
    sockets.push(socket);
    arrived?.(socket);
    arrived = null;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const open = async (): Promise<{ client: Socket; server: Socket }> => {
    const accepted = new Promise<Socket>((resolve) => {
      arrived = resolve;
    });
    const conn = await tcpConnect('127.0.0.1', port, { timeoutMs: 5000 });
    sockets.push(conn.socket);
    return { client: conn.socket, server: await accepted };
  };
  try {
    const complete = await open();
    complete.server.write(Buffer.alloc(64, 0x41));
    const drained = await drainBytes(complete.client, 64, 3000);
    assert.equal(drained.endedBy, 'target');
    assert.equal(drained.ended, true);
    assert.equal(drained.bytes, 64);

    const short = await open();
    short.server.write(Buffer.alloc(16, 0x41));
    short.server.end();
    const closed = await drainBytes(short.client, 64, 3000);
    assert.equal(closed.endedBy, 'close', 'a peer that sends less and hangs up is an ended transfer');
    assert.equal(closed.ended, true);

    const cut = await open();
    cut.server.write(Buffer.alloc(16, 0x41));
    setTimeout(() => cut.server.resetAndDestroy(), 60);
    const broken = await drainBytes(cut.client, 64, 3000);
    assert.equal(broken.endedBy, 'error', `a reset is a cut, not a finished transfer (${broken.error ?? 'no message'})`);
    assert.equal(broken.ended, false);
    assert.ok(broken.error, 'the socket message is kept so the reason can be shown');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a process that only opens a failing connection exits at once', async () => {
  // The same claim from outside: a 30s timeout that outlives its connection would hold this child
  // open for 30 seconds. The bound is loose because this measures a process, not a schedule.
  const script =
    `import { tcpConnect } from ${JSON.stringify(new URL('../src/core/net.ts', import.meta.url).href)};\n` +
    'try { await tcpConnect("127.0.0.1", 1, { timeoutMs: 30_000 }); } catch {}\n';
  const started = Date.now();
  await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, timeout: 20_000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `the child took ${elapsed}ms to exit after one refused connection`);
});
