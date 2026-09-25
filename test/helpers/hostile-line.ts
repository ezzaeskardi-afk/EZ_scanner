/**
 * A fake upstream that behaves like the access network the scanner usually meets.
 *
 * The probes are cheap on localhost, so "everything is red on my line" cannot be
 * reproduced with the ordinary fake edge (`helpers/localnet.ts`). This one models the three
 * things that actually hurt, and it counts what happened so a test can *prove* behaviour
 * instead of asserting on timing luck:
 *
 *   - **A session table with a hard limit** (CGNAT on Irancell/IR-MCI, the ONU's conntrack
 *     table on fiber). Above the limit a connection is reset (a real RST, what a full NAT
 *     table sends) or black-holed — and, as on a real line, an operator-style `outageMs`
 *     drops the whole line for a while, which is the "the connection dies and the router
 *     needs a restart" symptom of issues #25/#62/#96.
 *   - **A cap on new sessions per second** (`maxNewSessionsPerSec`): the per-subscriber rate
 *     a CGNAT slot enforces, and what a cheap ONU's CPU actually dies of. This is the one
 *     that turns a burst into timeouts on a line that is otherwise healthy (#56, #75) —
 *     the table only fills under sustained load, the rate cap trips on the first second.
 *   - **Delay and jitter** on every response, so "the timeout is tighter than the line" can
 *     be reproduced deliberately rather than by waiting for a bad day.
 *   - **An MTU/MSS blackhole**: the response headers and the first bytes arrive, the rest
 *     never does — the PPPoE/PMTU pathology where TLS is fine and a large transfer stalls.
 *
 * What it counts is split on purpose: the session table's own view (`stats` — an accept until the
 * line reaps it, which is what a real conntrack table would show) and the caller's (`client` — the
 * sockets it had open at once, see `client-sockets.ts` for why that is the one a *worker budget*
 * belongs on, and why the two numbers differ).
 *
 * Everything is loopback-only. Bind to all interfaces (`listenAll`) when one fake line has
 * to stand in for many addresses (`127.0.0.1`, `127.0.0.2`, …).
 */
import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { watchClientSockets, type ClientSockets } from './client-sockets.ts';

export interface HostileLineOptions {
  /** Concurrent connections the session table holds; going past it is what hurts. */
  sessionLimit: number;
  /** What happens above the limit: a reset, or a socket that accepts and never answers. */
  overLimit?: 'refuse' | 'blackhole';
  /** Set to drop the whole line (every live session) for this long when the limit is hit. */
  outageMs?: number;
  /**
   * New sessions per second the access network will open (the CGNAT rate cap, and what a
   * cheap ONU's CPU actually dies of). Past it a session is turned away the same way an
   * over-limit one is — this is the mechanism that makes a mobile line time out while it
   * is otherwise fine (`IR-MCI`/`Irancell` in docs/ISSUES.md #56/#58/#75).
   */
  maxNewSessionsPerSec?: number;
  /** Share of accepted sessions reset immediately (a real RST), as a DPI/NAT box does. */
  resetRate?: number;
  /** Fixed delay added to every response. */
  baseDelayMs?: number;
  /** Extra random delay (0..jitterMs) added to every response. */
  jitterMs?: number;
  /** Stop writing a `/__down` response after this many bytes and never finish it. */
  stallOverBytes?: number;
  /** Bind to all interfaces so `127.0.0.2`, `127.0.0.3`, … reach the same line. */
  listenAll?: boolean;
  /** Status for ordinary requests. */
  status?: number;
}

