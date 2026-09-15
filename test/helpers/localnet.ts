/**
 * Local HTTPS (+ optional WebSocket / slow / throttled) server for tests.
 * Uses a committed self-signed localhost certificate — tests only.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

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
  /** Reply with a broken (non-HTTP) payload. */
  garbage?: boolean;
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
      const pump = () => {
        if (sent >= total) {
          res.end();
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received }));
      });
      return;
    }
    res.writeHead(opts.status ?? 200, { 'Content-Type': 'text/plain', 'cf-ray': '8f2a1b3c4d5e6f70-FRA' });
    res.end('ok');
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
