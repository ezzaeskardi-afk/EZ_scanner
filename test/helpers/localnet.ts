/**
 * Local HTTPS (+ optional WebSocket / slow / throttled) server for tests.
 * Uses a committed self-signed localhost certificate — tests only.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo, Socket } from 'node:net';

export interface FakeEdgeOptions {
  /** Reply to HTTP requests. */
  status?: number;
  /** Accept WebSocket upgrades with 101. */
  websocket?: boolean;
  /** Tear the socket down after N ms (simulates DPI killing idle sessions). */
  killAfterMs?: number;
  /** Bytes served for /__down. */
  downloadBytes?: number;
  /** Throttle the download to N bytes/sec. */
  downloadRate?: number;
  /**
   * Serve N bytes of the download and then reset the connection, with `Content-Length` still
   * promising all of it — a DPI/NAT box (or an MTU hole) reacting to *volume*, which is not the
   * same shape as `stallOverBytes` on the hostile line: there the stream goes quiet, here the
   * path tears it down and the client sees `ECONNRESET`.
   */
  cutDownloadAfterBytes?: number;
  /** How long to let the client read before the reset lands (default 120ms). */
  cutDelayMs?: number;
  /** Reply with a broken (non-HTTP) payload. */
  garbage?: boolean;
  /** Status the `/__up` endpoint answers with (default 200). */
  uploadStatus?: number;
  /** Close the socket immediately after the TLS handshake. */
  silent?: boolean;
}

export interface FakeEdge {
  port: number;
  url: string;
  requests: string[];
  close(): Promise<void>;
}

export function startFakeEdge(opts: FakeEdgeOptions = {}): Promise<FakeEdge> {
  const key = readFileSync(fileURLToPath(new URL('../fixtures/localhost-key.pem', import.meta.url)));
  const cert = readFileSync(fileURLToPath(new URL('../fixtures/localhost-cert.pem', import.meta.url)));
  const requests: string[] = [];

  /** Raw TCP sockets, so a cut can be a real RST (a TLS socket cannot send one). */
  const rawSockets = new Set<Socket>();

  const server = https.createServer({ key, cert }, (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (opts.garbage) {
      res.socket?.write('NOT-HTTP/9 999 nonsense\r\n\r\n');
      res.socket?.end();
      return;
    }
    if (opts.downloadBytes && req.url?.startsWith('/__down')) {
      const total = opts.downloadBytes;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(total) });
      const chunk = Buffer.alloc(16 * 1024, 0x41);
      let sent = 0;
      // The raw socket behind this request, found by its peer port: a `TLSSocket` cannot send a
      // RST itself, so the cut has to happen one layer down.
      const cut = (): void => {
        for (const socket of rawSockets) {
          if (socket.remotePort !== req.socket.remotePort) continue;
          if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
          else socket.destroy();
        }
      };
      const pump = () => {
        if (sent >= total) {
          res.end();
          return;
        }
        if (opts.cutDownloadAfterBytes && sent >= opts.cutDownloadAfterBytes) {
          // Delayed on purpose: a reset discards what the peer has not read yet on some stacks, and
          // the point of the test is a client that *received bytes* and then lost the stream.
          setTimeout(cut, opts.cutDelayMs ?? 120);
          return;
        }
        sent += chunk.length;
        res.write(chunk);
        if (opts.downloadRate) setTimeout(pump, (chunk.length / opts.downloadRate) * 1000);
        else setImmediate(pump);
      };
      pump();
      return;
    }
    if (req.url?.startsWith('/__up')) {
      let received = 0;
      req.on('data', (c: Buffer) => {
        received += c.length;
      });
      req.on('end', () => {
        res.writeHead(opts.uploadStatus ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received }));
      });
      return;
    }
    res.writeHead(opts.status ?? 200, { 'Content-Type': 'text/plain', 'cf-ray': '8f2a1b3c4d5e6f70-FRA' });
    res.end('ok');
  });

  server.on('connection', (socket) => {
    const raw = socket as Socket;
    rawSockets.add(raw);
    raw.on('close', () => rawSockets.delete(raw));
  });

  server.on('upgrade', (req, socket) => {
    requests.push(`UPGRADE ${req.url}`);
    if (!opts.websocket) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });

  if (opts.killAfterMs || opts.silent) {
    server.on('secureConnection', (socket) => {
      if (opts.silent) socket.destroy();
      else setTimeout(() => socket.destroy(), opts.killAfterMs);
    });
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        url: `https://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Plain TCP listener that accepts and forgets — used for `mode: tcp` tests. */
export function startFakeTcp(): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer(() => {});
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