interface HostileLineStats {
  /** Sessions the line accepted (it had room in the table). */
  accepted: number;
  /** Sessions turned away: over the limit, or while the line was down. */
  refused: number;
  /** Sessions turned away by `maxNewSessionsPerSec` — the operator's rate cap, not the table. */
  rateLimited: number;
  /**
   * Most sessions the line held at once. A session is counted from `accept` until the line has
   * reaped it (`close`), and reaping lags the client by a loopback round-trip — so this counter
   * *leads* the client's own concurrency, and by more than one when the client dials faster than
   * the loopback reaps. Measured, not theoretical: a strictly serial caller (concurrency 1 by
   * construction) reads a peak of 2 here, and the retry churn in `hostile-line.test.ts` drifts
   * further. Use it for what a real conntrack table sees — "did the table fill up?" — and assert
   * a *worker budget* on `HostileLine.client`, which counts the caller's own sockets.
   */
  peakConcurrent: number;
  live: number;
  /** Times the whole line was dropped. */
  outages: number;
  /** Sessions killed by `resetRate`. */
  resets: number;
  /** Responses that were black-holed part-way through. */
  stalls: number;
  requests: number;
  servedBytes: number;
}

export interface HostileLine {
  port: number;
  /** Counters for the *whole* life of the listener; call `resetStats()` between runs. */
  stats: HostileLineStats;
  /**
   * The same sessions, counted on the caller's side of the wire: how many sockets it had open at
   * once, which is exact and cannot lag (see `client-sockets.ts`). `stats.peakConcurrent` answers
   * "did the session table fill up?"; this answers "how wide did the caller run?", which is the
   * question a worker budget asks.
   */
  client: ClientSockets;
  /** Drops the line now for `ms`: every live session dies and new ones are turned away. */
  drop(ms: number): void;
  isDead(): boolean;
  resetStats(): void;
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function startHostileLine(opts: HostileLineOptions): Promise<HostileLine> {
  const key = readFileSync(fileURLToPath(new URL('../fixtures/localhost-key.pem', import.meta.url)));
  const cert = readFileSync(fileURLToPath(new URL('../fixtures/localhost-cert.pem', import.meta.url)));

  const stats: HostileLineStats = {
    accepted: 0,
    refused: 0,
    rateLimited: 0,
    peakConcurrent: 0,
    live: 0,
    outages: 0,
    resets: 0,
    stalls: 0,
    requests: 0,
    servedBytes: 0,
  };
  /** Accepted sessions — the ones the session table is holding. */
  const live = new Set<Socket>();
  /** Every socket, so `close()` cannot leave a paused one behind. */
  const sockets = new Set<Socket>();
  let deadUntil = 0;
  /** Timestamps of the sessions opened in the last second, for the rate cap. */
  let openedAt: number[] = [];

  /**
   * A reset, not a polite FIN. `resetAndDestroy` is what makes the client see
   * `ECONNRESET` ("the path is killing connections") instead of a clean close, which is
   * the difference between a NAT table refusing a session and a host hanging up.
   */
  const reset = (socket: Socket): void => {
    if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
    else socket.destroy();
  };

  /**
   * A session that is accepted and then never answered: the socket stays open, so a client that
   * waits burns its whole timeout instead of failing fast — the shape of a full CGNAT slot or a
   * saturated ONU.
   *
   * What this can and cannot reproduce on loopback is worth knowing before writing an assertion
   * against it. `tls.Server` reads at the handle level, so `pause()` does not stall the TLS
   * layer, and there is no RTT here: the ClientHello and the request arrive together, so by the
   * time any handler runs the request is already buffered and the session *is* answered. A
   * black hole is therefore only faithful for a client that waits without sending (a `tcp`-mode
   * probe hangs up before it could notice either way) — the counters below are what such a
   * session is asserted on. When a test needs the *client* to observe a turned-away session,
   * use `overLimit: 'refuse'`: a real RST is reproducible here.
   */
  const blackhole = (socket: Socket): void => {
    socket.pause();
    socket.on('resume', () => socket.pause());
  };

  const drop = (ms: number): void => {
    deadUntil = Math.max(deadUntil, Date.now() + ms);
    stats.outages += 1;
    for (const socket of sockets) reset(socket);
    live.clear();
    stats.live = 0;
  };

  const server = https.createServer({ key, cert }, (req, res) => {
    stats.requests += 1;
    const delay = (opts.baseDelayMs ?? 0) + (opts.jitterMs ? Math.random() * opts.jitterMs : 0);
    const url = new URL(req.url ?? '/', 'https://hostile.line');

    const respond = (): void => {
      if (res.destroyed) return;
      if (url.pathname.startsWith('/__down')) {
        const requested = Number(url.searchParams.get('bytes')) || 1_000_000;
        const stallAt = opts.stallOverBytes && requested > opts.stallOverBytes ? opts.stallOverBytes : 0;
        // Content-Length still promises the whole thing: that is exactly why the client
        // waits instead of failing fast. This is the blackhole signature.
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(requested) });
        const chunk = Buffer.alloc(16 * 1024, 0x41);
        let sent = 0;
        const pump = (): void => {
          if (res.destroyed) return;
          if (stallAt && sent >= stallAt) {
            stats.stalls += 1;
            return; // …and nothing ever finishes this response.
          }
          if (sent >= requested) {
            res.end();
            return;
          }
          const size = Math.min(stallAt ? Math.min(chunk.length, stallAt - sent) : chunk.length, requested - sent);
          res.write(chunk.subarray(0, size));
          sent += size;
          stats.servedBytes += size;
          setImmediate(pump);
        };
        pump();
        return;
      }
      res.writeHead(opts.status ?? 200, { 'Content-Type': 'text/plain', 'cf-ray': '8f2a1b3c4d5e6f70-FRA' });
      res.end('ok');
    };

    if (delay > 0) setTimeout(respond, delay);
    else respond();
  });

  // `tls.Server` types its 'connection' event as a bare Duplex, but it hands over the raw
  // TCP socket — the one that has to be counted, paused and reset.
  server.on('connection', (socket) => {
    const raw = socket as Socket;
    sockets.add(raw);
    raw.on('close', () => {
      sockets.delete(raw);
      live.delete(raw);
      stats.live = live.size;
    });
    if (Date.now() < deadUntil) {
      stats.refused += 1;
      reset(raw);
      return;
    }
    if (opts.maxNewSessionsPerSec) {
      const now = Date.now();
      openedAt = openedAt.filter((at) => now - at < 1000);
      if (openedAt.length >= opts.maxNewSessionsPerSec) {
        stats.rateLimited += 1;
        stats.refused += 1;
        if (opts.overLimit === 'blackhole') blackhole(raw); // the SYN is accepted and forgotten
        else reset(raw);
        return;
      }
      openedAt.push(now);
    }
    if (live.size >= opts.sessionLimit) {
      stats.refused += 1;
      if (opts.outageMs) drop(opts.outageMs);
      else if (opts.overLimit === 'blackhole') blackhole(raw); // accepted by the kernel, never read
      else reset(raw);
      return;
    }
    // A share of sessions killed outright — the DPI/NAT reset a mobile line lives with.
    // It has to happen on the raw socket: a TLSSocket's handle cannot be sent as a RST.
    if (opts.resetRate && Math.random() < opts.resetRate) {
      stats.resets += 1;
      reset(raw);
      return;
    }
    live.add(raw);
    stats.live = live.size;
    stats.accepted += 1;
    stats.peakConcurrent = Math.max(stats.peakConcurrent, live.size);
  });


  return new Promise((resolve) => {
    server.listen(0, opts.listenAll ? '0.0.0.0' : '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      // From here on, every socket the caller opens to this port is counted on its own side.
      const client = watchClientSockets(port);
      resolve({
        port,
        stats,
        client,
        drop,
        isDead: () => Date.now() < deadUntil,
        resetStats: () => {
          for (const key of Object.keys(stats) as Array<keyof HostileLineStats>) {
            stats[key] = 0;
          }
          stats.live = live.size;
          stats.peakConcurrent = live.size;
          client.reset();
        },
        close: () =>
          new Promise<void>((done) => {
            client.stop();
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            live.clear();
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Waits until the simulated line is back, so a test never races a simulated outage. */
export async function waitUntilLineUp(line: HostileLine, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (line.isDead() && Date.now() < deadline) await sleep(50);
  if (line.isDead()) throw new Error('the simulated line never came back');
}
